//! Desktop upload commands for multipart R2 upload via presigned PUT URLs.
//!
//! | Command              | Returns                                | Purpose                        |
//! |----------------------|----------------------------------------|--------------------------------|
//! | `upload_video`       | `Result<UploadResult, UploadError>`    | Full upload pipeline           |
//! | `cancel_upload`      | `Result<(), UploadError>`              | Cancel in-progress upload      |
//! | `get_upload_status`  | `Result<UploadStatusDto, UploadError>` | Current upload state           |
//!
//! **Upload flow (D-01):**
//! 1. Generate thumbnail from first frame via FFmpeg sidecar
//! 2. Call web `/api/upload/initiate` with file metadata
//! 3. Read file in 10 MiB chunks, for each: get presigned URL, PUT to R2
//! 4. Call `/api/upload/complete` with all ETags
//! 5. Upload thumbnail as separate single PUT
//!
//! **Resumability:** Tracks uploaded parts in `<video>.upload-state.json`.
//! On retry, skips parts whose ETag matches.
//!
//! **Threat mitigations:**
//! - T-04-12: Desktop JWT verified on every API call
//! - T-04-14: R2 credentials never on desktop; presigned URLs only

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::state::AppState;
use super::web_account::WebAccountError;

// ---- Constants ----------------------------------------------------------------

/// 10 MiB chunk size (respects 5 MiB minimum per Pitfall 2).
const CHUNK_SIZE: usize = 10 * 1024 * 1024;

/// Minimum file size for multipart upload. Below this, use single PUT.
const MIN_MULTIPART_SIZE: u64 = 5 * 1024 * 1024;

// ---- Public types -------------------------------------------------------------

/// Progress event emitted via Channel<T> during upload.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgressEvent {
    pub phase: String, // "thumbnail" | "uploading" | "completing"
    pub part_number: u32,
    pub total_parts: u32,
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
}

/// Result returned after a successful upload.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub video_id: String,
    pub slug: String,
    pub status: String,
}

/// Current upload status.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadStatusDto {
    pub status: String, // "idle" | "uploading" | "complete" | "error"
    pub progress: Option<UploadProgressEvent>,
    pub video_slug: Option<String>,
    pub error: Option<String>,
}

/// Structured error for upload operations.
#[derive(Serialize, Deserialize, Type, thiserror::Error, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum UploadError {
    #[error("no web account connected")]
    NotConnected,
    #[error("file not found: {0}")]
    FileNotFound(String),
    #[error("file read error: {0}")]
    FileReadError(String),
    #[error("network error: {0}")]
    NetworkError(String),
    #[error("server error: {0}")]
    ServerError(String),
    #[error("upload cancelled")]
    Cancelled,
    #[error("FFmpeg error: {0}")]
    FfmpegError(String),
    #[error("keychain error")]
    KeychainError,
}

impl From<WebAccountError> for UploadError {
    fn from(e: WebAccountError) -> Self {
        match e {
            WebAccountError::NotConnected => UploadError::NotConnected,
            WebAccountError::KeychainUnavailable => UploadError::KeychainError,
            _ => UploadError::ServerError(e.to_string()),
        }
    }
}

// ---- Upload state persistence (resumability) ----------------------------------

/// Persisted state for resumable uploads, stored alongside the video file.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct UploadState {
    video_id: String,
    upload_id: String,
    r2_key: String,
    slug: String,
    total_parts: u32,
    /// Parts that have been successfully uploaded. Map of partNumber -> ETag.
    completed_parts: std::collections::HashMap<u32, String>,
}

fn upload_state_path(video_path: &Path) -> PathBuf {
    let mut p = video_path.to_path_buf();
    let stem = p
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    p.set_file_name(format!("{stem}.upload-state.json"));
    p
}

fn load_upload_state(video_path: &Path) -> Option<UploadState> {
    let path = upload_state_path(video_path);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_upload_state(video_path: &Path, state: &UploadState) {
    let path = upload_state_path(video_path);
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(&path, json);
    }
}

fn remove_upload_state(video_path: &Path) {
    let path = upload_state_path(video_path);
    let _ = std::fs::remove_file(&path);
}

// ---- Managed state for cancellation -------------------------------------------

/// Global upload state managed by Tauri for cancellation + status queries.
pub struct UploadManagerState {
    cancel: Arc<AtomicBool>,
    status: Arc<Mutex<UploadStatusDto>>,
}

impl Default for UploadManagerState {
    fn default() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(UploadStatusDto {
                status: "idle".to_string(),
                progress: None,
                video_slug: None,
                error: None,
            })),
        }
    }
}

