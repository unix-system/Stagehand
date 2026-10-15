//! Pure path helpers (no processes), so they can be unit tested anywhere.

use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const STUDIO_EXE: &str = "RobloxStudioBeta.exe";

/// Wine maps `/` to the `Z:` drive. Same rule as Vinegar's `dirs.Windows`.
pub fn z_drive(p: &Path) -> String {
    format!("Z:{}", p.to_string_lossy().replace('/', "\\"))
}

/// `wine cmd /c echo ...` output ends with CRLF and may carry stray whitespace.
pub fn trim_cmd_output(s: &str) -> String {
    s.trim_matches(|c: char| c == '\r' || c == '\n' || c == ' ' || c == '\t').to_string()
}

/// Where Studio deployments are looked for when `--studio-dir` is not given:
/// `$XDG_DATA_HOME/stagehand-studio/versions`, then Vinegar's `versions` directory.
pub fn candidate_version_roots() -> Vec<PathBuf> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("STAGEHAND_STUDIO_HOME") {
        roots.push(PathBuf::from(home).join("versions"));
    }
    if let Some(d) = data_home {
        roots.push(d.join("stagehand-studio/versions"));
        roots.push(d.join("vinegar/versions"));
    }
    roots
}

/// The most recently modified child directory (across all roots) that contains the Studio exe.
pub fn newest_studio_dir(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else { continue };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.join(STUDIO_EXE).is_file() {
                continue;
            }
            let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            if best.as_ref().map_or(true, |(t, _)| mtime > *t) {
                best = Some((mtime, dir));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Fallback for `%LOCALAPPDATA%` when `wine` cannot be asked: the first non-Public user under
/// `drive_c/users` that has an `AppData/Local` directory.
pub fn scan_drive_c_local_appdata(prefix: &Path) -> Option<PathBuf> {
    let users = prefix.join("drive_c/users");
    let mut names: Vec<_> = fs::read_dir(&users).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
        .into_iter()
        .filter(|n| n != "Public")
        .map(|n| users.join(n).join("AppData/Local"))
        .find(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn z_drive_paths() {
        assert_eq!(z_drive(Path::new("/home/u/a b.rbxl")), r"Z:\home\u\a b.rbxl");
    }

    #[test]
    fn trims_cmd_output() {
        assert_eq!(trim_cmd_output("C:\\users\\x\\AppData\\Local\r\n"), "C:\\users\\x\\AppData\\Local");
    }

    #[test]
    fn picks_newest_dir_with_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("versions");
        let old = root.join("version-old");
        let new = root.join("version-new");
        let no_exe = root.join("version-broken");
        for d in [&old, &new, &no_exe] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(old.join(STUDIO_EXE), b"x").unwrap();
        thread::sleep(Duration::from_millis(20));
        fs::write(new.join(STUDIO_EXE), b"x").unwrap();
        // touch `new` so its mtime is strictly newer on coarse filesystems
        let now = SystemTime::now();
        let f = fs::File::open(&new).unwrap();
        f.set_modified(now).unwrap();
        fs::File::open(&old).unwrap().set_modified(now - Duration::from_secs(60)).unwrap();
        assert_eq!(newest_studio_dir(&[root.clone()]), Some(new));
        assert_eq!(newest_studio_dir(&[tmp.path().join("missing")]), None);
    }

    #[test]
    fn scans_drive_c_skipping_public() {
        let tmp = tempfile::tempdir().unwrap();
        let prefix = tmp.path();
        fs::create_dir_all(prefix.join("drive_c/users/Public/AppData/Local")).unwrap();
        fs::create_dir_all(prefix.join("drive_c/users/root/AppData/Local")).unwrap();
        assert_eq!(scan_drive_c_local_appdata(prefix), Some(prefix.join("drive_c/users/root/AppData/Local")));
        assert_eq!(scan_drive_c_local_appdata(&prefix.join("nope")), None);
    }
}
