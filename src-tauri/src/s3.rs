//! R2 (S3 兼容) 基础操作：列表、删除、重命名、新建目录、下载、签名链接等。

use crate::profiles::Profile;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::DisplayErrorContext;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use futures::{stream, StreamExt, TryStreamExt};
use serde::Serialize;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub fn err_str<E: std::error::Error>(e: E) -> String {
    format!("{}", DisplayErrorContext(e))
}

pub fn build_client(p: &Profile, secret: &str) -> Client {
    let creds = Credentials::new(p.access_key_id.trim(), secret.trim(), None, None, "r2manager");
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("auto"))
        .endpoint_url(p.endpoint_url())
        .credentials_provider(creds)
        .force_path_style(true)
        // 新版 SDK 默认附加 CRC 校验，R2 部分接口不兼容，仅在必须时计算
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .build();
    Client::from_conf(conf)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub key: String,
    pub size: i64,
    pub last_modified: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub folders: Vec<String>,
    pub files: Vec<FileEntry>,
    pub next_token: Option<String>,
}

pub async fn list_buckets(c: &Client) -> Result<Vec<String>, String> {
    let out = c.list_buckets().send().await.map_err(err_str)?;
    let buckets = out
        .buckets()
        .iter()
        .filter_map(|b| b.name().map(String::from))
        .collect();
    Ok(buckets)
}

pub async fn list(
    c: &Client,
    bucket: &str,
    prefix: &str,
    token: Option<String>,
) -> Result<ListResult, String> {
    // 首包 300 条极致秒开，翻页时 1000 条保证吞吐
    let max_keys = if token.is_none() { 300 } else { 1000 };
    let out = c
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .max_keys(max_keys)
        .set_continuation_token(token)
        .send()
        .await
        .map_err(err_str)?;
    let folders = out
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|s| s.to_string()))
        .collect();
    let files = out
        .contents()
        .iter()
        .filter(|o| o.key() != Some(prefix)) // 排除目录占位对象自身
        .map(|o| FileEntry {
            key: o.key().unwrap_or_default().to_string(),
            size: o.size().unwrap_or(0),
            last_modified: o
                .last_modified()
                .and_then(|d| d.to_millis().ok())
                .unwrap_or(0),
        })
        .collect();
    Ok(ListResult {
        folders,
        files,
        next_token: out.next_continuation_token().map(|s| s.to_string()),
    })
}

/// 递归列出某前缀下全部 key
pub async fn list_all_keys(c: &Client, bucket: &str, prefix: &str) -> Result<Vec<String>, String> {
    let mut keys = vec![];
    let mut token = None;
    loop {
        let out = c
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token)
            .send()
            .await
            .map_err(err_str)?;
        keys.extend(out.contents().iter().filter_map(|o| o.key().map(String::from)));
        match out.next_continuation_token() {
            Some(t) => token = Some(t.to_string()),
            None => break,
        }
    }
    Ok(keys)
}

pub async fn exists(c: &Client, bucket: &str, key: &str) -> Result<bool, String> {
    match c.head_object().bucket(bucket).key(key).send().await {
        Ok(_) => Ok(true),
        Err(e) => {
            if e.as_service_error().map(|s| s.is_not_found()).unwrap_or(false) {
                Ok(false)
            } else if let Some(r) = e.raw_response() {
                if r.status().as_u16() == 404 {
                    Ok(false)
                } else {
                    Err(err_str(e))
                }
            } else {
                Err(err_str(e))
            }
        }
    }
}

async fn delete_keys(c: &Client, bucket: &str, keys: Vec<String>) -> Result<usize, String> {
    let total = keys.len();
    let chunks: Vec<Vec<String>> = keys.chunks(1000).map(|c| c.to_vec()).collect();
    stream::iter(chunks)
        .map(|chunk| async move {
            let objs: Vec<ObjectIdentifier> = chunk
                .iter()
                .map(|k| ObjectIdentifier::builder().key(k).build().unwrap())
                .collect();
            let del = Delete::builder().set_objects(Some(objs)).quiet(true).build().unwrap();
            let batch = c.delete_objects().bucket(bucket).delete(del).send().await;
            if batch.is_err() {
                // 批量接口失败时退化为逐个删除
                stream::iter(chunk.into_iter())
                    .map(|k| async move {
                        c.delete_object().bucket(bucket).key(k).send().await.map_err(err_str)
                    })
                    .buffer_unordered(8)
                    .try_collect::<Vec<_>>()
                    .await?;
            }
            Ok::<(), String>(())
        })
        .buffer_unordered(4)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(total)
}