// ---- API response types -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitiateResponse {
    video_id: String,
    upload_id: String,
    r2_key: String,
    slug: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignResponse {
    presigned_url: String,
    #[serde(default)]
    #[allow(dead_code)]
    part_number: Option<u32>,
    #[serde(default)]
    thumbnail_r2_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteResponse {
    video_id: String,
    slug: String,
    status: String,
}

// ---- Tauri commands -----------------------------------------------------------

/// Upload a video + thumbnail to the web companion via presigned R2 URLs.
///
/// D-01: Manual trigger only. No auto-retry. Progress events via Channel.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, on_progress))]
pub async fn upload_video(
    app: tauri::AppHandle<tauri::Wry>,
    video_path: String,
    project_name: String,
    workspace_id: Option<String>,
    story_source: Option<String>,
    scene_boundaries: Option<String>,
    on_progress: Channel<UploadProgressEvent>,
) -> Result<UploadResult, UploadError> {
    tracing::info!(target: "storycapture::upload", video_path = %video_path, "upload_video");

    let video_path = PathBuf::from(&video_path);
    if !video_path.exists() {
        return Err(UploadError::FileNotFound(
            video_path.display().to_string(),
        ));
    }

    // Get the API token from keychain
    let token = super::web_account::get_web_api_token()
        .await
        .map_err(UploadError::from)?
        .ok_or(UploadError::NotConnected)?;

    // Initialize or get the upload manager state
    let (cancel_flag, status_lock) = if let Some(state) = app.try_state::<UploadManagerState>() {
        (state.cancel.clone(), state.status.clone())
    } else {
        let m = UploadManagerState::default();
        let cancel = m.cancel.clone();
        let status = m.status.clone();
        app.manage(m);
        (cancel, status)
    };

    cancel_flag.store(false, Ordering::SeqCst);

    // Get shared HTTP client from AppState
    let http_client = &app.state::<AppState>().http_client;

    // Update status to uploading
    {
        let mut s = status_lock.lock().await;
        *s = UploadStatusDto {
            status: "uploading".to_string(),
            progress: None,
            video_slug: None,
            error: None,
        };
    }

    let result = do_upload(
        &video_path,
        &project_name,
        workspace_id.as_deref(),
        story_source.as_deref(),
        scene_boundaries,
        &token,
        http_client,
        &on_progress,
        &cancel_flag,
    )
    .await;

    match &result {
        Ok(r) => {
            let mut s = status_lock.lock().await;
            *s = UploadStatusDto {
                status: "complete".to_string(),
                progress: None,
                video_slug: Some(r.slug.clone()),
                error: None,
            };
            remove_upload_state(&video_path);
        }
        Err(e) => {
            let mut s = status_lock.lock().await;
            *s = UploadStatusDto {
                status: "error".to_string(),
                progress: None,
                video_slug: None,
                error: Some(e.to_string()),
            };
        }
    }

    result
}

/// Cancel an in-progress upload.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn cancel_upload(
    app: tauri::AppHandle<tauri::Wry>,
) -> Result<(), UploadError> {
    tracing::info!(target: "storycapture::upload", "cancel_upload");

    if let Some(manager) = app.try_state::<UploadManagerState>() {
        manager.cancel.store(true, Ordering::SeqCst);
    }

    Ok(())
}

/// Get current upload status.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn get_upload_status(
    app: tauri::AppHandle<tauri::Wry>,
) -> Result<UploadStatusDto, UploadError> {
    if let Some(manager) = app.try_state::<UploadManagerState>() {
        let s = manager.status.lock().await;
        Ok(s.clone())
    } else {
        Ok(UploadStatusDto {
            status: "idle".to_string(),
            progress: None,
            video_slug: None,
            error: None,
        })
    }
}

// ---- Internal upload logic ----------------------------------------------------

