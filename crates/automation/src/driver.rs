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

/// Launch options threaded in from the host.
#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Optional browser executable override.
    pub browser_executable: Option<PathBuf>,
    /// Optional `http(s)` app URL used for chrome-hiding.
    pub app_url_for_hiding: Option<String>,
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
        args.push("--window-position=-32000,-32000".to_string());
        // --window-size is the OUTER window including Chromium chrome
        // (title bar + tab strip + URL bar). In chrome-hiding mode
        // (--app=<url>) chrome is absent so viewport maps 1:1. Otherwise
        // add CHROME_HEIGHT_PX so the rendered *content* matches the
        // requested viewport — otherwise viewport: 1920x1080 records at
        // 1920x1030 because the ~50 px of chrome eats into content area.
        // CHROME_HEIGHT_PX = title bar + tab strip + URL bar.
        // CHROME_BORDER_PX = 10 px window border on each side (x2) on
        // macOS Chromium — accounts for the 20 px width shortfall when
        // window.frame() reports 1900 for a 1920-requested window.
        const CHROME_HEIGHT_PX: u32 = 87;
        const CHROME_BORDER_PX: u32 = 20;
        let chrome_hidden = args.iter().any(|a| a.starts_with("--app="));
        let (window_w, window_h) = if chrome_hidden {
            (viewport.width, viewport.height)
        } else {
            (
                viewport.width + CHROME_BORDER_PX,
                viewport.height + CHROME_HEIGHT_PX,
            )
        };
        args.push(format!("--window-size={},{}", window_w, window_h));
        Self {
            url: meta.app.clone(),
            viewport,
            theme: meta.theme.unwrap_or(Theme::Auto),
            headless: false,
            base_url: meta.app.clone(),
            download_dir: std::env::temp_dir(),
            executable: opts.browser_executable.clone(),
            args,
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
    async fn wait_for(&self, target: &SelectorOrText, timeout_ms: u64) -> Result<()>;
    async fn assert_present(&self, target: &SelectorOrText) -> Result<()>;
    async fn screenshot(&self, name: &str, out_dir: &Path) -> Result<PathBuf>;

    // ---- introspection used by the SmartSelector + auto-wait modules ----
    async fn element_state(&self, sel: &ResolvedSelector) -> Result<ElementState>;
    async fn current_cursor_position(&self) -> Result<(i32, i32)>;

    /// Resolve a DSL target into a driver-specific [`ResolvedSelector`].
    /// All in-tree drivers delegate to [`crate::selector::SmartSelector`].
    /// Drivers MAY override to short-circuit (e.g. Playwright's locator
    /// engine already does intent-aware ranking).
    ///
    /// The default impl uses `crate::selector::resolve_via_smart` (a free
    /// fn) so the trait stays object-safe.
    async fn resolve_selector(
        &self,
        target: &SelectorOrText,
        action: ActionKind,
        timeout_ms: u64,
    ) -> Result<(ResolvedSelector, Vec<crate::events::AttemptLog>)>
    where
        Self: Sized,
    {
        crate::selector::resolve_via_smart(self, action, target, timeout_ms).await
    }

    /// Capability flags (D-14). Used by the executor to dispatch verbs.
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
            cfg.args.iter().any(|a| a == "--window-position=-32000,-32000"),
            "expected --window-position in {:?}",
            cfg.args
        );
        // No chrome-hiding → outer window must account for Chromium's
        // ~87 px of chrome so the rendered content matches the viewport.
        assert!(
            cfg.args.iter().any(|a| {
                a == &format!(
                    "--window-size={},{}",
                    cfg.viewport.width + 20,
                    cfg.viewport.height + 87
                )
            }),
            "expected --window-size compensating for chrome + borders in {:?}",
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
            "expected --app= in {:?}", cfg.args
        );
        // Chrome-hiding → window-size matches viewport 1:1 (no chrome
        // compensation since chrome is absent in --app= mode).
        assert!(
            cfg.args.iter().any(|a| {
                a == &format!("--window-size={},{}", cfg.viewport.width, cfg.viewport.height)
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
        // Only the unconditional off-screen window flags are allowed; no --app=.
        assert!(
            !cfg.args.iter().any(|a| a.starts_with("--app=")),
            "javascript: URL leaked into args: {:?}",
            cfg.args
        );
    }

    #[test]
    fn launch_config_serializes_args_as_array() {
        let mut cfg = LaunchConfig::default();
        cfg.args = vec!["--app=https://example.com".into()];
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"args\":[\"--app=https://example.com\"]"),
            "unexpected JSON: {json}");
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
