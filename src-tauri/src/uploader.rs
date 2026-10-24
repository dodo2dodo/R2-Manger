//! 上传引擎：全局队列 + 并发控制 + 大文件分片并行上传 + 分片失败重试 + 取消。

use crate::s3::{err_str, exists};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use futures::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// 超过该大小使用分片上传
const MULTIPART_THRESHOLD: u64 = 16 * 1024 * 1024;
/// 最小分片大小
const MIN_PART_SIZE: u64 = 8 * 1024 * 1024;
/// S3 最多 10000 个分片，留余量
const MAX_PARTS: u64 = 9500;
/// 单个文件内的分片并发
const PART_CONCURRENCY: usize = 4;
const MAX_RETRY: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadItem {
    pub local_path: String,
    pub key: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub local_path: String,
    pub key: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: String,
    status: &'static str,
    uploaded: u64,
    total: u64,
    key: String,
    error: Option<String>,
}

enum UpErr {
    Canceled,
    Skipped,
    Fail(String),
}

impl From<String> for UpErr {
    fn from(s: String) -> Self {
        UpErr::Fail(s)
    }
}

const IGNORED: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// 将拖入的文件/文件夹展开为上传条目，文件夹保留目录结构
pub fn expand_paths(paths: Vec<String>, prefix: &str) -> Vec<UploadItem> {
    let mut items = vec![];
    for p in paths {
        let path = Path::new(&p);
        if path.is_dir() {
            let base = path.parent().unwrap_or(path);
            for entry in walkdir::WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy();
                if IGNORED.contains(&name.as_ref()) {
                    continue;
                }
                let Ok(rel) = entry.path().strip_prefix(base) else { continue };
                let rel: Vec<String> =
                    rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
                items.push(UploadItem {
                    local_path: entry.path().to_string_lossy().into_owned(),
                    key: format!("{}{}", prefix, rel.join("/")),
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        } else if path.is_file() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            items.push(UploadItem {
                local_path: p.clone(),
                key: format!("{prefix}{name}"),
                size: path.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    items
}

pub struct UploadManager {
    sem: Mutex<(usize, Arc<Semaphore>)>,
    tasks: Mutex<HashMap<String, CancellationToken>>,
}

impl UploadManager {
    pub fn new() -> Self {
        Self {
            sem: Mutex::new((3, Arc::new(Semaphore::new(3)))),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    fn semaphore(&self, n: usize) -> Arc<Semaphore> {
        let n = n.clamp(1, 16);
        let mut g = self.sem.lock().unwrap();
        if g.0 != n {
            *g = (n, Arc::new(Semaphore::new(n)));
        }
        g.1.clone()
    }

    pub fn cancel(&self, id: &str) {
        if let Some(t) = self.tasks.lock().unwrap().get(id) {
            t.cancel();
        }
    }

    pub fn cancel_all(&self) {
        for t in self.tasks.lock().unwrap().values() {
            t.cancel();
        }
    }

    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        client: Client,
        bucket: String,
        items: Vec<UploadItem>,
        concurrency: usize,
        conflict: String,
    ) -> Vec<TaskInfo> {
        let sem = self.semaphore(concurrency);
        let mut infos = vec![];
        for item in items {
            let id = uuid::Uuid::new_v4().to_string();
            let token = CancellationToken::new();
            self.tasks.lock().unwrap().insert(id.clone(), token.clone());
            infos.push(TaskInfo {
                id: id.clone(),
                local_path: item.local_path.clone(),
                key: item.key.clone(),
                size: item.size,
            });
            let (mgr, app, client, bucket, sem, conflict) =
                (self.clone(), app.clone(), client.clone(), bucket.clone(), sem.clone(), conflict.clone());
            tauri::async_runtime::spawn(async move {
                let emit = |status: &'static str, uploaded: u64, key: &str, error: Option<String>| {
                    let _ = app.emit(
                        "upload://progress",
                        ProgressEvent {
                            id: id.clone(),
                            status,
                            uploaded,
                            total: item.size,
                            key: key.to_string(),
                            error,
                        },
                    );
                };
                let permit = tokio::select! {
                    _ = token.cancelled() => None,
                    p = sem.acquire_owned() => p.ok(),
                };
                let res = match permit {
                    None => Err(UpErr::Canceled),
                    Some(_permit) => {
                        run_task(&client, &bucket, &item, &conflict, &token, &|status, up, key| {
                            emit(status, up, key, None)
                        })
                        .await
                    }
                };
                match res {
                    Ok(key) => emit("done", item.size, &key, None),
                    Err(UpErr::Skipped) => emit("skipped", 0, &item.key, None),
                    Err(UpErr::Canceled) => emit("canceled", 0, &item.key, None),
                    Err(UpErr::Fail(e)) => emit("error", 0, &item.key, Some(e)),
                }
                mgr.tasks.lock().unwrap().remove(&id);
            });
        }
        infos
    }
}

type EmitFn<'a> = &'a (dyn Fn(&'static str, u64, &str) + Send + Sync);

async fn run_task(
    c: &Client,
    bucket: &str,
    item: &UploadItem,
    conflict: &str,
    token: &CancellationToken,
    emit: EmitFn<'_>,
) -> Result<String, UpErr> {
    let mut key = item.key.clone();
    match conflict {
        "skip" => {
            if exists(c, bucket, &key).await? {
                return Err(UpErr::Skipped);
            }
        }
        "rename" => key = unique_key(c, bucket, &key).await?,
        _ => {}
    }
    emit("uploading", 0, &key);
    let content_type = mime_guess::from_path(&item.local_path).first_or_octet_stream().to_string();
    // 以实际文件大小为准
    let size = tokio::fs::metadata(&item.local_path)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?
        .len();
    if size <= MULTIPART_THRESHOLD {
        put_small(c, bucket, &key, &item.local_path, &content_type, token).await?;
    } else {
        put_multipart(c, bucket, &key, &item.local_path, size, &content_type, token, &|up| {
            emit("uploading", up, &key)
        })
        .await?;
    }
    Ok(key)
}

async fn unique_key(c: &Client, bucket: &str, key: &str) -> Result<String, String> {
    if !exists(c, bucket, key).await? {
        return Ok(key.to_string());
    }
    let (dir, name) = match key.rfind('/') {
        Some(i) => (&key[..=i], &key[i + 1..]),
        None => ("", key),
    };
    let (stem, ext) = match name.find('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..1000 {
        let k = format!("{dir}{stem} ({n}){ext}");
        if !exists(c, bucket, &k).await? {
            return Ok(k);
        }
    }
    Err("无法生成不重复的文件名".into())
}

async fn backoff(attempt: u32) {
    tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
}

async fn put_small(
    c: &Client,
    bucket: &str,
    key: &str,
    path: &str,
    content_type: &str,
    token: &CancellationToken,
) -> Result<(), UpErr> {
    let mut last = String::new();
    for attempt in 0..=MAX_RETRY {
        if attempt > 0 {
            backoff(attempt).await;
        }
        let body = ByteStream::from_path(path).await.map_err(|e| format!("读取文件失败: {e}"))?;
        let fut = c.put_object().bucket(bucket).key(key).content_type(content_type).body(body).send();
        let r = tokio::select! {
            _ = token.cancelled() => return Err(UpErr::Canceled),
            r = fut => r,
        };
        match r {
            Ok(_) => return Ok(()),
            Err(e) => last = err_str(e),
        }
    }
    Err(UpErr::Fail(last))
}

async fn read_part(path: &str, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).await?;
    Ok(buf)
}

#[allow(clippy::too_many_arguments)]
async fn put_multipart(
    c: &Client,
    bucket: &str,
    key: &str,
    path: &str,
    size: u64,
    content_type: &str,
    token: &CancellationToken,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), UpErr> {
    let part_size = MIN_PART_SIZE.max(size.div_ceil(MAX_PARTS));
    let n_parts = size.div_ceil(part_size);

    let created = c
        .create_multipart_upload()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .send()
        .await
        .map_err(err_str)?;
    let upload_id = created
        .upload_id()
        .ok_or_else(|| UpErr::Fail("未获取到 UploadId".into()))?
        .to_string();

    let uploaded = AtomicU64::new(0);
    let parts_fut = stream::iter(0..n_parts)
        .map(|i| {
            let (upload_id, uploaded) = (&upload_id, &uploaded);
            async move {
                let offset = i * part_size;
                let len = part_size.min(size - offset) as usize;
                let buf = read_part(path, offset, len).await.map_err(|e| format!("读取文件失败: {e}"))?;
                let part_no = (i + 1) as i32;
                let mut last = String::new();
                for attempt in 0..=MAX_RETRY {
                    if attempt > 0 {
                        backoff(attempt).await;
                    }
                    let r = c
                        .upload_part()
                        .bucket(bucket)
                        .key(key)
                        .upload_id(upload_id)
                        .part_number(part_no)
                        .body(ByteStream::from(buf.clone()))
                        .send()
                        .await;
                    match r {
                        Ok(out) => {
                            let done = uploaded.fetch_add(len as u64, Ordering::Relaxed) + len as u64;
                            on_progress(done);
                            return Ok::<_, String>(
                                CompletedPart::builder()
                                    .part_number(part_no)
                                    .set_e_tag(out.e_tag().map(String::from))
                                    .build(),
                            );
                        }
                        Err(e) => last = format!("分片 {part_no} 上传失败: {}", err_str(e)),
                    }
                }
                Err(last)
            }
        })
        .buffer_unordered(PART_CONCURRENCY)
        .try_collect::<Vec<_>>();

    let result = tokio::select! {
        _ = token.cancelled() => Err(UpErr::Canceled),
        r = parts_fut => r.map_err(UpErr::Fail),
    };

    let abort = || async {
        let _ = c.abort_multipart_upload().bucket(bucket).key(key).upload_id(&upload_id).send().await;
    };

    let mut parts = match result {
        Ok(p) => p,
        Err(e) => {
            abort().await;
            return Err(e);
        }
    };
    parts.sort_by_key(|p| p.part_number());
    let done = c
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
        .send()
        .await;
    if let Err(e) = done {
        abort().await;
        return Err(UpErr::Fail(err_str(e)));
    }
    Ok(())
}