/// 删除文件或目录（以 / 结尾的 key 视为目录，递归删除）
pub async fn delete(c: &Client, bucket: &str, keys: Vec<String>) -> Result<usize, String> {
    let mut all = vec![];
    for k in keys {
        if k.ends_with('/') {
            all.extend(list_all_keys(c, bucket, &k).await?);
            all.push(k);
        } else {
            all.push(k);
        }
    }
    all.sort();
    all.dedup();
    delete_keys(c, bucket, all).await
}

fn copy_source(bucket: &str, key: &str) -> String {
    let enc: Vec<String> = key.split('/').map(|s| urlencoding::encode(s).into_owned()).collect();
    format!("{}/{}", bucket, enc.join("/"))
}

async fn copy_one(c: &Client, bucket: &str, from: &str, to: &str) -> Result<(), String> {
    c.copy_object()
        .bucket(bucket)
        .copy_source(copy_source(bucket, from))
        .key(to)
        .send()
        .await
        .map_err(err_str)?;
    Ok(())
}

/// 重命名 / 移动（文件或目录）
pub async fn rename(c: &Client, bucket: &str, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    if from.ends_with('/') {
        let to = if to.ends_with('/') { to.to_string() } else { format!("{to}/") };
        let keys = list_all_keys(c, bucket, from).await?;
        let pairs: Vec<(String, String)> = keys
            .iter()
            .map(|k| (k.clone(), format!("{}{}", to, &k[from.len()..])))
            .collect();
        stream::iter(pairs)
            .map(|(a, b)| async move { copy_one(c, bucket, &a, &b).await })
            .buffer_unordered(8)
            .try_collect::<Vec<_>>()
            .await?;
        let mut del = keys;
        del.push(from.to_string());
        delete_keys(c, bucket, del).await?;
    } else {
        if exists(c, bucket, to).await? {
            return Err(format!("目标已存在: {to}"));
        }
        copy_one(c, bucket, from, to).await?;
        delete_keys(c, bucket, vec![from.to_string()]).await?;
    }
    Ok(())
}

pub async fn create_folder(c: &Client, bucket: &str, key: &str) -> Result<(), String> {
    let key = if key.ends_with('/') { key.to_string() } else { format!("{key}/") };
    c.put_object()
        .bucket(bucket)
        .key(key)
        .body(Vec::new().into())
        .send()
        .await
        .map_err(err_str)?;
    Ok(())
}

pub async fn download(c: &Client, bucket: &str, key: &str, dest: &str) -> Result<(), String> {
    let out = c.get_object().bucket(bucket).key(key).send().await.map_err(err_str)?;
    let tmp = format!("{dest}.r2part");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut body = out.body;
    let res: Result<(), String> = async {
        while let Some(bytes) = body.try_next().await.map_err(|e| e.to_string())? {
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;

    if res.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    res
}

pub async fn presign(c: &Client, bucket: &str, key: &str, secs: u64) -> Result<String, String> {
    let cfg = PresigningConfig::expires_in(Duration::from_secs(secs.clamp(1, 604800)))
        .map_err(|e| e.to_string())?;
    let req = c
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(cfg)
        .await
        .map_err(err_str)?;
    Ok(req.uri().to_string())
}

/// 清理未完成的分片上传
pub async fn abort_incomplete(c: &Client, bucket: &str) -> Result<usize, String> {
    let mut n = 0;
    loop {
        let out = c
            .list_multipart_uploads()
            .bucket(bucket)
            .send()
            .await
            .map_err(err_str)?;
        let ups = out.uploads();
        if ups.is_empty() {
            break;
        }
        for u in ups {
            if let (Some(k), Some(id)) = (u.key(), u.upload_id()) {
                c.abort_multipart_upload()
                    .bucket(bucket)
                    .key(k)
                    .upload_id(id)
                    .send()
                    .await
                    .map_err(err_str)?;
                n += 1;
            }
        }
        if !out.is_truncated().unwrap_or(false) {
            break;
        }
    }
    Ok(n)
}
