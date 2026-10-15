//! run-in-roblox (Stagehand fork): run a Lua script inside Roblox Studio, or hold Studio open with
//! extra plugins installed so another tool (the Stagehand daemon) can drive it. Linux is supported
//! through Wine; Windows and macOS keep the upstream native behaviour.

mod logtail;
mod native;
mod paths;
mod plugin;
mod server;
mod studio;
mod wine;

use std::{
    fs,
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime},
};

use anyhow::{bail, Context};
use clap::Parser;

use server::{Message, MessageReceiver, OutputLevel, RobloxMessage};
use studio::StudioProcess;

pub const EXIT_OK: u8 = 0;
pub const EXIT_SCRIPT_ERROR: u8 = 1;
pub const EXIT_SETUP: u8 = 2;
pub const EXIT_STUDIO_DIED: u8 = 3;
pub const EXIT_TIMEOUT: u8 = 124;

#[derive(Parser, Debug)]
#[command(name = "run-in-roblox", version, about, long_about = None)]
pub struct Options {
    /// Place file to open (.rbxl / .rbxlx). Copied to a temp dir so Studio never sees a .lock.
    #[arg(long)]
    pub place: PathBuf,

    /// Lua script to run inside Studio (plugin security). Required unless --hold is given.
    #[arg(long, required_unless_present = "hold", conflicts_with = "hold")]
    pub script: Option<PathBuf>,

    /// Keep Studio open (with any --plugin files installed) until SIGINT/SIGTERM or --timeout.
    #[arg(long)]
    pub hold: bool,

    /// Whole-run timeout in seconds (exit 124 when exceeded).
    #[arg(long, default_value_t = 600)]
    pub timeout: u64,

    /// Seconds to wait for Studio to load the plugin and call back (/start).
    #[arg(long, default_value_t = 180)]
    pub connect_timeout: u64,

    /// Port for the localhost message server.
    #[arg(long, default_value_t = 50312)]
    pub port: u16,

    /// Extra plugin files (.rbxm/.rbxmx) to install into Studio's plugins folder for this run.
    #[arg(long = "plugin")]
    pub plugins: Vec<PathBuf>,

    /// Tail the newest Studio log file to stderr.
    #[arg(long)]
    pub studio_log: bool,

    /// Exit hold mode when stdin reaches EOF (off by default so `nohup ... &` works).
    #[arg(long)]
    pub stdin_eof: bool,

    /// Where to write Wine's/Studio's stdout+stderr (default: a file in the run's temp dir).
    #[arg(long)]
    pub wine_log: Option<PathBuf>,

    /// Wine binary (Linux backend).
    #[arg(long, env = "RUN_IN_ROBLOX_WINE", default_value = "wine")]
    pub wine: PathBuf,

    /// Wine prefix (Linux backend).
    #[arg(long, env = "WINEPREFIX")]
    pub wineprefix: Option<PathBuf>,

    /// Directory containing RobloxStudioBeta.exe (Linux backend; auto-detected otherwise).
    #[arg(long, env = "STAGEHAND_STUDIO_DIR")]
    pub studio_dir: Option<PathBuf>,

    /// Override Studio's plugins folder.
    #[arg(long)]
    pub plugins_dir: Option<PathBuf>,

    /// Also run `wineserver -k` after killing Studio (Linux backend).
    #[arg(long)]
    pub kill_wineserver: bool,

    /// Use the Wine backend even on Windows/macOS (testing aid).
    #[arg(long, hide = true)]
    pub force_wine: bool,
}

/// Files to delete when the run ends, whatever happens.
struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = fs::remove_file(p);
        }
    }
}

fn eprint_flush(s: &str) {
    let _ = writeln!(io::stderr(), "{s}");
}

fn print_output(messages: &[RobloxMessage]) -> bool {
    let mut saw_error = false;
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for m in messages {
        let RobloxMessage::Output { level, body } = m;
        if *level == OutputLevel::Error {
            saw_error = true;
        }
        let _ = writeln!(out, "{}{}", level.tag(), body);
    }
    let _ = out.flush();
    saw_error
}

enum Tick {
    Deadline,
    StudioExited(Option<i32>),
    Continue,
}

fn tick(child: &mut StudioProcess, deadline: Instant) -> Tick {
    if let Ok(Some(status)) = child.child.try_wait() {
        return Tick::StudioExited(status.code());
    }
    if Instant::now() >= deadline {
        return Tick::Deadline;
    }
    Tick::Continue
}

