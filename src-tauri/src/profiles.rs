//! 配置管理：非敏感信息存 JSON，Secret Key 存系统钥匙串（macOS Keychain / Windows Credential Manager）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "com.r2manager.desktop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub access_key_id: String,
    pub bucket: String,
    /// 公开访问域名（可选），如 https://cdn.example.com
    #[serde(default)]
    pub public_domain: String,
    /// 自定义 Endpoint（可选，用于 EU 管辖区等），留空则根据 account_id 生成
    #[serde(default)]
    pub endpoint: String,
}

impl Profile {
    pub fn endpoint_url(&self) -> String {
        let ep = self.endpoint.trim();
        if !ep.is_empty() {
            if ep.starts_with("http://") || ep.starts_with("https://") {
                return ep.trim_end_matches('/').to_string();
            } else {
                return format!("https://{}", ep.trim_end_matches('/'));
            }
        }
        let acc = self.account_id.trim();
        if acc.starts_with("http://") || acc.starts_with("https://") {
            return acc.trim_end_matches('/').to_string();
        }
        if acc.contains(".r2.cloudflarestorage.com") {
            return format!("https://{}", acc.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'));
        }
        format!("https://{}.r2.cloudflarestorage.com", acc)
    }
}

pub struct ProfileStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ProfileStore {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { path: dir.join("profiles.json"), lock: Mutex::new(()) }
    }

    pub fn list(&self) -> Vec<Profile> {
        let _g = self.lock.lock().unwrap();
        self.read()
    }

    fn read(&self) -> Vec<Profile> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write(&self, list: &[Profile]) -> Result<(), String> {
        let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, s).map_err(|e| format!("写入配置失败: {e}"))
    }

    pub fn get(&self, id: &str) -> Result<Profile, String> {
        self.list()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "配置不存在".to_string())
    }

    pub fn save(&self, mut profile: Profile, secret: Option<String>) -> Result<Profile, String> {
        let _g = self.lock.lock().unwrap();
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(s) = secret.filter(|s| !s.is_empty()) {
            set_secret(&profile.id, &s)?;
        } else if get_secret(&profile.id).is_err() {
            return Err("请填写 Secret Access Key".into());
        }
        let mut list = self.read();
        match list.iter_mut().find(|p| p.id == profile.id) {
            Some(p) => *p = profile.clone(),
            None => list.push(profile.clone()),
        }
        self.write(&list)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut list = self.read();
        list.retain(|p| p.id != id);
        self.write(&list)?;
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, id) {
            let _ = entry.delete_credential();
        }
        Ok(())
    }
}

pub fn get_secret(id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("读取密钥失败: {e}"))
}

fn set_secret(id: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .and_then(|e| e.set_password(secret))
        .map_err(|e| format!("保存密钥失败: {e}"))
}
