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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Absolute path to a Chromium-family browser executable. When unset,
    /// chromiumoxide auto-detects Google Chrome on the default install path.
    pub browser_executable: Option<String>,
    /// Last-chosen capture target for stickiness (Plan 05-01, D-01).
    /// First-run default: None → UI translates to "Playwright auto" greyed
    /// out until a story launches.
    ///
    /// Note: not exposed via specta::Type — the full `CaptureTarget` type
    /// lives in the `capture` crate and flows over IPC separately via
    /// get_capture_target / set_capture_target in commands/capture.rs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_target: Option<capture::CaptureTarget>,
    /// Phase 09-02 — persisted Options toggle for the in-recorder live
    /// preview pane. Default `true` (D-11).
    pub live_preview_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            browser_executable: None,
            capture_target: None,
            live_preview_enabled: true,
        }
    }
}

// Specta-visible DTO exposed to the frontend — mirrors the persisted
// fields that the frontend cares about (the capture_target is exposed
// through dedicated get/set commands).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct AppSettingsDto {
    pub browser_executable: Option<String>,
    pub live_preview_enabled: bool,
}

impl Default for AppSettingsDto {
    fn default() -> Self {
        Self {
            browser_executable: None,
            live_preview_enabled: true,
        }
    }
}

impl From<&AppSettings> for AppSettingsDto {
    fn from(s: &AppSettings) -> Self {
        Self {
            browser_executable: s.browser_executable.clone(),
            live_preview_enabled: s.live_preview_enabled,
        }
    }
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
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return AppSettings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Internal(format!("serialize settings: {e}")))?;
    std::fs::write(&path, bytes).map_err(AppError::from)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_app_settings(app: AppHandle) -> Result<AppSettingsDto, AppError> {
    Ok((&load(&app)).into())
}

#[tauri::command]
#[specta::specta]
pub async fn set_browser_executable(
    app: AppHandle,
    path: Option<String>,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    s.browser_executable = path.filter(|p| !p.is_empty());
    save(&app, &s)?;
    Ok((&s).into())
}

#[tauri::command]
#[specta::specta]
pub async fn set_live_preview_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    s.live_preview_enabled = enabled;
    save(&app, &s)?;
    Ok((&s).into())
}