async fn do_upload(
    video_path: &Path,
    project_name: &str,
    workspace_id: Option<&str>,
    story_source: Option<&str>,
    scene_boundaries: Option<String>,
    token: &str,
    client: &reqwest::Client,
    on_progress: &Channel<UploadProgressEvent>,
    cancel_flag: &AtomicBool,
) -> Result<UploadResult, UploadError> {
    let base = super::util::web_url();

    let file_meta = tokio::fs::metadata(video_path)
        .await
        .map_err(|e| UploadError::FileNotFound(e.to_string()))?;
    let file_size = file_meta.len();
    let file_name = video_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // STEP 1: Generate thumbnail from first frame via FFmpeg sidecar
    let _ = on_progress.send(UploadProgressEvent {
        phase: "thumbnail".to_string(),
        part_number: 0,
        total_parts: 0,
        bytes_uploaded: 0,
        total_bytes: file_size,
    });

    let thumb_path = generate_thumbnail(video_path).await?;

    if cancel_flag.load(Ordering::SeqCst) {
        return Err(UploadError::Cancelled);
    }

    // Check for existing upload state (resumability)
    let mut upload_state = load_upload_state(video_path);

    // STEP 2: Initiate upload (or resume existing)
    let (video_id, upload_id, r2_key, _slug) = if let Some(ref state) = upload_state {
        tracing::info!(target: "storycapture::upload", "resuming upload for video {}", state.video_id);
        (
            state.video_id.clone(),
            state.upload_id.clone(),
            state.r2_key.clone(),
            state.slug.clone(),
        )
    } else {
        // Determine workspace — use provided or fetch user's personal workspace
        let ws_id = workspace_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| "personal".to_string());

        let mut body = serde_json::json!({
            "fileName": file_name,
            "fileSizeBytes": file_size,
            "contentType": "video/mp4",
            "workspaceId": ws_id,
            "projectName": project_name,
        });

        if let Some(src) = story_source {
            body["storySource"] = serde_json::Value::String(src.to_string());
        }
        if let Some(boundaries) = &scene_boundaries {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(boundaries) {
                body["sceneBoundaries"] = parsed;
            }
        }

        let resp = client
            .post(format!("{base}/api/upload/initiate"))
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
            .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(UploadError::ServerError(format!(
                "initiate failed: {status} — {body_text}"
            )));
        }

        let init: InitiateResponse = resp
            .json()
            .await
            .map_err(|e| UploadError::ServerError(e.to_string()))?;

        let total_parts = if file_size < MIN_MULTIPART_SIZE {
            1
        } else {
            ((file_size as f64) / (CHUNK_SIZE as f64)).ceil() as u32
        };

        let state = UploadState {
            video_id: init.video_id.clone(),
            upload_id: init.upload_id.clone(),
            r2_key: init.r2_key.clone(),
            slug: init.slug.clone(),
            total_parts,
            completed_parts: Default::default(),
        };
        save_upload_state(video_path, &state);
        upload_state = Some(state);

        (init.video_id, init.upload_id, init.r2_key, init.slug)
    };

    // STEP 3-4: Upload chunks
    let total_parts = upload_state.as_ref().map(|s| s.total_parts).unwrap_or(1);
    let mut file = tokio::fs::File::open(video_path)
        .await
        .map_err(|e| UploadError::FileReadError(e.to_string()))?;

    let mut all_parts: Vec<(u32, String)> = Vec::new();

    // Collect already-completed parts for the final completion call
    if let Some(ref state) = upload_state {
        for (pn, etag) in &state.completed_parts {
            all_parts.push((*pn, etag.clone()));
        }
    }

    let mut bytes_uploaded: u64 = upload_state
        .as_ref()
        .map(|s| s.completed_parts.len() as u64 * CHUNK_SIZE as u64)
        .unwrap_or(0);

    for part_num in 1..=total_parts {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(UploadError::Cancelled);
        }

        // Skip already-uploaded parts (resumability)
        if upload_state
            .as_ref()
            .map(|s| s.completed_parts.contains_key(&part_num))
            .unwrap_or(false)
        {
            // Seek past this chunk
            let skip_bytes = CHUNK_SIZE.min((file_size - (part_num as u64 - 1) * CHUNK_SIZE as u64) as usize);
            let mut skip_buf = vec![0u8; skip_bytes];
            let _ = file.read_exact(&mut skip_buf).await;
            continue;
        }

        // Read chunk
        let remaining = file_size - ((part_num as u64 - 1) * CHUNK_SIZE as u64);
        let chunk_len = (CHUNK_SIZE as u64).min(remaining) as usize;
        let mut chunk = vec![0u8; chunk_len];
        file.read_exact(&mut chunk)
            .await
            .map_err(|e| UploadError::FileReadError(e.to_string()))?;

        // Get presigned URL for this part
        let presign_resp = client
            .post(format!("{base}/api/upload/presign"))
            .header("Authorization", format!("Bearer {token}"))
            .json(&serde_json::json!({
                "r2Key": r2_key,
                "uploadId": upload_id,
                "partNumber": part_num,
            }))
            .send()
            .await
            .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

        if !presign_resp.status().is_success() {
            let body_text = presign_resp.text().await.unwrap_or_default();
            return Err(UploadError::ServerError(format!(
                "presign failed for part {part_num}: {body_text}"
            )));
        }

        let presign: PresignResponse = presign_resp
            .json()
            .await
            .map_err(|e| UploadError::ServerError(e.to_string()))?;

        // PUT chunk directly to R2 via presigned URL
        let put_resp = client
            .put(&presign.presigned_url)
            .body(chunk)
            .send()
            .await
            .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

        if !put_resp.status().is_success() {
            let body_text = put_resp.text().await.unwrap_or_default();
            return Err(UploadError::ServerError(format!(
                "PUT part {part_num} failed: {body_text}"
            )));
        }

        // Extract ETag from response
        let etag = put_resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        all_parts.push((part_num, etag.clone()));

        // Save progress for resumability
        if let Some(ref mut state) = upload_state {
            state.completed_parts.insert(part_num, etag);
            save_upload_state(video_path, state);
        }

        bytes_uploaded += chunk_len as u64;

        // Emit progress event
        let _ = on_progress.send(UploadProgressEvent {
            phase: "uploading".to_string(),
            part_number: part_num,
            total_parts,
            bytes_uploaded,
            total_bytes: file_size,
        });
    }

    if cancel_flag.load(Ordering::SeqCst) {
        return Err(UploadError::Cancelled);
    }

    // STEP 7: Upload thumbnail via presigned PUT
    let _ = on_progress.send(UploadProgressEvent {
        phase: "completing".to_string(),
        part_number: total_parts,
        total_parts,
        bytes_uploaded: file_size,
        total_bytes: file_size,
    });

    let thumb_presign_resp = client
        .post(format!("{base}/api/upload/presign"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "r2Key": r2_key,
            "type": "thumbnail",
        }))
        .send()
        .await
        .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

    let mut thumbnail_r2_key = r2_key.replace(
        &format!(".{}", video_path.extension().unwrap_or_default().to_string_lossy()),
        "-thumb.jpg",
    );

    if thumb_presign_resp.status().is_success() {
        let thumb_presign: PresignResponse = thumb_presign_resp
            .json()
            .await
            .map_err(|e| UploadError::ServerError(e.to_string()))?;

        if let Some(key) = thumb_presign.thumbnail_r2_key {
            thumbnail_r2_key = key;
        }

        // Read and upload thumbnail
        let thumb_bytes = tokio::fs::read(&thumb_path)
            .await
            .map_err(|e| UploadError::FileReadError(format!("thumbnail read: {e}")))?;

        let thumb_put = client
            .put(&thumb_presign.presigned_url)
            .header("content-type", "image/jpeg")
            .body(thumb_bytes)
            .send()
            .await
            .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

        if !thumb_put.status().is_success() {
            tracing::warn!(target: "storycapture::upload", "thumbnail upload failed, continuing without thumbnail");
        }
    }

    // Clean up temp thumbnail
    let _ = tokio::fs::remove_file(&thumb_path).await;

    // STEP 6: Complete multipart upload
    all_parts.sort_by_key(|(pn, _)| *pn);
    let parts_payload: Vec<serde_json::Value> = all_parts
        .iter()
        .map(|(pn, etag)| {
            serde_json::json!({
                "PartNumber": pn,
                "ETag": etag,
            })
        })
        .collect();

    let complete_resp = client
        .post(format!("{base}/api/upload/complete"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "videoId": video_id,
            "r2Key": r2_key,
            "uploadId": upload_id,
            "parts": parts_payload,
            "thumbnailR2Key": thumbnail_r2_key,
        }))
        .send()
        .await
        .map_err(|e| UploadError::NetworkError(e.without_url().to_string()))?;

    if !complete_resp.status().is_success() {
        let body_text = complete_resp.text().await.unwrap_or_default();
        return Err(UploadError::ServerError(format!(
            "complete failed: {body_text}"
        )));
    }

    let result: CompleteResponse = complete_resp
        .json()
        .await
        .map_err(|e| UploadError::ServerError(e.to_string()))?;

    Ok(UploadResult {
        video_id: result.video_id,
        slug: result.slug,
        status: result.status,
    })
}

