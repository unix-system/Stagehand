//! Backend abstraction: how to find Studio's plugins folder, launch Studio on a place, and kill it.

use std::{
    path::{Path, PathBuf},
    process::Child,
};

pub struct StudioProcess {
    pub child: Child,
    /// Unix process group id when the child was started in its own group.
    pub pgid: Option<i32>,
}

pub trait StudioBackend {
    fn describe(&self) -> String;
    /// Studio's local plugins folder (created if missing).
    fn plugins_dir(&self) -> anyhow::Result<PathBuf>;
    /// Where Studio writes its `*.log` files, if known.
    fn logs_dir(&self) -> Option<PathBuf>;
    /// Launch Studio editing `place`; the process's stdout/stderr go to `log`.
    fn launch(&self, place: &Path, log: &Path) -> anyhow::Result<StudioProcess>;
    /// Best-effort, idempotent termination of the Studio process (tree).
    fn kill(&self, p: &mut StudioProcess);
}

/// Pick the backend for this platform: Windows/macOS use the native Studio install,
/// everything else goes through Wine.
pub fn select_backend(opts: &crate::Options) -> anyhow::Result<Box<dyn StudioBackend>> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        if !opts.force_wine {
            return Ok(Box::new(crate::native::NativeBackend::locate()?));
        }
    }
    #[cfg(unix)]
    {
        return Ok(Box::new(crate::wine::WineBackend::from_options(opts)?));
    }
    #[allow(unreachable_code)]
    anyhow::bail!("no Studio backend for this platform")
}
