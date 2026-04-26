//! Lightweight JSON-backed app settings.
//!
//! Stored at `{app_config_dir}/app_settings.json`. Intentionally not using
//! `tauri-plugin-store` — this is a single small struct and avoiding the
//! plugin dep keeps the settings read path sync-safe (mutated on a UI thread
//! before `launch_automation` sets its env var).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_LOG_MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
pub const DEFAULT_LOG_MAX_FILES: usize = 10;
pub const MIN_LOG_MAX_FILE_SIZE_BYTES: u64 = 64 * 1024;
pub const MAX_LOG_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MIN_LOG_MAX_FILES: usize = 1;
pub const MAX_LOG_MAX_FILES: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogConfig {
    /// Optional override for the log directory. When `None`, the platform
    /// default (`app_log_dir()`) is used.
    pub log_dir: Option<String>,
    /// Maximum size of one log file before rotation, in bytes. Defaults to
    /// 10 MiB.
    pub max_file_size_bytes: u64,
    /// Maximum number of rotated log files to keep (the live file plus this
    /// many archives). Defaults to 10.
    pub max_files: usize,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            log_dir: None,
            max_file_size_bytes: DEFAULT_LOG_MAX_FILE_SIZE_BYTES,
            max_files: DEFAULT_LOG_MAX_FILES,
        }
    }
}

impl LogConfig {
    /// Clamp user-supplied values to the supported ranges. Used both on the
    /// IPC write path (defensive) and on the boot read path (in case a
    /// hand-edited settings file holds garbage).
    pub fn clamped(mut self) -> Self {
        if self.max_file_size_bytes < MIN_LOG_MAX_FILE_SIZE_BYTES {
            self.max_file_size_bytes = MIN_LOG_MAX_FILE_SIZE_BYTES;
        }
        if self.max_file_size_bytes > MAX_LOG_MAX_FILE_SIZE_BYTES {
            self.max_file_size_bytes = MAX_LOG_MAX_FILE_SIZE_BYTES;
        }
        if self.max_files < MIN_LOG_MAX_FILES {
            self.max_files = MIN_LOG_MAX_FILES;
        }
        if self.max_files > MAX_LOG_MAX_FILES {
            self.max_files = MAX_LOG_MAX_FILES;
        }
        if let Some(dir) = self.log_dir.as_ref() {
            if dir.trim().is_empty() {
                self.log_dir = None;
            }
        }
        self
    }

    /// Resolve the effective log directory, falling back to `default_dir`
    /// when no override is set.
    pub fn resolve_dir(&self, default_dir: &Path) -> PathBuf {
        self.log_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_dir.to_path_buf())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Absolute path to a Chromium-family browser executable. When unset,
    /// chromiumoxide auto-detects Google Chrome on the default install path.
    pub browser_executable: Option<String>,
    /// Last-chosen capture target for stickiness. First-run default: None
    /// → UI translates to "Playwright auto" greyed out until a story launches.
    ///
    /// Note: not exposed via specta::Type — the full `CaptureTarget` type
    /// lives in the `capture` crate and flows over IPC separately via
    /// get_capture_target / set_capture_target in commands/capture.rs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_target: Option<capture::CaptureTarget>,
    /// Persisted Options toggle for the in-recorder live preview pane.
    pub live_preview_enabled: bool,
    /// User-configurable file logging policy.
    pub log: LogConfig,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            browser_executable: None,
            capture_target: None,
            live_preview_enabled: true,
            log: LogConfig::default(),
        }
    }
}

// Specta-visible DTO exposed to the frontend — mirrors the persisted
// fields that the frontend cares about (capture_target uses dedicated get/set
// commands).
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LogConfigDto {
    /// Effective directory log files are written to. Always populated —
    /// when `log_dir_override` is null, this is the platform default the
    /// frontend can show as a hint.
    pub effective_log_dir: String,
    /// Raw user override (null = use platform default).
    pub log_dir_override: Option<String>,
    /// Platform default log directory; informational, never written.
    pub default_log_dir: String,
    pub max_file_size_bytes: u64,
    pub max_files: u32,
    pub min_file_size_bytes: u64,
    pub max_allowed_file_size_bytes: u64,
    pub min_files: u32,
    pub max_allowed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LogConfigUpdate {
    pub log_dir: Option<String>,
    pub max_file_size_bytes: u64,
    pub max_files: u32,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_config_dir: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(AppError::from)?;
    Ok(dir.join("app_settings.json"))
}

fn settings_path_from_config_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("app_settings.json")
}

