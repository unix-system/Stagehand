//! Tails the newest Studio log file (created after launch) to stderr, for `--studio-log`.

use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime},
};

pub struct LogTail {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn newest_log(dir: &Path, since: SystemTime) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if modified < since {
            continue;
        }
        if best.as_ref().map_or(true, |(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}

impl LogTail {
    /// Poll `dir` for the newest `*.log` modified after `since` and stream appended bytes to stderr.
    pub fn start(dir: PathBuf, since: SystemTime) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            let mut current: Option<(PathBuf, u64)> = None;
            let mut buf = Vec::with_capacity(64 * 1024);
            let stderr = std::io::stderr();
            while !flag.load(Ordering::Relaxed) {
                if let Some(newest) = newest_log(&dir, since) {
                    if current.as_ref().map_or(true, |(p, _)| *p != newest) {
                        let _ = writeln!(stderr.lock(), "[studio-log] following {}", newest.display());
                        current = Some((newest, 0));
                    }
                }
                if let Some((path, offset)) = current.as_mut() {
                    if let Ok(mut f) = fs::File::open(&*path) {
                        if f.seek(SeekFrom::Start(*offset)).is_ok() {
                            buf.clear();
                            if let Ok(n) = f.read_to_end(&mut buf) {
                                if n > 0 {
                                    let mut err = stderr.lock();
                                    for line in String::from_utf8_lossy(&buf).lines() {
                                        let _ = writeln!(err, "[studio-log] {line}");
                                    }
                                    *offset += n as u64;
                                }
                            }
                        }
                    }
                }
                thread::sleep(Duration::from_millis(250));
            }
        });
        Self { stop, thread: Some(thread) }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
