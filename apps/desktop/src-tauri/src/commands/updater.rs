// auto-updater IPC (DIST-03).
//
// Thin wrapper around `tauri-plugin-updater`'s `UpdaterExt` that exposes:
//   - check_update   → returns Option<UpdateInfo>
//   - install_update → downloads + applies + relaunches
//
// **Opt-in by default (DIST-05).** The renderer reads/writes the
// "check-for-updates-on-launch" preference through `@tauri-apps/plugin-store`;
// this module NEVER triggers an auto-check on its own. The Tauri config
// has `dialog: false`, so no built-in dialog is shown either — the UI
// fully controls when to call these commands.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Wry};
use tauri_plugin_updater::UpdaterExt;

use crate::error::AppError;

/// Summary of an available update, serialized to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UpdateInfo {
    /// New version string (e.g. "0.1.1").
    pub version: String,
    /// ISO-8601 release date, best-effort. `None` if the server didn't supply one.
    pub date: Option<String>,
    /// Release notes / body from the server manifest.
    pub body: Option<String>,
    /// Current installed version, for the UI to display a "X → Y" diff.
    pub current_version: String,
}

/// Query the configured update endpoint.
///
/// Returns `None` when the running version is already up to date.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "check_update"), err(Debug))]
pub async fn check_update(app: AppHandle<Wry>) -> Result<Option<UpdateInfo>, AppError> {
    tracing::info!(target: "storycapture::updater", "check_update invoked");
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater init: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::Internal(format!("updater check: {e}")))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        date: u.date.as_ref().map(|d| d.to_string()),
        body: u.body.clone(),
        current_version,
    }))
}

/// Download + apply the pending update, then relaunch the app.
///
/// Tauri's updater verifies the manifest signature against the `pubkey`
/// pinned in `tauri.conf.json` before applying — see T-10-01 mitigation.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "install_update"), err(Debug))]
pub async fn install_update(app: AppHandle<Wry>) -> Result<(), AppError> {
    tracing::info!(target: "storycapture::updater", "install_update invoked");
    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater init: {e}")))?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::Internal(format!("updater check: {e}")))?
        .ok_or_else(|| AppError::NotFound("no update available".to_string()))?;

    // Download with a noop progress callback — the UI shows a determinate
    // spinner based on a separate event stream we can wire later.
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AppError::Internal(format!("updater install: {e}")))?;

    // Tauri's API relaunches via the process plugin; this call never
    // returns on success.
    app.restart();
}
