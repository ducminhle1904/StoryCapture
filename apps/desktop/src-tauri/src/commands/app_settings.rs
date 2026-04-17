//! Lightweight JSON-backed app settings (Phase 1 browser-picker).
//!
//! Stored at `{app_config_dir}/app_settings.json`. Intentionally not using
//! `tauri-plugin-store` — this is a single small struct and avoiding the
//! plugin dep keeps the settings read path sync-safe (mutated on a UI thread
//! before `launch_automation` sets its env var).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct AppSettings {
    /// Absolute path to a Chromium-family browser executable. When unset,
    /// chromiumoxide auto-detects Google Chrome on the default install path.
    pub browser_executable: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_config_dir: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir.join("app_settings.json"))
}

pub fn load(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else { return AppSettings::default(); };
    let Ok(bytes) = std::fs::read(&path) else { return AppSettings::default(); };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Internal(format!("serialize settings: {e}")))?;
    std::fs::write(&path, bytes).map_err(AppError::from)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_app_settings(app: AppHandle) -> Result<AppSettings, AppError> {
    Ok(load(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn set_browser_executable(
    app: AppHandle,
    path: Option<String>,
) -> Result<AppSettings, AppError> {
    let mut s = load(&app);
    s.browser_executable = path.filter(|p| !p.is_empty());
    save(&app, &s)?;
    Ok(s)
}