fn run(o: &Options) -> anyhow::Result<u8> {
    let backend = studio::select_backend(o)?;
    eprint_flush(&format!("run-in-roblox: {}", backend.describe()));
    let plugins_dir = backend.plugins_dir()?;

    let ext = o
        .place
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| anyhow::anyhow!("place {} has no file extension", o.place.display()))?;
    if !o.place.is_file() {
        bail!("place {} does not exist", o.place.display());
    }
    let tmp = tempfile::tempdir().context("creating temp dir")?;
    let place = tmp.path().join(format!("run-in-roblox-place.{ext}"));
    fs::copy(&o.place, &place).with_context(|| format!("copying {}", o.place.display()))?;

    let script = match &o.script {
        Some(p) => fs::read_to_string(p).with_context(|| format!("reading script {}", p.display()))?,
        None => "-- hold".to_string(),
    };
    for extra in &o.plugins {
        if !extra.is_file() {
            bail!("--plugin {} does not exist", extra.display());
        }
    }

    let server_id = format!("run-in-roblox-{:x}", rand::random::<u128>());
    let receiver = MessageReceiver::start(o.port, server_id.clone())?;
    eprint_flush(&format!("run-in-roblox: message server on http://127.0.0.1:{}", receiver.port()));

    let mut cleanup = Cleanup(Vec::new());
    let relay_path = plugins_dir.join(format!("run_in_roblox-{}.rbxmx", o.port));
    fs::write(&relay_path, plugin::render_plugin_rbxmx(o.port, &server_id, &script, o.hold))
        .with_context(|| format!("writing {}", relay_path.display()))?;
    cleanup.0.push(relay_path.clone());
    for (i, extra) in o.plugins.iter().enumerate() {
        let name = extra.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("plugin{i}.rbxm"));
        let dest = plugins_dir.join(format!("run_in_roblox-extra-{i}-{name}"));
        fs::copy(extra, &dest).with_context(|| format!("installing {}", extra.display()))?;
        cleanup.0.push(dest);
    }
    eprint_flush(&format!("run-in-roblox: plugins installed in {}", plugins_dir.display()));

    let wine_log = o.wine_log.clone().unwrap_or_else(|| tmp.path().join("wine.log"));
    let started_at = SystemTime::now();
    let mut child = backend.launch(&place, &wine_log)?;
    eprint_flush(&format!("run-in-roblox: Studio started (pid {}), process log {}", child.child.id(), wine_log.display()));
    let tail = if o.studio_log {
        backend.logs_dir().map(|d| logtail::LogTail::start(d, started_at))
    } else {
        None
    };

    let deadline = Instant::now() + Duration::from_secs(o.timeout);
    let connect_deadline = Instant::now() + Duration::from_secs(o.connect_timeout);
    let code = (|| -> anyhow::Result<u8> {
        // 1. wait for /start
        loop {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Some(Message::Start) => break,
                Some(Message::Messages(m)) => {
                    print_output(&m);
                }
                Some(Message::Stop) => {}
                None => {}
            }
            match tick(&mut child, deadline.min(connect_deadline)) {
                Tick::StudioExited(code) => {
                    eprint_flush(&format!("run-in-roblox: Studio exited ({code:?}) before the plugin connected; see {}", wine_log.display()));
                    return Ok(EXIT_STUDIO_DIED);
                }
                Tick::Deadline => {
                    eprint_flush("run-in-roblox: timeout reached while waiting for Roblox Studio to come online");
                    return Ok(if Instant::now() >= deadline { EXIT_TIMEOUT } else { EXIT_STUDIO_DIED });
                }
                Tick::Continue => {}
            }
        }
        eprint_flush("run-in-roblox: Studio plugin connected");

        if o.hold {
            println!("READY");
            let _ = io::stdout().flush();
            let (tx, rx) = mpsc::channel::<&'static str>();
            let sig_tx = tx.clone();
            ctrlc::set_handler(move || {
                let _ = sig_tx.send("signal");
            })
            .context("installing signal handler")?;
            if o.stdin_eof {
                let eof_tx = tx.clone();
                thread::spawn(move || {
                    let mut sink = [0u8; 1024];
                    let mut stdin = io::stdin();
                    while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
                    let _ = eof_tx.send("stdin EOF");
                });
            }
            loop {
                if let Ok(reason) = rx.try_recv() {
                    eprint_flush(&format!("run-in-roblox: ending hold ({reason})"));
                    return Ok(EXIT_OK);
                }
                if let Some(Message::Messages(m)) = receiver.recv_timeout(Duration::from_millis(500)) {
                    print_output(&m);
                }
                match tick(&mut child, deadline) {
                    Tick::StudioExited(code) => {
                        eprint_flush(&format!("run-in-roblox: Studio exited ({code:?}) during hold"));
                        return Ok(EXIT_STUDIO_DIED);
                    }
                    Tick::Deadline => {
                        eprint_flush("run-in-roblox: --timeout reached in hold mode");
                        return Ok(EXIT_TIMEOUT);
                    }
                    Tick::Continue => {}
                }
            }
        }

        // 2. script mode: stream output until /stop
        let mut saw_error = false;
        loop {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Some(Message::Messages(m)) => saw_error |= print_output(&m),
                Some(Message::Stop) => break,
                Some(Message::Start) | None => {}
            }
            match tick(&mut child, deadline) {
                Tick::StudioExited(code) => {
                    eprint_flush(&format!("run-in-roblox: Studio exited ({code:?}) before the script finished"));
                    return Ok(EXIT_STUDIO_DIED);
                }
                Tick::Deadline => {
                    eprint_flush("run-in-roblox: --timeout reached before the script finished");
                    return Ok(EXIT_TIMEOUT);
                }
                Tick::Continue => {}
            }
        }
        Ok(if saw_error { EXIT_SCRIPT_ERROR } else { EXIT_OK })
    })();

    backend.kill(&mut child);
    if let Some(t) = tail {
        t.stop();
    }
    drop(cleanup);
    receiver.stop();
    code
}

fn main() -> ExitCode {
    let o = Options::parse();
    match run(&o) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprint_flush(&format!("run-in-roblox: error: {e:#}"));
            ExitCode::from(EXIT_SETUP)
        }
    }
}

