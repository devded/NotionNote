use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
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

/// Shared client: enables connection pooling and guarantees requests can never
/// hang forever (a hung request would otherwise stall the sync engine).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client")
    })
}

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

    let client = http_client();
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

    // Retry once with backoff on rate limiting or server errors.
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
        // Honour Notion's Retry-After header if present (seconds); otherwise
        // fall back to a short fixed delay.
        let retry_after_secs = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(2)
            .min(30);
        let text = resp.text().await.unwrap_or_default();

        let retryable = status == 429 || status >= 500;
        if retryable && attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_secs(retry_after_secs)).await;
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

// ---------- Note images (stored locally, uploaded to Notion on sync) ----------

const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "gif", "webp"];
/// Notion's single-part upload limit.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Image names come from the frontend and from Notion captions, so they are
/// validated strictly to rule out path traversal: `[A-Za-z0-9-]+.<ext>`.
fn image_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let (stem, ext) = name.rsplit_once('.').ok_or("invalid image name")?;
    let stem_ok = !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !stem_ok || !IMAGE_EXTS.contains(&ext) {
        return Err("invalid image name".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn image_mime(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e) {
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Raw bytes in the body (no JSON/base64 overhead), name in the `x-name` header.
#[tauri::command]
fn save_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image is larger than 20 MB".into());
    }
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing image name")?;
    write_atomic(&image_path(&app, name)?, bytes)
}

#[tauri::command]
fn read_image(app: AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(image_path(&app, &name)?).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn network_err(e: reqwest::Error) -> String {
    serde_json::json!({ "code": "network_error", "message": format!("Network error: {}", e) }).to_string()
}

fn http_err(status: u16, text: &str) -> String {
    serde_json::json!({ "code": format!("http_{}", status), "status": status, "message": text }).to_string()
}

/// Upload a local image via Notion's File Upload API; returns the
/// file_upload id to reference from an image block (valid for 1 hour).
#[tauri::command]
async fn notion_upload_image(app: AppHandle, name: String) -> Result<String, String> {
    let key = load_api_key(&app).ok_or_else(|| {
        r#"{"code":"unauthorized","message":"No Notion API key configured."}"#.to_string()
    })?;
    let bytes = fs::read(image_path(&app, &name)?).map_err(|e| e.to_string())?;
    let mime = image_mime(&name);
    let client = http_client();

    let resp = client
        .post(format!("{}/file_uploads", NOTION_API))
        .bearer_auth(&key)
        .header("Notion-Version", NOTION_VERSION)
        .json(&serde_json::json!({ "filename": name, "content_type": mime }))
        .send()
        .await
        .map_err(network_err)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(http_err(status, &text));
    }
    let created: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let id = created["id"].as_str().ok_or("file upload id missing")?.to_string();

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/file_uploads/{}/send", NOTION_API, id))
        .bearer_auth(&key)
        .header("Notion-Version", NOTION_VERSION)
        .multipart(reqwest::multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(network_err)?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(http_err(status, &resp.text().await.unwrap_or_default()));
    }
    Ok(id)
}

/// Fetch a Notion-hosted image (signed URL) into the local store, once.
#[tauri::command]
async fn download_image(app: AppHandle, name: String, url: String) -> Result<(), String> {
    let path = image_path(&app, &name)?;
    if path.exists() {
        return Ok(());
    }
    if !url.starts_with("https://") {
        return Err("only https image URLs are allowed".into());
    }
    let resp = http_client().get(&url).send().await.map_err(network_err)?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(http_err(status, ""));
    }
    let bytes = resp.bytes().await.map_err(network_err)?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image is larger than 20 MB".into());
    }
    write_atomic(&path, &bytes)
}

// ---------- Local persistence (config + notes cache) ----------

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
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    // Write to a temp file first, then atomically rename over the target so a
    // crash mid-write can never corrupt the only copy of the user's data.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Value, String> {
    let path = config_path(&app)?;
    Ok(read_json::<Value>(&path).unwrap_or_else(|| {
        serde_json::json!({ "database_name": "random_notes_desktop" })
    }))
}

#[tauri::command]
fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    write_json(&config_path(&app)?, &config)
}

#[tauri::command]
fn load_notes(app: AppHandle) -> Result<Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("notes.json");
    Ok(read_json::<Value>(&path).unwrap_or(Value::Array(vec![])))
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
    fs::remove_dir_all(dir.join("images")).ok();
    let cfg_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::remove_file(cfg_dir.join("config.json")).ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
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
            save_image,
            read_image,
            notion_upload_image,
            download_image,
            load_config,
            save_config,
            load_notes,
            save_notes,
            clear_local_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
