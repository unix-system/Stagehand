//! Upstream behaviour: a native Roblox Studio install on Windows or macOS, located with the
//! `roblox_install` crate.
#![cfg(any(windows, target_os = "macos"))]

use std::{
    fs::File,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::Context;
use roblox_install::RobloxStudio;

use crate::studio::{StudioBackend, StudioProcess};

pub struct NativeBackend {
    install: RobloxStudio,
}

impl NativeBackend {
    pub fn locate() -> anyhow::Result<Self> {
        let install = RobloxStudio::locate().context("Could not locate a Roblox Studio installation.")?;
        Ok(Self { install })
    }
}

impl StudioBackend for NativeBackend {
    fn describe(&self) -> String {
        format!("native Studio at {}", self.install.application_path().display())
    }

    fn plugins_dir(&self) -> anyhow::Result<PathBuf> {
        let dir = self.install.plugins_path().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    fn logs_dir(&self) -> Option<PathBuf> {
        None
    }

    fn launch(&self, place: &Path, log: &Path) -> anyhow::Result<StudioProcess> {
        let out = File::create(log)?;
        let err = out.try_clone()?;
        let child = Command::new(self.install.application_path())
            .arg(place)
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .context("failed to start Roblox Studio")?;
        Ok(StudioProcess { child, pgid: None })
    }

    fn kill(&self, p: &mut StudioProcess) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}
