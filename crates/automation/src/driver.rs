//! `BrowserDriver` trait and related automation types.
//!
//! The executor routes verbs by `CapabilitySet`, falling back when needed.

use crate::error::Result;
use crate::events::SelectorStrategy;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use story_parser::{ScrollDir, SelectorOrText, Theme, Viewport};

// ---------- Launch config ----------

pub const BROWSER_LANGUAGE_SYSTEM: &str = "system";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserLanguageOption {
    pub value: &'static str,
    pub label: &'static str,
}

pub const BROWSER_LANGUAGE_OPTIONS: &[BrowserLanguageOption] = &[
    BrowserLanguageOption {
        value: BROWSER_LANGUAGE_SYSTEM,
        label: "System default",
    },
    BrowserLanguageOption {
        value: "en-US",
        label: "English (United States)",
    },
    BrowserLanguageOption {
        value: "en-GB",
        label: "English (United Kingdom)",
    },
    BrowserLanguageOption {
        value: "vi-VN",
        label: "Vietnamese",
    },
    BrowserLanguageOption {
        value: "ja-JP",
        label: "Japanese",
    },
    BrowserLanguageOption {
        value: "ko-KR",
        label: "Korean",
    },
    BrowserLanguageOption {
        value: "zh-CN",
        label: "Chinese (Simplified)",
    },
    BrowserLanguageOption {
        value: "zh-TW",
        label: "Chinese (Traditional)",
    },
    BrowserLanguageOption {
        value: "fr-FR",
        label: "French",
    },
    BrowserLanguageOption {
        value: "de-DE",
        label: "German",
    },
    BrowserLanguageOption {
        value: "es-ES",
        label: "Spanish",
    },
    BrowserLanguageOption {
        value: "pt-BR",
        label: "Portuguese (Brazil)",
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrowserLanguageChoice {
    System,
    Locale(String),
}

impl Default for BrowserLanguageChoice {
    fn default() -> Self {
        Self::System
    }
}

impl BrowserLanguageChoice {
    pub fn from_setting(value: Option<&str>) -> Self {
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            Some(BROWSER_LANGUAGE_SYSTEM) | None => Self::System,
            Some(locale) if is_supported_browser_locale(locale) => Self::Locale(locale.to_string()),
            Some(locale) => {
                tracing::warn!(
                    target: "automation::browser_environment",
                    locale,
                    "unsupported browser language setting; falling back to system default"
                );
                Self::System
            }
        }
    }

    pub fn browser_environment(&self) -> BrowserEnvironment {
        match self {
            Self::System => BrowserEnvironment::default(),
            Self::Locale(locale) => BrowserEnvironment {
                locale: Some(locale.clone()),
                timezone_id: None,
                accept_language: Some(accept_language_for_locale(locale)),
            },
        }
    }
}

pub fn is_supported_browser_locale(locale: &str) -> bool {
    BROWSER_LANGUAGE_OPTIONS
        .iter()
        .any(|option| option.value == locale && option.value != BROWSER_LANGUAGE_SYSTEM)
}

pub fn accept_language_for_locale(locale: &str) -> String {
    let base = locale.split('-').next().unwrap_or(locale);
    format!("{locale},{base};q=0.9,en-US;q=0.8,en;q=0.7")
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserEnvironment {
    pub locale: Option<String>,
    pub timezone_id: Option<String>,
    pub accept_language: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowserSessionProfile {
    pub environment: BrowserEnvironment,
    pub viewport: Option<Viewport>,
    pub theme: Option<Theme>,
    pub current_url: Option<String>,
    pub storage_state_json: Option<String>,
}

/// Launch options threaded in from the host.
#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Optional browser executable override.
    pub browser_executable: Option<PathBuf>,
    /// Optional `http(s)` app URL used for chrome-hiding.
    pub app_url_for_hiding: Option<String>,
    pub language_choice: BrowserLanguageChoice,
    pub browser_session_profile: Option<BrowserSessionProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchConfig {
    /// Initial URL.
    pub url: Option<String>,
    /// Browser viewport.
    pub viewport: Viewport,
    /// Color scheme emulation.
    pub theme: Theme,
    /// Headless mode.
    pub headless: bool,
    /// Base URL for relative navigation.
    pub base_url: Option<String>,
    /// Download directory.
    pub download_dir: PathBuf,
    /// Optional browser executable path.
    pub executable: Option<PathBuf>,
    /// Extra Chromium command-line args.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub browser_environment: BrowserEnvironment,
    #[serde(default)]
    pub storage_state_json: Option<String>,
}

impl LaunchConfig {
    /// Build a launch config from story metadata and host options.
    pub fn from_meta(meta: &story_parser::Meta, opts: &LaunchOptions) -> Self {
        let viewport = meta.viewport.unwrap_or(Viewport {
            width: 1280,
            height: 800,
        });
        let mut args = Vec::new();
        if let Some(url) = opts.app_url_for_hiding.as_deref() {
            // Defensive second check.
            if url.starts_with("http://") || url.starts_with("https://") {
                args.push(format!("--app={}", url));
            }
        }
        // Chrome's Translate bubble is browser UI, but it still renders over
        // app-mode windows and gets captured by SCK. Disable it for all
        // automation launches so recordings remain content-only.
        args.push("--disable-translate".to_string());
        args.push("--disable-features=Translate,TranslateUI".to_string());
        args.push("--window-position=-32000,-32000".to_string());
        // --window-size is a bootstrap hint only. In the shared
        // Playwright sidecar path we now verify the actual
        // `window.innerWidth/innerHeight` after launch and retry CDP
        // resizes until the page content matches the requested viewport.
        // Keep the bootstrap size near the target so the user does not
        // see a large visible resize before the verification loop settles.
        args.push(format!(
            "--window-size={},{}",
            viewport.width, viewport.height
        ));
        let mut browser_environment = opts.language_choice.browser_environment();
        let mut storage_state_json = None;
        if let Some(profile) = opts.browser_session_profile.as_ref() {
            if matches!(opts.language_choice, BrowserLanguageChoice::System) {
                browser_environment = profile.environment.clone();
            }
            storage_state_json = profile.storage_state_json.clone();
        }
        let redacted_args: Vec<String> = args
            .iter()
            .map(|arg| {
                if arg.starts_with("--app=") {
                    "--app=<redacted>".to_string()
                } else {
                    arg.clone()
                }
            })
            .collect();
        tracing::info!(
            target: "automation::browser_environment",
            app_mode_requested = args.iter().any(|arg| arg.starts_with("--app=")),
            translate_disabled = args.iter().any(|arg| arg == "--disable-translate"),
            viewport_width = viewport.width,
            viewport_height = viewport.height,
            chromium_args = ?redacted_args,
            locale = ?browser_environment.locale,
            "browser launch args prepared"
        );
        Self {
            url: meta.app.clone(),
            viewport,
            theme: meta.theme.unwrap_or(Theme::Auto),
            headless: false,
            base_url: meta.app.clone(),
            download_dir: std::env::temp_dir(),
            executable: opts.browser_executable.clone(),
            args,
            browser_environment,
            storage_state_json,
        }
    }
}

impl Default for LaunchConfig {
    fn default() -> Self {
        Self {
            url: None,
            viewport: Viewport {
                width: 1280,
                height: 800,
            },
            theme: Theme::Auto,
            headless: true,
            base_url: None,
            download_dir: std::env::temp_dir(),
            executable: None,
            args: Vec::new(),
            browser_environment: BrowserEnvironment::default(),
            storage_state_json: None,
        }
    }
}

// ---------- Capability flags ----------

/// Required-capability tags used for verb routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Capability {
    None,
    FileUpload,
    WaitForDownload,
    ShadowDomPiercing,
    OAuthPopup,
    NetworkIdle,
    Iframes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitySet {
    pub file_upload: bool,
    pub wait_for_download: bool,
    pub shadow_dom_click: bool,
    pub oauth_popup: bool,
    pub network_idle: bool,
    pub iframes: bool,
}

impl CapabilitySet {
    /// Basic DOM verbs only.
    pub const LIMITED: Self = Self {
        file_upload: false,
        wait_for_download: false,
        shadow_dom_click: false,
        oauth_popup: false,
        network_idle: false,
        iframes: true,
    };

    /// Full Playwright capability set.
    pub const PLAYWRIGHT: Self = Self {
        file_upload: true,
        wait_for_download: true,
        shadow_dom_click: true,
        oauth_popup: true,
        network_idle: true,
        iframes: true,
    };

    /// Check whether the set satisfies a capability.
    pub fn satisfies(&self, required: Capability) -> bool {
        match required {
            Capability::None => true,
            Capability::FileUpload => self.file_upload,
            Capability::WaitForDownload => self.wait_for_download,
            Capability::ShadowDomPiercing => self.shadow_dom_click,
            Capability::OAuthPopup => self.oauth_popup,
            Capability::NetworkIdle => self.network_idle,
            Capability::Iframes => self.iframes,
        }
    }
}

// ---------- Element state ----------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ElementState {
    pub visible: bool,
    pub bbox: Option<BoundingBox>,
    pub animating: bool,
    pub in_viewport: bool,
}

// ---------- Resolved selector handle ----------

/// Driver-agnostic selector handle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedSelector {
    pub strategy: SelectorStrategy,
    /// Selector string.
    pub value: String,
    /// Original DSL target.
    pub origin: SelectorOrText,
    /// Optional 1-indexed `nth` modifier. Drivers that support
    /// disambiguation by position chain `.nth(n - 1)` on top of the
    /// resolved locator. `None` preserves "any unique match" semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nth: Option<u32>,
}

// ---------- The trait ----------

/// Action kind used to bias selector ranking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Click,
    Type,
    Hover,
    Drag,
    Select,
    Upload,
    Assert,
    WaitFor,
}

