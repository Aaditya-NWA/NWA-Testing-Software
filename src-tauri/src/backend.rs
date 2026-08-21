//! backend.rs — owns the frozen FastAPI backend as a child process.
//!
//! Half of a contract with `backend-fastapi/run_backend.py`. Four things must
//! stay in step with it or the shell misreads the backend's state:
//!
//! * `READY_MARKER` — the exact stdout line meaning "the port is listening".
//! * `EXIT_PORT_BUSY` — the exit code meaning "something already holds 8000",
//!   which needs a different recovery path from a crash.
//! * the runtime file's location and shape (`%LOCALAPPDATA%\NWA Testing
//!   Software\runtime.json`, mirroring `app_paths.runtime_file()`).
//! * `/health` and `/shutdown` — see main.py.
//!
//! The shutdown token is READ from the runtime file rather than invented here,
//! so the normal stop and the orphan reclaim below use one code path. It also
//! means the shell has no secret of its own to get wrong.
//!
//! **Stopping this process is a safety property, not housekeeping.** The
//! backend's lifespan teardown calls `disconnect_async()`, which writes
//! THR_MIN and flushes it before closing the serial port, and that is what
//! spins the motor down. The firmware has no serial-loss failsafe, so a
//! process killed instead of asked leaves the motor at its last commanded
//! throttle. `stop()` therefore always asks first, and kills only if asking
//! did not work.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 8000;

const READY_MARKER: &str = "NWA_BACKEND_READY";
const EXIT_PORT_BUSY: i32 = 3;
const HEALTH_SIGNATURE: &str = "nwa-testing-software";

/// How long to wait for a graceful stop before killing. Generous on purpose:
/// the teardown writes THR_MIN and waits on the serial flush, and cutting that
/// short is the exact failure this timeout exists to avoid.
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(8);

/// Events the frontend's startup gate listens for.
pub const EV_READY: &str = "backend-ready";
pub const EV_EXITED: &str = "backend-exited";

#[derive(Clone, serde::Serialize)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub port_busy: bool,
    pub tail: String,
}

#[derive(serde::Deserialize)]
struct RuntimeInfo {
    port: u16,
    token: String,
}

pub struct Backend {
    child: Mutex<Option<Child>>,
    /// Last few output lines, so a failed start can say what happened instead
    /// of just "the backend did not come up".
    tail: Mutex<Vec<String>>,
}

