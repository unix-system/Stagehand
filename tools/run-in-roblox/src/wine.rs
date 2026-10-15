//! Linux backend: Roblox Studio (the 64-bit Windows build) running under Wine.
//!
//! The Studio deployment directory is laid out like Vinegar's `versions/<guid>/` and the plugins
//! folder is `%LOCALAPPDATA%\Roblox\Plugins` inside the prefix. `%LOCALAPPDATA%` is asked from Wine
//! itself because prefixes may redirect it (Vinegar does, via `User Shell Folders`).
#![cfg(unix)]

use std::{
    fs::{self, File},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context};

use crate::{
    paths,
    studio::{StudioBackend, StudioProcess},
    Options,
};

pub struct WineBackend {
    wine: PathBuf,
    prefix: Option<PathBuf>,
    studio_dir: PathBuf,
    plugins_dir_override: Option<PathBuf>,
    kill_wineserver: bool,
}

impl WineBackend {
    pub fn from_options(o: &Options) -> anyhow::Result<Self> {
        let studio_dir = match &o.studio_dir {
            Some(d) => d.clone(),
            None => paths::newest_studio_dir(&paths::candidate_version_roots()).ok_or_else(|| {
                anyhow!(
                    "no Roblox Studio deployment found; pass --studio-dir (or STAGEHAND_STUDIO_DIR) pointing at the directory containing {}",
                    paths::STUDIO_EXE
                )
            })?,
        };
        if !studio_dir.join(paths::STUDIO_EXE).is_file() {
            bail!("{} has no {}", studio_dir.display(), paths::STUDIO_EXE);
        }
        Ok(Self {
            wine: o.wine.clone(),
            prefix: o.wineprefix.clone(),
            studio_dir,
            plugins_dir_override: o.plugins_dir.clone(),
            kill_wineserver: o.kill_wineserver,
        })
    }

    fn wine_cmd(&self, program: &str) -> Command {
        let mut cmd = Command::new(&self.wine);
        cmd.arg(program);
        if let Some(p) = &self.prefix {
            cmd.env("WINEPREFIX", p);
        }
        if std::env::var_os("WINEDEBUG").is_none() {
            cmd.env("WINEDEBUG", "-all");
        }
        cmd
    }

    fn wine_stdout(&self, program: &str, args: &[&str]) -> anyhow::Result<String> {
        let out = self
            .wine_cmd(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .with_context(|| format!("failed to run {} {program}", self.wine.display()))?;
        if !out.status.success() {
            bail!("{program} {} exited with {}", args.join(" "), out.status);
        }
        Ok(paths::trim_cmd_output(&String::from_utf8_lossy(&out.stdout)))
    }

    /// Windows path for a host path (`winepath -w`), falling back to the `Z:` drive mapping.
    pub fn winpath_w(&self, p: &Path) -> String {
        let abs = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        match self.wine_stdout("winepath", &["-w", &abs.to_string_lossy()]) {
            Ok(s) if !s.is_empty() => s,
            _ => paths::z_drive(&abs),
        }
    }

    fn local_appdata(&self) -> anyhow::Result<PathBuf> {
        let win = self.wine_stdout("cmd", &["/c", "echo", "%LOCALAPPDATA%"]).ok().filter(|s| !s.is_empty() && !s.contains('%'));
        if let Some(win) = win {
            if let Ok(unix) = self.wine_stdout("winepath", &["-u", &win]) {
                let p = PathBuf::from(unix);
                if p.is_dir() || fs::create_dir_all(&p).is_ok() {
                    return Ok(p);
                }
            }
        }
        let prefix = self
            .prefix
            .clone()
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".wine")))
            .ok_or_else(|| anyhow!("cannot determine the Wine prefix"))?;
        paths::scan_drive_c_local_appdata(&prefix)
            .ok_or_else(|| anyhow!("could not resolve %LOCALAPPDATA% in prefix {}", prefix.display()))
    }
}

impl StudioBackend for WineBackend {
    fn describe(&self) -> String {
        format!(
            "Studio at {} via {}{}",
            self.studio_dir.display(),
            self.wine.display(),
            self.prefix.as_ref().map(|p| format!(" (WINEPREFIX={})", p.display())).unwrap_or_default()
        )
    }

    fn plugins_dir(&self) -> anyhow::Result<PathBuf> {
        let dir = match &self.plugins_dir_override {
            Some(d) => d.clone(),
            None => self.local_appdata()?.join("Roblox/Plugins"),
        };
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        Ok(dir)
    }

    fn logs_dir(&self) -> Option<PathBuf> {
        self.local_appdata().ok().map(|p| p.join("Roblox/logs"))
    }

    fn launch(&self, place: &Path, log: &Path) -> anyhow::Result<StudioProcess> {
        let out = File::create(log).with_context(|| format!("creating {}", log.display()))?;
        let err = out.try_clone()?;
        let winplace = self.winpath_w(place);
        let exe = self.studio_dir.join(paths::STUDIO_EXE);
        let mut cmd = self.wine_cmd(&exe.to_string_lossy());
        cmd.args(["-task", "EditFile", "-localPlaceFile", &winplace])
            .current_dir(&self.studio_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .process_group(0);
        let child = cmd.spawn().with_context(|| format!("failed to start {} {}", self.wine.display(), exe.display()))?;
        let pgid = child.id() as i32;
        Ok(StudioProcess { child, pgid: Some(pgid) })
    }

    fn kill(&self, p: &mut StudioProcess) {
        if let Ok(Some(_)) = p.child.try_wait() {
            // already gone; still make sure the group is clean below
        }
        if let Some(pgid) = p.pgid {
            // SAFETY: plain libc call on a pgid we created with process_group(0).
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = p.child.try_wait() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        } else {
            let _ = p.child.kill();
        }
        let _ = p.child.wait();
        if self.kill_wineserver {
            let ws = self.wine.parent().map(|d| d.join("wineserver")).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("wineserver"));
            let mut cmd = Command::new(ws);
            cmd.arg("-k");
            if let Some(p) = &self.prefix {
                cmd.env("WINEPREFIX", p);
            }
            let _ = cmd.status();
        }
    }
}
