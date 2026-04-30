//! Desktop-to-web sync commands with offline queue.
//!
//! | Command                  | Returns                                | Purpose                                  |
//! |--------------------------|----------------------------------------|------------------------------------------|
//! | `sync_project_metadata`  | `Result<SyncResult, WebSyncError>`     | Push metadata to web companion           |
//! | `update_recording_status`| `Result<(), WebSyncError>`             | Push recording status (fire-and-forget)  |
//! | `flush_sync_queue`       | `Result<FlushResult, WebSyncError>`    | Flush offline queue                      |
//! | `get_sync_status`        | `Result<SyncStatusDto, WebSyncError>`  | Current sync state                       |
//!
//! **Threat mitigations:**
//! - JWT auth on all web API calls
//! - Desktop is source of truth; last-write-wins

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

// ── Public types ──

/// Result of a metadata sync push.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub synced: bool,
    pub last_synced_at: String,
}

/// Result of flushing the offline queue.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlushResult {
    pub flushed: u32,
    pub failed: u32,
    pub remaining: u32,
}

/// Current sync status.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    pub connected: bool,
    pub pending_count: u32,
    pub last_sync: Option<String>,
}

/// Structured error for web sync operations.
#[derive(Serialize, Deserialize, Type, thiserror::Error, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum WebSyncError {
    #[error("no web account connected")]
    NotConnected,
    #[error("network error: {0}")]
    NetworkError(String),
    #[error("server error: {0}")]
    ServerError(String),
    #[error("database error: {0}")]
    DatabaseError(String),
}

impl From<rusqlite::Error> for WebSyncError {
    fn from(e: rusqlite::Error) -> Self {
        WebSyncError::DatabaseError(e.to_string())
    }
}

impl From<WebSyncError> for AppError {
    fn from(e: WebSyncError) -> Self {
        AppError::Storage(e.to_string())
    }
}

// ── Database helpers ──

/// Ensure the sync_queue table exists in app.sqlite.
fn ensure_sync_queue_table(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desktop_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);",
    )?;
    Ok(())
}

fn open_app_db(state: &AppState) -> Result<rusqlite::Connection, WebSyncError> {
    let db_path = state.data_dir.join("app.sqlite");
    let conn = rusqlite::Connection::open(&db_path)?;
    ensure_sync_queue_table(&conn)?;
    Ok(conn)
}

fn queue_metadata_update(
    conn: &rusqlite::Connection,
    desktop_id: &str,
    workspace_id: &str,
    payload: &serde_json::Value,
) -> Result<(), WebSyncError> {
    conn.execute(
        "INSERT INTO sync_queue (desktop_id, workspace_id, payload_json, status)
         VALUES (?1, ?2, ?3, 'pending')",
        rusqlite::params![desktop_id, workspace_id, payload.to_string()],
    )?;
    Ok(())
}

fn get_pending_count(conn: &rusqlite::Connection) -> Result<u32, WebSyncError> {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )?;
    Ok(count)
}

fn get_last_sync_timestamp(conn: &rusqlite::Connection) -> Result<Option<String>, WebSyncError> {
    let ts: Option<String> = conn
        .query_row(
            "SELECT MAX(created_at) FROM sync_queue WHERE status = 'sent'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(ts)
}

// ── HTTP helpers ──

async fn get_api_token() -> Result<String, WebSyncError> {
    super::web_account::get_web_api_token()
        .await
        .map_err(|_| WebSyncError::NotConnected)?
        .ok_or(WebSyncError::NotConnected)
}

async fn post_trpc_mutation(
    client: &reqwest::Client,
    token: &str,
    procedure: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, WebSyncError> {
    let url = format!("{}/api/trpc/{}", super::util::web_url(), procedure);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "json": payload }))
        .send()
        .await
        .map_err(|e| WebSyncError::NetworkError(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(WebSyncError::ServerError(format!("{}: {}", status, body)));
    }

    response
        .json()
        .await
        .map_err(|e| WebSyncError::ServerError(e.to_string()))
}

// ── Tauri commands ──