/// Generate a JPEG thumbnail from the first frame of a video using FFmpeg sidecar.
async fn generate_thumbnail(video_path: &Path) -> Result<PathBuf, UploadError> {
    let thumb_path = video_path.with_extension("thumb.jpg");

    // Try to use FFmpeg to extract first frame
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            &video_path.to_string_lossy(),
            "-vframes",
            "1",
            "-q:v",
            "2",
            &thumb_path.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|e| {
            UploadError::FfmpegError(format!(
                "failed to spawn ffmpeg: {e}. Is FFmpeg installed?"
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(UploadError::FfmpegError(format!(
            "FFmpeg thumbnail extraction failed: {stderr}"
        )));
    }

    if !thumb_path.exists() {
        return Err(UploadError::FfmpegError(
            "FFmpeg completed but thumbnail file not found".to_string(),
        ));
    }

    Ok(thumb_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_state_path_is_sibling() {
        let p = PathBuf::from("/tmp/recording.mp4");
        let state = upload_state_path(&p);
        assert_eq!(state, PathBuf::from("/tmp/recording.upload-state.json"));
    }

    #[test]
    fn chunk_size_is_10mib() {
        assert_eq!(CHUNK_SIZE, 10 * 1024 * 1024);
    }

    #[test]
    fn min_multipart_is_5mib() {
        assert_eq!(MIN_MULTIPART_SIZE, 5 * 1024 * 1024);
    }
}
