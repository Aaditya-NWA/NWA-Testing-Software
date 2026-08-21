//! lib.rs — the desktop shell.
//!
//! Owns three things the browser build never had to: one instance at a time,
//! the backend's lifetime, and a close that is safe rather than merely quick.
//!
//! **The close path is the safety-relevant one.** Closing the window does not
//! exit the app directly — it is intercepted, the frontend is told to show
//! that a shutdown is in progress, and the process exits only after the
//! backend has been asked to stop and has actually stopped. That ordering is
//! what guarantees THR_MIN reaches the ESC before the serial port closes; see
//! backend.rs.

mod backend;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use backend::{Backend, PortState};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, WindowEvent};

/// Told to the frontend when the window close is intercepted, so the operator
/// sees the motor being spun down instead of a window that will not shut.
const EV_CLOSING: &str = "app-closing";

#[derive(Default)]
struct Shell {
    ready: AtomicBool,
    /// Set when the backend could not be started at all, as opposed to having
    /// started and then died — the two need different wording on screen.
    startup_error: Mutex<Option<String>>,
    closing: AtomicBool,
}

#[derive(serde::Serialize)]
struct ShellState {
    ready: bool,
    running: bool,
    error: Option<String>,
    tail: String,
}

#[tauri::command]
fn shell_state(shell: tauri::State<Shell>, be: tauri::State<Backend>) -> ShellState {
    ShellState {
        ready: shell.ready.load(Ordering::Relaxed),
        running: be.is_running(),
        error: shell.startup_error.lock().unwrap().clone(),
        tail: be.tail(),
    }
}

/// Start (or restart) the backend. Exposed so a failed start has a Retry that
/// does not cost the operator an application restart.
#[tauri::command]
fn start_backend(app: AppHandle) -> Result<(), String> {
    launch(&app)
}

/// Open the activity log folder.
///
/// Duplicates /activity/open_folder deliberately: the moment the operator most
/// needs the logs is the moment the backend did not come up, and that endpoint
/// is unreachable exactly then.
#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("NWA Testing Software")
        .join("Logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            // explorer returns a non-zero exit code on success often enough
            // that checking it would report spurious failures.
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn launch(app: &AppHandle) -> Result<(), String> {
    let shell = app.state::<Shell>();
    shell.ready.store(false, Ordering::Relaxed);
    *shell.startup_error.lock().unwrap() = None;

    match backend::inspect_port() {
        PortState::Free => {}
        PortState::OurOrphan => {
            // A backend of ours survived a previous run — a crash, a forced
            // quit, a sleep. Asking it to stop is what spins its motor down;
            // killing it would not, so this is the only reclaim we do.
            if !backend::reclaim_orphan() {
                let msg = format!(
                    "A previous NWA Testing Software backend is still running on port {} \
                     and did not respond to a shutdown request.\n\n\
                     Close it from Task Manager (nwa-backend.exe), then press Retry.",
                    backend::PORT
                );
                *shell.startup_error.lock().unwrap() = Some(msg.clone());
                return Err(msg);
            }
        }
        PortState::Foreign => {
            let msg = format!(
                "Port {} is already in use by another program.\n\n\
                 NWA Testing Software needs that port. Close whatever is using it \
                 and press Retry.",
                backend::PORT
            );
            *shell.startup_error.lock().unwrap() = Some(msg.clone());
            return Err(msg);
        }
    }

    if let Err(e) = app.state::<Backend>().spawn(app) {
        *shell.startup_error.lock().unwrap() = Some(e.clone());
        return Err(e);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // One instance, because two would contend for the same COM port and
        // the same port 8000 — and the second one losing that race is not
        // obviously distinguishable from the hardware being broken.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Backend::new())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![
            shell_state,
            start_backend,
            open_logs_folder
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            {
                let handle = handle.clone();
                app.listen_any(backend::EV_READY, move |_| {
                    handle.state::<Shell>().ready.store(true, Ordering::Relaxed);
                });
            }

            // A failure here is reported through the frontend's startup screen
            // rather than a native dialog, so the operator gets the same
            // Retry / Open logs actions in every failure case.
            if let Err(e) = launch(&handle) {
                eprintln!("[shell] backend did not start: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let shell = app.state::<Shell>();
                if shell.closing.swap(true, Ordering::SeqCst) {
                    return; // already shutting down; let the second click through
                }
                if !app.state::<Backend>().is_running() {
                    return;
                }
                api.prevent_close();
                let _ = app.emit(EV_CLOSING, ());
                std::thread::spawn(move || {
                    app.state::<Backend>().stop();
                    app.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|app_handle, event| {
        // Backstop for exits that never pass through CloseRequested — the
        // updater's relaunch, or a shutdown initiated from the tray/OS.
        if let RunEvent::Exit = event {
            app_handle.state::<Backend>().stop();
        }
    });
}
