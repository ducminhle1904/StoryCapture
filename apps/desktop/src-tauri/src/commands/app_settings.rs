//! Lightweight JSON-backed app settings.
//!
//! Stored at `{app_config_dir}/app_settings.json`. Intentionally not using
//! `tauri-plugin-store` — this is a single small struct and avoiding the
//! plugin dep keeps the settings read path sync-safe (mutated on a UI thread
//! before `launch_automation` sets its env var).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub const DEFAULT_LOG_MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
pub const DEFAULT_LOG_MAX_FILES: usize = 10;
pub const MIN_LOG_MAX_FILE_SIZE_BYTES: u64 = 64 * 1024;
pub const MAX_LOG_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MIN_LOG_MAX_FILES: usize = 1;
pub const MAX_LOG_MAX_FILES: usize = 100;
pub const DEFAULT_AUTOSAVE_INTERVAL_SEC: u32 = 5;
pub const MIN_AUTOSAVE_INTERVAL_SEC: u32 = 2;
pub const MAX_AUTOSAVE_INTERVAL_SEC: u32 = 60;
pub const DEFAULT_PARALLEL_RENDERS: u32 = 2;
pub const MIN_PARALLEL_RENDERS: u32 = 1;
pub const MAX_PARALLEL_RENDERS: u32 = 6;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupBehavior {
    Welcome,
    LastProject,
    NewStory,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AudioInputDefault {
    None,
    SystemDefault,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ColorProfile {
    SrgbRec709,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SettingsCategory {
    General,
    Capture,
    Render,
    Privacy,
    Updates,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct GeneralSettings {
    pub projects_folder: Option<String>,
    pub startup_behavior: StartupBehavior,
    pub autosave_enabled: bool,
    pub autosave_interval_sec: u32,
    pub dock_progress_badge: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            projects_folder: None,
            startup_behavior: StartupBehavior::LastProject,
            autosave_enabled: true,
            autosave_interval_sec: DEFAULT_AUTOSAVE_INTERVAL_SEC,
            dock_progress_badge: true,
        }
    }
}

impl GeneralSettings {
    fn clamped(mut self) -> Self {
        self.autosave_interval_sec = self
            .autosave_interval_sec
            .clamp(MIN_AUTOSAVE_INTERVAL_SEC, MAX_AUTOSAVE_INTERVAL_SEC);
        if let Some(folder) = self.projects_folder.as_ref() {
            if folder.trim().is_empty() {
                self.projects_folder = None;
            }
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct CaptureDefaults {
    pub capture_fps: u32,
    pub include_cursor_default: bool,
    pub audio_input_default: AudioInputDefault,
    pub color_profile: ColorProfile,
}

impl Default for CaptureDefaults {
    fn default() -> Self {
        Self {
            capture_fps: 60,
            include_cursor_default: false,
            audio_input_default: AudioInputDefault::None,
            color_profile: ColorProfile::SrgbRec709,
        }
    }
}

impl CaptureDefaults {
    fn clamped(mut self) -> Self {
        if !matches!(self.capture_fps, 24 | 30 | 60) {
            self.capture_fps = 60;
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct RenderDefaults {
    pub parallel_renders: u32,
}

impl Default for RenderDefaults {
    fn default() -> Self {
        Self {
            parallel_renders: DEFAULT_PARALLEL_RENDERS,
        }
    }
}

impl RenderDefaults {
    fn clamped(mut self) -> Self {
        self.parallel_renders = self
            .parallel_renders
            .clamp(MIN_PARALLEL_RENDERS, MAX_PARALLEL_RENDERS);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct PrivacySettings {
    pub crash_reports_enabled: bool,
    pub usage_analytics_enabled: bool,
    pub prompt_redaction_enabled: bool,
    pub diagnostic_bundle_enabled: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            crash_reports_enabled: false,
            usage_analytics_enabled: false,
            prompt_redaction_enabled: true,
            diagnostic_bundle_enabled: true,
        }
    }
}

impl PrivacySettings {
    fn normalized(mut self) -> Self {
        // StoryCapture remains local-only; these cannot be enabled until a
        // future explicit upload/consent system exists.
        self.crash_reports_enabled = false;
        self.usage_analytics_enabled = false;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct UpdateSettings {
    pub check_updates_on_launch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct AppSettingsUpdate {
    pub general: GeneralSettings,
    pub capture: CaptureDefaults,
    pub render: RenderDefaults,
    pub privacy: PrivacySettings,
    pub updates: UpdateSettings,
}

impl Default for AppSettingsUpdate {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            capture: CaptureDefaults::default(),
            render: RenderDefaults::default(),
            privacy: PrivacySettings::default(),
            updates: UpdateSettings::default(),
        }
    }
}

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
    /// Fixed-list browser language preference. None/system preserves default browser behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_language: Option<String>,
    pub general: GeneralSettings,
    pub capture_defaults: CaptureDefaults,
    pub render_defaults: RenderDefaults,
    pub privacy: PrivacySettings,
    pub updates: UpdateSettings,
    /// User-configurable file logging policy.
    pub log: LogConfig,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            browser_executable: None,
            capture_target: None,
            browser_language: None,
            general: GeneralSettings::default(),
            capture_defaults: CaptureDefaults::default(),
            render_defaults: RenderDefaults::default(),
            privacy: PrivacySettings::default(),
            updates: UpdateSettings::default(),
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
    pub browser_language: String,
    pub general: GeneralSettings,
    pub capture: CaptureDefaults,
    pub render: RenderDefaults,
    pub privacy: PrivacySettings,
    pub updates: UpdateSettings,
    pub default_projects_folder: String,
    pub dock_progress_badge_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BrowserLanguageOptionDto {
    pub value: String,
    pub label: String,
}

impl Default for AppSettingsDto {
    fn default() -> Self {
        Self {
            browser_executable: None,
            browser_language: automation::BROWSER_LANGUAGE_SYSTEM.to_string(),
            general: GeneralSettings::default(),
            capture: CaptureDefaults::default(),
            render: RenderDefaults::default(),
            privacy: PrivacySettings::default(),
            updates: UpdateSettings::default(),
            default_projects_folder: String::new(),
            dock_progress_badge_supported: cfg!(target_os = "macos"),
        }
    }
}

impl AppSettings {
    pub fn normalized(mut self) -> Self {
        self.browser_language = normalize_browser_language(self.browser_language);
        self.general = self.general.clamped();
        self.capture_defaults = self.capture_defaults.clamped();
        self.render_defaults = self.render_defaults.clamped();
        self.privacy = self.privacy.normalized();
        self.log = self.log.clamped();
        self
    }
}

fn default_projects_folder(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .map(|dir| dir.join("StoryCapture"))
        .or_else(|_| app.path().home_dir().map(|dir| dir.join("StoryCapture")))
        .unwrap_or_else(|_| PathBuf::from("StoryCapture"))
}

fn build_app_settings_dto(app: &AppHandle, s: &AppSettings) -> AppSettingsDto {
    let default_projects_folder = default_projects_folder(app).to_string_lossy().into_owned();
    AppSettingsDto {
        browser_executable: s.browser_executable.clone(),
        browser_language: s
            .browser_language
            .clone()
            .unwrap_or_else(|| automation::BROWSER_LANGUAGE_SYSTEM.to_string()),
        general: s.general.clone(),
        capture: s.capture_defaults.clone(),
        render: s.render_defaults.clone(),
        privacy: s.privacy.clone(),
        updates: s.updates.clone(),
        default_projects_folder,
        dock_progress_badge_supported: cfg!(target_os = "macos"),
    }
}

impl From<&AppSettings> for AppSettingsUpdate {
    fn from(s: &AppSettings) -> Self {
        Self {
            general: s.general.clone(),
            capture: s.capture_defaults.clone(),
            render: s.render_defaults.clone(),
            privacy: s.privacy.clone(),
            updates: s.updates.clone(),
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

fn normalize_browser_language(value: Option<String>) -> Option<String> {
    match value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        None | Some(automation::BROWSER_LANGUAGE_SYSTEM) => None,
        Some(locale) if automation::is_supported_browser_locale(locale) => Some(locale.to_string()),
        Some(locale) => {
            tracing::warn!(
                target: "storycapture::settings",
                locale,
                "unsupported browser_language setting; using system default"
            );
            None
        }
    }
}

pub fn browser_language_choice(settings: &AppSettings) -> automation::BrowserLanguageChoice {
    automation::BrowserLanguageChoice::from_setting(settings.browser_language.as_deref())
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
    let s: AppSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    s.normalized()
}

/// Load settings from a known config directory without an `AppHandle` — used
/// during early boot before the Tauri runtime is fully alive (the
/// `tauri-plugin-log` builder needs the values before `setup()` runs).
pub fn load_from_config_dir(config_dir: &Path) -> AppSettings {
    let path = settings_path_from_config_dir(config_dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return AppSettings::default();
    };
    let s: AppSettings = serde_json::from_slice(&bytes).unwrap_or_default();
    s.normalized()
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
    let s = load(&app);
    Ok(build_app_settings_dto(&app, &s))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "set_app_settings"), err(Debug))]
pub async fn set_app_settings(
    app: AppHandle,
    update: AppSettingsUpdate,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    s.general = update.general.clamped();
    s.capture_defaults = update.capture.clamped();
    s.render_defaults = update.render.clamped();
    s.privacy = update.privacy.normalized();
    s.updates = update.updates;

    if let Some(folder) = s.general.projects_folder.as_ref() {
        let path = PathBuf::from(folder);
        std::fs::create_dir_all(&path).map_err(|e| {
            AppError::InvalidArgument(format!(
                "projects_folder {} is not writable: {}",
                path.display(),
                e
            ))
        })?;
    }

    save(&app, &s)?;
    Ok(build_app_settings_dto(&app, &s))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "reset_app_settings_category"),
    err(Debug)
)]
pub async fn reset_app_settings_category(
    app: AppHandle,
    category: SettingsCategory,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    let defaults = AppSettings::default();
    match category {
        SettingsCategory::General => s.general = defaults.general,
        SettingsCategory::Capture => s.capture_defaults = defaults.capture_defaults,
        SettingsCategory::Render => s.render_defaults = defaults.render_defaults,
        SettingsCategory::Privacy => s.privacy = defaults.privacy,
        SettingsCategory::Updates => s.updates = defaults.updates,
        SettingsCategory::All => {
            s.general = defaults.general;
            s.capture_defaults = defaults.capture_defaults;
            s.render_defaults = defaults.render_defaults;
            s.privacy = defaults.privacy;
            s.updates = defaults.updates;
        }
    }
    save(&app, &s)?;
    Ok(build_app_settings_dto(&app, &s))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "get_browser_language_options"),
    err(Debug)
)]
pub async fn get_browser_language_options() -> Result<Vec<BrowserLanguageOptionDto>, AppError> {
    Ok(automation::BROWSER_LANGUAGE_OPTIONS
        .iter()
        .map(|option| BrowserLanguageOptionDto {
            value: option.value.to_string(),
            label: option.label.to_string(),
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "set_browser_executable"),
    err(Debug)
)]
pub async fn set_browser_executable(
    app: AppHandle,
    path: Option<String>,
) -> Result<AppSettingsDto, AppError> {
    let mut s = load(&app);
    s.browser_executable = path.filter(|p| !p.is_empty());
    save(&app, &s)?;
    Ok(build_app_settings_dto(&app, &s))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "set_browser_language"),
    err(Debug)
)]
pub async fn set_browser_language(
    app: AppHandle,
    language: String,
) -> Result<AppSettingsDto, AppError> {
    let trimmed = language.trim();
    if trimmed != automation::BROWSER_LANGUAGE_SYSTEM
        && !automation::is_supported_browser_locale(trimmed)
    {
        return Err(AppError::InvalidArgument(format!(
            "unsupported browser language: {trimmed}"
        )));
    }
    let mut s = load(&app);
    s.browser_language = normalize_browser_language(Some(trimmed.to_string()));
    save(&app, &s)?;
    Ok(build_app_settings_dto(&app, &s))
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
            AppError::InvalidArgument(format!("log_dir {} is not writable: {}", path.display(), e))
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DiagnosticBundleResult {
    pub path: String,
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "export_diagnostic_bundle"),
    err(Debug)
)]
pub async fn export_diagnostic_bundle(
    app: AppHandle,
    parent_dir: String,
) -> Result<DiagnosticBundleResult, AppError> {
    let settings = load(&app);
    if !settings.privacy.diagnostic_bundle_enabled {
        return Err(AppError::InvalidArgument(
            "diagnostic bundle export is disabled in privacy settings".into(),
        ));
    }

    let parent = PathBuf::from(parent_dir);
    std::fs::create_dir_all(&parent).map_err(AppError::from)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out_dir = parent.join(format!("storycapture-diagnostics-{stamp}"));
    std::fs::create_dir_all(&out_dir).map_err(AppError::from)?;

    let default_dir = default_log_dir(&app)?;
    let effective_log_dir = settings.log.resolve_dir(&default_dir);
    let logs_out = out_dir.join("logs");
    std::fs::create_dir_all(&logs_out).map_err(AppError::from)?;
    if let Ok(entries) = std::fs::read_dir(&effective_log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name() else {
                continue;
            };
            if path.is_file() {
                let _ = std::fs::copy(&path, logs_out.join(name));
            }
        }
    }

    let package = app.package_info();
    let manifest = serde_json::json!({
        "app": {
            "name": package.name,
            "version": package.version.to_string(),
        },
        "privacy": {
            "prompt_redaction_enabled": settings.privacy.prompt_redaction_enabled,
            "crash_reports_enabled": false,
            "usage_analytics_enabled": false,
        },
        "logs": {
            "source": effective_log_dir.to_string_lossy(),
        },
        "contents": [
            "logs",
            "manifest.json"
        ],
        "excluded": [
            "story source",
            "recordings",
            "project databases",
            "api keys"
        ]
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| AppError::Internal(format!("serialize diagnostic manifest: {e}")))?;
    std::fs::write(out_dir.join("manifest.json"), manifest_bytes).map_err(AppError::from)?;

    Ok(DiagnosticBundleResult {
        path: out_dir.to_string_lossy().into_owned(),
    })
}
