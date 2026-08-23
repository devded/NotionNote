use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "random-notes-desktop";
const KEY_USER: &str = "notion_api_key";

// ---------- Secure key storage (OS keychain with file fallback) ----------

fn fallback_key_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(".secret"))
}

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, KEY_USER).ok()
}

#[tauri::command]
fn set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    if let Some(entry) = keyring_entry() {
        match entry.set_password(&key) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!("keyring unavailable, using file fallback");
                let _ = e; // logged context only, no secret data
            }
        }
    }
    let path = fallback_key_path(&app).ok_or("no storage location available")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    file.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn has_api_key(app: AppHandle) -> bool {
    load_api_key(&app).is_some()
}

#[tauri::command]
fn delete_api_key(app: AppHandle) -> Result<(), String> {
    if let Some(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    if let Some(path) = fallback_key_path(&app) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn load_api_key(app: &AppHandle) -> Option<String> {
    if let Some(entry) = keyring_entry() {
        if let Ok(key) = entry.get_password() {
            return Some(key);
        }
    }
    let path = fallback_key_path(app)?;
    fs::read_to_string(path).ok().filter(|s| !s.is_empty())
}

// ---------- Notion API proxy (all requests happen here, key never leaves) ----------

const NOTION_API: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2025-09-03";

#[tauri::command]
async fn notion_request(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let key = load_api_key(&app).ok_or_else(|| {
        r#"{"code":"unauthorized","message":"No Notion API key configured."}"#.to_string()
    })?;

    let client = reqwest::Client::new();
    let url = format!("{}{}", NOTION_API, path);
    let m = method.to_uppercase();
    let mut req = match m.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", m)),
    };
    req = req
        .header("Authorization", format!("Bearer {}", key))
        .header("Notion-Version", NOTION_VERSION)
        .header("Content-Type", "application/json");

    // Rate limit: retry once after a short backoff.
    for attempt in 0..2 {
        let request = match (&body, m.as_str()) {
            (Some(b), "POST") | (Some(b), "PATCH") => req.try_clone().unwrap().json(b),
            _ => req.try_clone().unwrap(),
        };
        let resp = request.send().await.map_err(|e| {
            serde_json::json!({
                "code": "network_error",
                "message": format!("Network error: {}. Check your internet connection.", e)
            })
            .to_string()
        })?;

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if status == 429 && attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            continue;
        }

        if (200..300).contains(&status) {
            return Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::Null));
        }

        return Err(format!(
            r#"{{"code":"http_{}","status":{},"message":{}}}"#,
            status,
            status,
            serde_json::to_string(&text).unwrap_or_default()
        ));
    }
    unreachable!()
}

// ---------- Local persistence (config + notes cache) ----------

#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    database_name: String,
    #[serde(default)]
    database_id: Option<String>,
    #[serde(default)]
    data_source_id: Option<String>,
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    theme: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn read_json<T: DeserializeOwned>(path: &PathBuf) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Value, String> {
    let path = config_path(&app)?;
    Ok(read_json::<Config>(&path).map(|c| serde_json::to_value(c).unwrap()).unwrap_or_else(|| {
        serde_json::json!({ "database_name": "random_notes_desktop" })
    }))
}

#[tauri::command]
fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    let cfg: Config = serde_json::from_value(config).map_err(|e| e.to_string())?;
    write_json(&config_path(&app)?, &cfg)
}

#[tauri::command]
fn load_notes(app: AppHandle) -> Result<Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("notes.json");
    Ok(match read_json::<Value>(&path) {
        Some(v) => v,
        None => Value::Array(vec![]),
    })
}

#[tauri::command]
fn save_notes(app: AppHandle, notes: Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    write_json(&dir.join("notes.json"), &notes)
}

#[tauri::command]
fn clear_local_cache(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::remove_file(dir.join("notes.json")).ok();
    let cfg_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::remove_file(cfg_dir.join("config.json")).ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                for (_label, window) in app.webview_windows() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            has_api_key,
            delete_api_key,
            notion_request,
            load_config,
            save_config,
            load_notes,
            save_notes,
            clear_local_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
