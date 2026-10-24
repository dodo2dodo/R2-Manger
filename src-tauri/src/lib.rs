mod profiles;
mod s3;
mod uploader;

use aws_sdk_s3::Client;
use profiles::{get_secret, Profile, ProfileStore};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use uploader::{TaskInfo, UploadItem, UploadManager};

struct AppState {
    store: ProfileStore,
    clients: Mutex<HashMap<String, (Client, String)>>,
    uploads: Arc<UploadManager>,
}

impl AppState {
    fn client(&self, id: &str, bucket: Option<String>) -> Result<(Client, String), String> {
        let (client, default_bucket) = {
            let mut clients = self.clients.lock().unwrap();
            if let Some(c) = clients.get(id) {
                c.clone()
            } else {
                let p = self.store.get(id)?;
                let secret = get_secret(id)?;
                let c = (s3::build_client(&p, &secret), p.bucket.clone());
                clients.insert(id.to_string(), c.clone());
                c
            }
        };
        let final_bucket = match bucket.filter(|b| !b.trim().is_empty()) {
            Some(b) => b,
            None => default_bucket,
        };
        Ok((client, final_bucket))
    }
}

type R<T> = Result<T, String>;

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Vec<Profile> {
    state.store.list()
}

#[tauri::command]
fn save_profile(state: State<'_, AppState>, profile: Profile, secret: Option<String>) -> R<Profile> {
    let p = state.store.save(profile, secret)?;
    state.clients.lock().unwrap().remove(&p.id);
    Ok(p)
}

#[tauri::command]
fn delete_profile(state: State<'_, AppState>, id: String) -> R<()> {
    state.clients.lock().unwrap().remove(&id);
    state.store.delete(&id)
}

#[tauri::command]
async fn test_profile(profile: Profile, secret: Option<String>) -> R<Vec<String>> {
    let secret = match secret.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => get_secret(&profile.id)?,
    };
    let c = s3::build_client(&profile, &secret);
    if !profile.bucket.trim().is_empty() {
        c.list_objects_v2()
            .bucket(&profile.bucket)
            .max_keys(1)
            .send()
            .await
            .map_err(s3::err_str)?;
        Ok(vec![profile.bucket.clone()])
    } else {
        s3::list_buckets(&c).await
    }
}

#[tauri::command]
async fn list_buckets(profile: Profile, secret: Option<String>) -> R<Vec<String>> {
    let secret = match secret.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => get_secret(&profile.id)?,
    };
    let c = s3::build_client(&profile, &secret);
    s3::list_buckets(&c).await
}

#[tauri::command]
async fn get_profile_buckets(state: State<'_, AppState>, profile_id: String) -> R<Vec<String>> {
    let (c, _) = state.client(&profile_id, None)?;
    s3::list_buckets(&c).await
}

#[tauri::command]
fn switch_profile_bucket(state: State<'_, AppState>, profile_id: String, bucket: String) -> R<Profile> {
    let mut p = state.store.get(&profile_id)?;
    p.bucket = bucket.trim().to_string();
    state.store.save(p.clone(), None)?;
    // 更新已有 Client 连接池的默认桶，复用底层 HTTP/2 和 TLS 活跃连接
    let mut clients = state.clients.lock().unwrap();
    if let Some(entry) = clients.get_mut(&profile_id) {
        entry.1 = p.bucket.clone();
    }
    Ok(p)
}

#[tauri::command]
async fn list_objects(
    state: State<'_, AppState>,
    profile_id: String,
    prefix: String,
    token: Option<String>,
    bucket: Option<String>,
) -> R<s3::ListResult> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::list(&c, &b, &prefix, token).await
}

#[tauri::command]
async fn delete_objects(
    state: State<'_, AppState>,
    profile_id: String,
    keys: Vec<String>,
    bucket: Option<String>,
) -> R<usize> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::delete(&c, &b, keys).await
}

#[tauri::command]
async fn rename_object(
    state: State<'_, AppState>,
    profile_id: String,
    from: String,
    to: String,
    bucket: Option<String>,
) -> R<()> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::rename(&c, &b, &from, &to).await
}

#[tauri::command]
async fn create_folder(
    state: State<'_, AppState>,
    profile_id: String,
    key: String,
    bucket: Option<String>,
) -> R<()> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::create_folder(&c, &b, &key).await
}

#[tauri::command]
async fn download_object(
    state: State<'_, AppState>,
    profile_id: String,
    key: String,
    dest: String,
    bucket: Option<String>,
) -> R<()> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::download(&c, &b, &key, &dest).await
}

#[tauri::command]
async fn presign_url(
    state: State<'_, AppState>,
    profile_id: String,
    key: String,
    expires: u64,
    bucket: Option<String>,
) -> R<String> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::presign(&c, &b, &key, expires).await
}

#[tauri::command]
async fn abort_incomplete_uploads(
    state: State<'_, AppState>,
    profile_id: String,
    bucket: Option<String>,
) -> R<usize> {
    let (c, b) = state.client(&profile_id, bucket)?;
    s3::abort_incomplete(&c, &b).await
}

#[tauri::command]
async fn expand_paths(paths: Vec<String>, prefix: String) -> Vec<UploadItem> {
    tauri::async_runtime::spawn_blocking(move || uploader::expand_paths(paths, &prefix))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn start_uploads(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    items: Vec<UploadItem>,
    concurrency: usize,
    conflict: String,
    bucket: Option<String>,
) -> R<Vec<TaskInfo>> {
    let (c, b) = state.client(&profile_id, bucket)?;
    Ok(state.uploads.start(app, c, b, items, concurrency, conflict))
}

#[tauri::command]
fn cancel_upload(state: State<'_, AppState>, id: String) {
    state.uploads.cancel(&id);
}

#[tauri::command]
fn cancel_all_uploads(state: State<'_, AppState>) {
    state.uploads.cancel_all();
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: ProfileStore::new(dir),
                clients: Mutex::new(HashMap::new()),
                uploads: Arc::new(UploadManager::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            delete_profile,
            test_profile,
            list_buckets,
            get_profile_buckets,
            switch_profile_bucket,
            list_objects,
            delete_objects,
            rename_object,
            create_folder,
            download_object,
            presign_url,
            abort_incomplete_uploads,
            expand_paths,
            start_uploads,
            cancel_upload,
            cancel_all_uploads,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