impl Backend {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            tail: Mutex::new(Vec::new()),
        }
    }

    fn push_tail(&self, line: &str) {
        let mut t = self.tail.lock().unwrap();
        t.push(line.to_string());
        if t.len() > 40 {
            t.remove(0);
        }
    }

    pub fn tail(&self) -> String {
        self.tail.lock().unwrap().join("\n")
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn spawn(&self, app: &AppHandle) -> Result<(), String> {
        let exe = resolve_backend_exe(app)?;
        let dir = exe
            .parent()
            .ok_or_else(|| "backend executable has no parent directory".to_string())?
            .to_path_buf();

        let mut cmd = Command::new(&exe);
        cmd.args(["--port", &PORT.to_string()])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Without this the frozen backend flashes a console window on every
        // launch and leaves one in the taskbar for the whole session.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start the backend at {}: {e}", exe.display()))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *self.child.lock().unwrap() = Some(child);

        if let Some(out) = stdout {
            let app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let ready = line.trim() == READY_MARKER;
                    app.state::<Backend>().push_tail(&line);
                    if ready {
                        let _ = app.emit(EV_READY, ());
                    }
                }
            });
        }

        if let Some(err) = stderr {
            let app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    app.state::<Backend>().push_tail(&line);
                }
            });
        }

        // Watches for an exit nobody asked for. The frontend needs this to
        // leave the "Starting up..." screen with a real reason rather than
        // spinning forever on a process that is already gone.
        {
            let app = app.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(400));
                let state = app.state::<Backend>();
                let exited = {
                    let mut guard = state.child.lock().unwrap();
                    match guard.as_mut() {
                        None => return,
                        Some(c) => match c.try_wait() {
                            Ok(Some(status)) => {
                                *guard = None;
                                Some(status.code())
                            }
                            Ok(None) => None,
                            Err(_) => return,
                        },
                    }
                };
                if let Some(code) = exited {
                    // Let the reader threads drain the pipes first, or the tail
                    // we report is empty exactly when it matters most.
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = app.emit(
                        EV_EXITED,
                        ExitInfo {
                            code,
                            port_busy: code == Some(EXIT_PORT_BUSY),
                            tail: app.state::<Backend>().tail(),
                        },
                    );
                    return;
                }
            });
        }

        Ok(())
    }

    /// Ask, wait, then kill. Never the other way round — see the module note.
    pub fn stop(&self) {
        if !self.is_running() {
            return;
        }

        if let Some(rt) = read_runtime_file() {
            if rt.port == PORT {
                let _ = request_shutdown(PORT, &rt.token);
            }
        }

        let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
        loop {
            {
                let mut guard = self.child.lock().unwrap();
                match guard.as_mut() {
                    None => return,
                    Some(c) => {
                        if matches!(c.try_wait(), Ok(Some(_))) {
                            *guard = None;
                            return;
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // Last resort. Reaching here means the motor may still be driven, so it
        // is worth being loud about in the log the operator sends us.
        eprintln!(
            "[shell] backend did not stop gracefully within {GRACEFUL_STOP_TIMEOUT:?}; killing"
        );
        let mut guard = self.child.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        *guard = None;
    }
}

/// What is holding port 8000, if anything.
pub enum PortState {
    Free,
    /// A backend of ours left by a previous run — recoverable, and it can be
    /// asked to stop properly.
    OurOrphan,
    /// Someone else's service. Nothing we may safely touch.
    Foreign,
}

pub fn inspect_port() -> PortState {
    if port_is_free(PORT) {
        return PortState::Free;
    }
    match http_get(PORT, "/health") {
        Some(body) if body.contains(HEALTH_SIGNATURE) => PortState::OurOrphan,
        _ => PortState::Foreign,
    }
}

/// Stop an orphan the polite way, so its own teardown writes THR_MIN.
/// Returns true once the port is free again.
pub fn reclaim_orphan() -> bool {
    if let Some(rt) = read_runtime_file() {
        if rt.port == PORT {
            let _ = request_shutdown(PORT, &rt.token);
        }
    }
    let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
    while Instant::now() < deadline {
        if port_is_free(PORT) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

// ── plumbing ─────────────────────────────────────────────────────────────────

fn port_is_free(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpListener::bind(addr).is_ok()
}

fn runtime_file_path() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("TEMP"))
        .ok()?;
    Some(
        PathBuf::from(base)
            .join("NWA Testing Software")
            .join("runtime.json"),
    )
}

fn read_runtime_file() -> Option<RuntimeInfo> {
    let text = std::fs::read_to_string(runtime_file_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn http_request(port: u16, raw: &str) -> Option<String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(3000))).ok()?;
    s.set_write_timeout(Some(Duration::from_millis(1500))).ok()?;
    s.write_all(raw.as_bytes()).ok()?;
    s.flush().ok()?;
    let mut buf = String::new();
    let _ = s.try_clone().ok()?.take(64 * 1024).read_to_string(&mut buf);
    let _ = s.shutdown(Shutdown::Both);
    Some(buf)
}

fn http_get(port: u16, path: &str) -> Option<String> {
    http_request(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    )
}

fn request_shutdown(port: u16, token: &str) -> Option<String> {
    http_request(
        port,
        &format!(
            "POST /shutdown?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        ),
    )
}

/// Find `nwa-backend.exe`.
///
/// Several candidates rather than one path, because Tauri's installed resource
/// layout depends on how `bundle.resources` was declared and a `..` in a
/// resource path becomes `_up_` in the installed tree. Trying the plausible
/// layouts and naming every one it missed turns a packaging mistake into a
/// readable error instead of a silent "the backend never started".
fn resolve_backend_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) { "nwa-backend.exe" } else { "nwa-backend" };
    let mut tried: Vec<PathBuf> = Vec::new();

    if let Ok(res) = app.path().resource_dir() {
        for rel in [
            "backend",
            "backend/nwa-backend",
            "_up_/backend-fastapi/dist/nwa-backend",
            "backend-fastapi/dist/nwa-backend",
        ] {
            tried.push(res.join(rel).join(exe_name));
        }
    }

    // `tauri dev` runs from src-tauri/ with nothing bundled, so fall back to
    // the PyInstaller output in the working tree.
    if let Ok(cwd) = std::env::current_dir() {
        tried.push(cwd.join("../backend-fastapi/dist/nwa-backend").join(exe_name));
        tried.push(cwd.join("backend-fastapi/dist/nwa-backend").join(exe_name));
    }

    for p in &tried {
        if p.is_file() {
            return Ok(p.clone());
        }
    }

    Err(format!(
        "Could not find the backend executable. Looked in:\n{}",
        tried
            .iter()
            .map(|p| format!("  {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}
