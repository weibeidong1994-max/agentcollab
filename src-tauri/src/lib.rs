use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

struct AppState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Serialize, Clone)]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitEvent {
    id: String,
    exit_code: Option<u32>,
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(args);

    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {}", e))?;

    let id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let child_arc = Arc::new(Mutex::new(child));
    let child_for_exit = child_arc.clone();

    let app_handle = app.clone();
    let session_id = id.clone();

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_handle.emit(
                        "pty-output",
                        PtyOutputEvent {
                            id: session_id.clone(),
                            data: encoded,
                        },
                    );
                }
                Err(e) => {
                    let kind = e.kind();
                    if kind == std::io::ErrorKind::WouldBlock {
                        continue;
                    }
                    break;
                }
            }
        }
    });

    let exit_app = app.clone();
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let mut child = child_for_exit.lock().unwrap();
        let exit_code = child.wait().ok().and_then(|s| {
            let code = s.exit_code();
            if code == 0 { None } else { Some(code) }
        });
        drop(child);
        let _ = exit_app.emit(
            "pty-exit",
            PtyExitEvent {
                id: exit_id,
                exit_code,
            },
        );
    });

    let session = PtySession {
        master: pair.master,
        writer: Mutex::new(writer),
        child: child_arc,
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), session);

    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("session not found")?;
    let mut writer = session.writer.lock().unwrap();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;
    writer.flush().map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&id) {
        let mut child = session.child.lock().unwrap();
        child.kill().map_err(|e| format!("kill failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    use std::fs;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    use std::fs;
    fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
fn mkdirp(path: String) -> Result<(), String> {
    use std::fs;
    fs::create_dir_all(&path).map_err(|e| format!("mkdir failed: {}", e))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    use std::fs;
    let entries = fs::read_dir(&path).map_err(|e| format!("read_dir failed: {}", e))?;
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        if let Ok(e) = entry {
            names.push(e.file_name().to_string_lossy().to_string());
        }
    }
    Ok(names)
}

#[tauri::command]
fn remove_dir(path: String) -> Result<(), String> {
    use std::fs;
    if !fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
        return Err(format!("{} is not a directory", path));
    }
    fs::remove_dir_all(&path).map_err(|e| format!("remove_dir failed: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill, write_file, read_file, mkdirp, list_dir, remove_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