/// Trait implemented by all browser drivers.
#[async_trait]
pub trait BrowserDriver: Send + Sync + 'static {
    // ---- lifecycle ----
    async fn launch(&mut self, config: LaunchConfig) -> Result<()>;
    async fn close(&mut self) -> Result<()>;

    // ---- navigation ----
    async fn goto(&self, url: &str) -> Result<()>;

    // ---- actions (each must be wrapped in auto-wait by the executor) ----
    async fn click(&self, sel: &ResolvedSelector) -> Result<()>;
    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> Result<()>;
    async fn scroll(&self, direction: ScrollDir, amount: Option<f32>) -> Result<()>;
    async fn hover(&self, sel: &ResolvedSelector) -> Result<()>;
    async fn drag(&self, from: &ResolvedSelector, to: &ResolvedSelector) -> Result<()>;
    async fn select_option(&self, sel: &ResolvedSelector, value: &str) -> Result<()>;
    async fn upload_file(&self, sel: &ResolvedSelector, path: &Path) -> Result<()>;
    async fn wait_ms(&self, ms: u64) -> Result<()>;
    /// `target_nth` is the optional 1-indexed `nth` modifier. Drivers
    /// chain `.nth(n - 1)` on top of the resolved locator when `Some`.
    /// `None` preserves "any unique match" semantics.
    async fn wait_for(
        &self,
        target: &SelectorOrText,
        target_nth: Option<u32>,
        timeout_ms: u64,
    ) -> Result<()>;
    /// See [`Self::wait_for`] for the `target_nth` contract.
    async fn assert_present(&self, target: &SelectorOrText, target_nth: Option<u32>) -> Result<()>;
    async fn screenshot(&self, name: &str, out_dir: &Path) -> Result<PathBuf>;

    // ---- introspection used by the SmartSelector + auto-wait modules ----
    async fn element_state(&self, sel: &ResolvedSelector) -> Result<ElementState>;
    async fn current_cursor_position(&self) -> Result<(i32, i32)>;

    /// Resolve a DSL target into a driver-specific [`ResolvedSelector`].
    /// All in-tree drivers delegate to [`crate::selector::SmartSelector`].
    /// Drivers MAY override to short-circuit (e.g. Playwright's locator
    /// engine already does intent-aware ranking).
    ///
    /// `target_nth` is the optional 1-indexed `nth` modifier from the DSL.
    /// The default impl stamps it onto the returned `ResolvedSelector` so
    /// drivers chain `.nth(n - 1)` at execution.
    ///
    /// The default impl uses `crate::selector::resolve_via_smart` (a free
    /// fn) so the trait stays object-safe.
    async fn resolve_selector(
        &self,
        target: &SelectorOrText,
        target_nth: Option<u32>,
        action: ActionKind,
        timeout_ms: u64,
    ) -> Result<(ResolvedSelector, Vec<crate::events::AttemptLog>)>
    where
        Self: Sized,
    {
        crate::selector::resolve_via_smart(self, action, target, target_nth, timeout_ms).await
    }

    /// Capability flags. Used by the executor to dispatch verbs.
    fn capabilities(&self) -> CapabilitySet;

    /// Human-readable driver name for logs + `StepStarted.driver_used`.
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod launch_config_tests {
    use super::*;
    use story_parser::Meta;

    fn meta_with_app(url: Option<&str>) -> Meta {
        let mut m = Meta::default();
        m.app = url.map(String::from);
        m
    }

    #[test]
    fn default_has_empty_args_vec() {
        let c = LaunchConfig::default();
        assert!(c.args.is_empty());
    }

    #[test]
    fn from_meta_always_includes_offscreen_window_flags() {
        let cfg = LaunchConfig::from_meta(
            &meta_with_app(Some("https://example.com")),
            &LaunchOptions::default(),
        );
        assert!(
            cfg.args
                .iter()
                .any(|a| a == "--window-position=-32000,-32000"),
            "expected --window-position in {:?}",
            cfg.args
        );
        assert!(
            cfg.args.iter().any(|a| a == "--disable-translate"),
            "expected translate UI disabled in {:?}",
            cfg.args
        );
        assert!(
            cfg.args
                .iter()
                .any(|a| a == "--disable-features=Translate,TranslateUI"),
            "expected translate feature disabled in {:?}",
            cfg.args
        );
        // Non chrome-hiding still bootstraps with the requested viewport;
        // the sidecar performs the authoritative post-launch content fit.
        assert!(
            cfg.args.iter().any(|a| {
                a == &format!(
                    "--window-size={},{}",
                    cfg.viewport.width, cfg.viewport.height
                )
            }),
            "expected bootstrap --window-size matching viewport in {:?}",
            cfg.args
        );
        // Chrome-hiding flag only appears when the host opts in.
        assert!(
            !cfg.args.iter().any(|a| a.starts_with("--app=")),
            "--app= must not appear without chrome-hiding opt-in: {:?}",
            cfg.args
        );
    }

    #[test]
    fn from_meta_with_chrome_hiding_appends_app_arg() {
        let opts = LaunchOptions {
            app_url_for_hiding: Some("https://demo.com".into()),
            ..Default::default()
        };
        let cfg = LaunchConfig::from_meta(&meta_with_app(Some("https://demo.com")), &opts);
        assert!(
            cfg.args.iter().any(|a| a == "--app=https://demo.com"),
            "expected --app= in {:?}",
            cfg.args
        );
        // Chrome-hiding → window-size matches viewport 1:1 (no chrome
        // compensation since chrome is absent in --app= mode).
        assert!(
            cfg.args.iter().any(|a| {
                a == &format!(
                    "--window-size={},{}",
                    cfg.viewport.width, cfg.viewport.height
                )
            }),
            "expected 1:1 --window-size under chrome-hiding in {:?}",
            cfg.args
        );
    }

    #[test]
    fn from_meta_with_chrome_hiding_but_non_http_url_rejects() {
        // Defensive guard: even if the host misbehaves and forwards a
        // non-http(s) URL, `from_meta` must drop it.
        let opts = LaunchOptions {
            app_url_for_hiding: Some("javascript:alert(1)".into()),
            ..Default::default()
        };
        let cfg = LaunchConfig::from_meta(&meta_with_app(Some("javascript:alert(1)")), &opts);
        // Only unconditional browser hygiene/window flags are allowed; no --app=.
        assert!(
            !cfg.args.iter().any(|a| a.starts_with("--app=")),
            "javascript: URL leaked into args: {:?}",
            cfg.args
        );
    }

    #[test]
    fn language_choice_system_builds_empty_environment() {
        assert_eq!(
            BrowserLanguageChoice::System.browser_environment(),
            BrowserEnvironment::default()
        );
    }

    #[test]
    fn language_choice_locale_builds_locale_and_accept_language() {
        let env = BrowserLanguageChoice::Locale("vi-VN".into()).browser_environment();
        assert_eq!(env.locale.as_deref(), Some("vi-VN"));
        assert_eq!(
            env.accept_language.as_deref(),
            Some("vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7")
        );
        assert_eq!(env.timezone_id, None);
    }

    #[test]
    fn from_meta_system_carries_profile_environment_and_storage_state() {
        let opts = LaunchOptions {
            language_choice: BrowserLanguageChoice::System,
            browser_session_profile: Some(BrowserSessionProfile {
                environment: BrowserEnvironment {
                    locale: Some("ja-JP".into()),
                    timezone_id: Some("Asia/Tokyo".into()),
                    accept_language: Some("ja-JP,ja;q=0.9".into()),
                },
                storage_state_json: Some("{\"cookies\":[],\"origins\":[]}".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let cfg = LaunchConfig::from_meta(&meta_with_app(Some("https://demo.com")), &opts);
        assert_eq!(cfg.browser_environment.locale.as_deref(), Some("ja-JP"));
        assert_eq!(
            cfg.browser_environment.timezone_id.as_deref(),
            Some("Asia/Tokyo")
        );
        assert_eq!(
            cfg.storage_state_json.as_deref(),
            Some("{\"cookies\":[],\"origins\":[]}")
        );
    }

    #[test]
    fn from_meta_explicit_language_overrides_profile_environment() {
        let opts = LaunchOptions {
            language_choice: BrowserLanguageChoice::Locale("vi-VN".into()),
            browser_session_profile: Some(BrowserSessionProfile {
                environment: BrowserEnvironment {
                    locale: Some("ja-JP".into()),
                    timezone_id: Some("Asia/Tokyo".into()),
                    accept_language: Some("ja-JP,ja;q=0.9".into()),
                },
                storage_state_json: Some("{\"cookies\":[],\"origins\":[]}".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let cfg = LaunchConfig::from_meta(&meta_with_app(Some("https://demo.com")), &opts);
        assert_eq!(cfg.browser_environment.locale.as_deref(), Some("vi-VN"));
        assert_eq!(
            cfg.browser_environment.accept_language.as_deref(),
            Some("vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7")
        );
        assert_eq!(cfg.browser_environment.timezone_id, None);
        assert!(cfg.storage_state_json.is_some());
    }

    #[test]
    fn from_meta_keeps_story_viewport_authoritative_when_profile_has_viewport() {
        let mut meta = meta_with_app(Some("https://demo.com"));
        meta.viewport = Some(Viewport {
            width: 1920,
            height: 1080,
        });
        let opts = LaunchOptions {
            browser_session_profile: Some(BrowserSessionProfile {
                viewport: Some(Viewport {
                    width: 375,
                    height: 812,
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let cfg = LaunchConfig::from_meta(&meta, &opts);
        assert_eq!(cfg.viewport.width, 1920);
        assert_eq!(cfg.viewport.height, 1080);
    }

    #[test]
    fn launch_config_serializes_args_as_array() {
        let mut cfg = LaunchConfig::default();
        cfg.args = vec!["--app=https://example.com".into()];
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(
            json.contains("\"args\":[\"--app=https://example.com\"]"),
            "unexpected JSON: {json}"
        );
    }

    #[test]
    fn launch_config_deserializes_without_args_field() {
        // Backwards compat: pre-06-02 payloads don't send `args`.
        let json = r#"{
            "url": null,
            "viewport": { "width": 1280, "height": 800 },
            "theme": "auto",
            "headless": true,
            "base_url": null,
            "download_dir": "/tmp",
            "executable": null
        }"#;
        let cfg: LaunchConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.args.is_empty());
    }
}