/// Push project metadata to the web companion. Queues locally if offline.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "sync_project_metadata"),
    err(Debug)
)]
pub async fn sync_project_metadata(
    state: State<'_, AppState>,
    desktop_id: String,
    workspace_id: String,
    project_name: String,
    story_source: Option<String>,
) -> Result<SyncResult, WebSyncError> {
    tracing::info!(
        target: "storycapture::web_sync",
        desktop_id = %desktop_id,
        "sync_project_metadata"
    );

    let token = match get_api_token().await {
        Ok(t) => t,
        Err(_) => {
            // No account connected — skip silently
            return Err(WebSyncError::NotConnected);
        }
    };

    let payload = serde_json::json!({
        "desktopId": desktop_id,
        "workspaceId": workspace_id,
        "projectName": project_name,
        "storySource": story_source,
    });

    let client = &state.http_client;

    match post_trpc_mutation(client, &token, "sync.pushMetadata", &payload).await {
        Ok(resp) => {
            let last_synced = resp
                .pointer("/result/data/json/lastSyncedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            Ok(SyncResult {
                synced: true,
                last_synced_at: last_synced,
            })
        }
        Err(e) => {
            // Queue for later if it's a network error
            tracing::warn!(
                target: "storycapture::web_sync",
                error = %e,
                "sync failed, queuing for later"
            );

            let conn = open_app_db(&state)?;
            queue_metadata_update(&conn, &desktop_id, &workspace_id, &payload)?;

            Err(e)
        }
    }
}

/// Update recording status on the web companion. Fire-and-forget pattern:
/// does NOT queue on failure (recording status is ephemeral).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "update_recording_status"),
    err(Debug)
)]
pub async fn update_recording_status(
    state: State<'_, AppState>,
    desktop_id: String,
    workspace_id: String,
    status: String,
) -> Result<(), WebSyncError> {
    tracing::debug!(
        target: "storycapture::web_sync",
        desktop_id = %desktop_id,
        status = %status,
        "update_recording_status"
    );

    let token = get_api_token().await?;

    let payload = serde_json::json!({
        "desktopId": desktop_id,
        "workspaceId": workspace_id,
        "status": status,
    });

    let client = &state.http_client;

    // Fire-and-forget: log error but don't fail the caller
    match post_trpc_mutation(client, &token, "sync.updateRecordingStatus", &payload).await {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::debug!(
                target: "storycapture::web_sync",
                error = %e,
                "recording status update failed (ephemeral, not queued)"
            );
            // Don't queue — stale recording status is not useful
            Err(e)
        }
    }
}

/// Flush all pending items from the offline sync queue.
/// Called on app startup and on network reconnect.
///
/// NOTE: rusqlite::Connection is !Send, so we must not hold it across .await
/// points. We read pending items, drop the connection, do HTTP calls, then
/// reopen the connection to delete successfully sent items.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "flush_sync_queue"), err(Debug))]
pub async fn flush_sync_queue(state: State<'_, AppState>) -> Result<FlushResult, WebSyncError> {
    tracing::info!(target: "storycapture::web_sync", "flush_sync_queue");

    let token = get_api_token().await?;

    // Phase 1: Read pending items (sync, no .await while conn is alive)
    let pending: Vec<(i64, String)> = {
        let conn = open_app_db(&state)?;
        let mut stmt = conn.prepare(
            "SELECT id, payload_json FROM sync_queue WHERE status = 'pending' ORDER BY id ASC",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    }; // conn + stmt dropped here

    if pending.is_empty() {
        return Ok(FlushResult {
            flushed: 0,
            failed: 0,
            remaining: 0,
        });
    }

    let client = &state.http_client;

    // Phase 2: Send each item via HTTP (async)
    let mut succeeded_ids: Vec<i64> = Vec::new();
    let mut corrupt_ids: Vec<i64> = Vec::new();
    let mut failed = 0u32;

    for (id, payload_json) in &pending {
        let payload: serde_json::Value = match serde_json::from_str(payload_json) {
            Ok(v) => v,
            Err(_) => {
                corrupt_ids.push(*id);
                failed += 1;
                continue;
            }
        };

        match post_trpc_mutation(&client, &token, "sync.pushMetadata", &payload).await {
            Ok(_) => {
                succeeded_ids.push(*id);
            }
            Err(e) => {
                tracing::warn!(
                    target: "storycapture::web_sync",
                    id = id,
                    error = %e,
                    "failed to flush queue item"
                );
                failed += 1;
            }
        }
    }

    // Phase 3: Delete succeeded + corrupt items from DB (sync, no .await)
    let flushed = succeeded_ids.len() as u32;
    let remaining = {
        let conn = open_app_db(&state)?;
        for id in succeeded_ids.iter().chain(corrupt_ids.iter()) {
            let _ = conn.execute(
                "DELETE FROM sync_queue WHERE id = ?1",
                rusqlite::params![id],
            );
        }
        get_pending_count(&conn)?
    };

    Ok(FlushResult {
        flushed,
        failed,
        remaining,
    })
}

/// Get the current sync status: connected, pending queue count, last sync time.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "get_sync_status"), err(Debug))]
pub async fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatusDto, WebSyncError> {
    let connected = get_api_token().await.is_ok();

    let conn = open_app_db(&state)?;
    let pending_count = get_pending_count(&conn)?;
    let last_sync = get_last_sync_timestamp(&conn)?;

    Ok(SyncStatusDto {
        connected,
        pending_count,
        last_sync,
    })
}