pub fn load(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return AppSettings::default();
    };
    let mut s: AppSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    s.log = s.log.clamped();
    s
}

/// Load settings from a known config directory without an `AppHandle` — used
/// during early boot before the Tauri runtime is fully alive (the
/// `tauri-plugin-log` builder needs the values before `setup()` runs).
pub fn load_from_config_dir(config_dir: &Path) -> AppSettings {
    let path = settings_path_from_config_dir(config_dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return AppSettings::default();
    };
    let mut s: AppSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    s.log = s.log.clamped();
    s
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Internal(format!("serialize settings: {e}")))?;
    std::fs::write(&path, bytes).map_err(AppError::from)?;
    Ok(())
}

fn default_log_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_log_dir()
        .map_err(|e| AppError::Internal(format!("resolve app_log_dir: {e}")))
}

fn build_log_config_dto(app: &AppHandle, settings: &AppSettings) -> Result<LogConfigDto, AppError> {
    let default_dir = default_log_dir(app)?;
    let effective = settings.log.resolve_dir(&default_dir);
    Ok(LogConfigDto {
        effective_log_dir: effective.to_string_lossy().into_owned(),
        log_dir_override: settings.log.log_dir.clone(),
        default_log_dir: default_dir.to_string_lossy().into_owned(),
        max_file_size_bytes: settings.log.max_file_size_bytes,
        max_files: settings.log.max_files as u32,
        min_file_size_bytes: MIN_LOG_MAX_FILE_SIZE_BYTES,
        max_allowed_file_size_bytes: MAX_LOG_MAX_FILE_SIZE_BYTES,
        min_files: MIN_LOG_MAX_FILES as u32,
        max_allowed_files: MAX_LOG_MAX_FILES as u32,
    })
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "get_app_settings"), err(Debug))]
pub async fn get_app_settings(app: AppHandle) -> Result<AppSettingsDto, AppError> {
    Ok((&load(&app)).into())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "set_browser_executable"), err(Debug))]
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
#[tracing::instrument(level = "info", skip_all, fields(cmd = "set_live_preview_enabled"), err(Debug))]
pub async fn set_live_preview_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    s.live_preview_enabled = enabled;
    save(&app, &s)?;
    Ok((&s).into())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "get_log_config"), err(Debug))]
pub async fn get_log_config(app: AppHandle) -> Result<LogConfigDto, AppError> {
    let s = load(&app);
    build_log_config_dto(&app, &s)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "set_log_config"), err(Debug))]
pub async fn set_log_config(
    app: AppHandle,
    config: LogConfigUpdate,
) -> Result<LogConfigDto, AppError> {
    let mut s = load(&app);
    s.log = LogConfig {
        log_dir: config.log_dir.filter(|p| !p.trim().is_empty()),
        max_file_size_bytes: config.max_file_size_bytes,
        max_files: config.max_files as usize,
    }
    .clamped();

    // If the user supplied a custom directory, surface a clear error early
    // rather than waiting until the next boot to discover it can't be
    // created. Defer creation to logging::init() in normal flow.
    if let Some(dir) = s.log.log_dir.as_ref() {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path).map_err(|e| {
            AppError::InvalidArgument(format!(
                "log_dir {} is not writable: {}",
                path.display(),
                e
            ))
        })?;
    }

    save(&app, &s)?;
    build_log_config_dto(&app, &s)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "open_log_dir"), err(Debug))]
pub async fn open_log_dir(app: AppHandle) -> Result<String, AppError> {
    use tauri_plugin_opener::OpenerExt;

    let s = load(&app);
    let default_dir = default_log_dir(&app)?;
    let effective = s.log.resolve_dir(&default_dir);
    std::fs::create_dir_all(&effective).map_err(AppError::from)?;
    let path_str = effective.to_string_lossy().into_owned();
    app.opener()
        .open_path(path_str.clone(), None::<&str>)
        .map_err(|e| AppError::Internal(format!("open log dir: {e}")))?;
    Ok(path_str)
}
