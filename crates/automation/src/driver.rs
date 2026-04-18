//! `BrowserDriver` trait — the abstraction every driver impl honors.
//!
//! Current impls:
//! - [`crate::PlaywrightSidecarDriver`] — primary, Node SEA bundled.
//! - [`crate::NoopDriver`] — stub fallback.
//!
//! The executor (`crate::executor`) dispatches per-verb based on
//! [`CapabilitySet`] flags (D-14): a verb that the primary lacks routes to
//! the fallback automatically.

use crate::error::Result;
use crate::events::SelectorStrategy;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use story_parser::{ScrollDir, SelectorOrText, Theme, Viewport};

// ---------- Launch config ----------

/// Options threaded from the Tauri host into [`LaunchConfig::from_meta`].
///
/// Plan 06 cleanup — replaces the previous env-var IPC
/// (`STORYCAPTURE_BROWSER_PATH`, `STORYCAPTURE_CHROME_HIDING`) which was
/// unsafe under Rust 1.80+ and racy across concurrent `launch_automation`
/// invocations. Callers construct this directly; the host validates
/// `app_url_for_hiding` with `url::Url` before passing it in.
#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Optional Chromium-family browser executable override. When `None`,
    /// Playwright uses its bundled Chromium.
    pub browser_executable: Option<PathBuf>,
    /// Pre-validated `http://` or `https://` URL — when `Some`, `--app=<url>`
    /// is appended to the Chromium launch args (D-09/D-10 chrome-hiding).
    /// The host is responsible for validating the scheme before passing
    /// it in (T-06-09); this crate does a defensive second check.
    pub app_url_for_hiding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchConfig {
    /// Optional initial URL (also derived from `meta.app` if absent).
    pub url: Option<String>,
    /// Browser viewport. Defaults to 1280x800 if `meta.viewport` absent.
    pub viewport: Viewport,
    /// Color scheme emulation.
    pub theme: Theme,
    /// Headless mode. CI defaults to `true`; recording sessions to `false`.
    pub headless: bool,
    /// Base URL for relative `navigate` paths (from `meta.app`).
    pub base_url: Option<String>,
    /// Where downloads land (project folder `assets/`).
    pub download_dir: PathBuf,
    /// Optional path to a Chromium-family browser executable (Chrome, Brave,
    /// Edge, Arc, etc.). When `None`, Playwright uses its bundled Chromium.
    /// Threaded from the Tauri host via [`LaunchOptions::browser_executable`].
    pub executable: Option<PathBuf>,
    /// Plan 06-02 — extra Chromium command-line args forwarded verbatim
    /// to `launchServer({ args })`. Used for chrome-hiding via
    /// `--app=<url>` (D-09/D-10) and future extension knobs. Default is
    /// empty; `#[serde(default)]` lets existing IPC call sites omit it.
    #[serde(default)]
    pub args: Vec<String>,
}

impl LaunchConfig {
    /// Build from a parsed [`story_parser::Meta`] block (AUTO-04) plus
    /// host-provided [`LaunchOptions`].
    ///
    /// Recording sessions need a visible browser window, so `headless`
    /// defaults to `false`. Tests/CI override via `LaunchConfig::default()`.
    ///
    /// Plan 06-02 / cleanup — when `opts.app_url_for_hiding` is `Some`
    /// AND the URL is `http(s)://`, `--app=<url>` is appended to `args`
    /// (D-09/D-10). The host validates the URL via `url::Url::parse` at
    /// the Tauri boundary (T-06-09) so injection attempts (`javascript:`,
    /// `data:`) never reach this code path; the defensive prefix check
    /// below is a belt-and-braces second guard.
    pub fn from_meta(meta: &story_parser::Meta, opts: &LaunchOptions) -> Self {
        let mut args = Vec::new();
        if let Some(url) = opts.app_url_for_hiding.as_deref() {
            // Defensive re-check: host already validated with url::Url
            // but a second guard costs nothing and documents intent.
            if url.starts_with("http://") || url.starts_with("https://") {
                args.push(format!("--app={}", url));
            }
        }
        Self {
            url: meta.app.clone(),
            viewport: meta.viewport.unwrap_or(Viewport {
                width: 1280,
                height: 800,
            }),
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

// ---------- Capability flags (D-14) ----------

/// One required-capability tag per verb. The executor maps a [`Command`] to
/// the capability it needs (see [`crate::capability::required_for`]) and
/// picks the driver whose [`CapabilitySet`] satisfies it.
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
    /// Limited capability set — a driver supporting only basic DOM verbs
    /// (click, type, navigate, scroll, hover, screenshot). Used by the
    /// capability-routing tests and as a reference for future thin drivers.
    pub const LIMITED: Self = Self {
        file_upload: false,
        wait_for_download: false,
        shadow_dom_click: false,
        oauth_popup: false,
        network_idle: false,
        iframes: true,
    };

    /// Playwright's capability matrix — all-true. Playwright is the
    /// hardened-coverage path.
    pub const PLAYWRIGHT: Self = Self {
        file_upload: true,
        wait_for_download: true,
        shadow_dom_click: true,
        oauth_popup: true,
        network_idle: true,
        iframes: true,
    };

    /// Does this set satisfy the requested capability?
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

// ---------- Element state used by the auto-wait module ----------

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

/// Driver-agnostic "the SmartSelector picked this" handle.
///
/// Each driver interprets the inner `value` per its own engine — chromiumoxide
/// runs CDP `DOM.querySelector`, the Playwright sidecar passes the value
/// through to the Node `page.locator(...)` call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedSelector {
    pub strategy: SelectorStrategy,
    /// CSS-style or XPath-style or text= prefix per `strategy`.
    pub value: String,
    /// Original DSL target (kept for diagnostics + persistence).
    pub origin: SelectorOrText,
}

// ---------- The trait ----------

/// Action coloring used by the SmartSelector to bias candidate ranking
/// (a `click` should prefer buttons; a `type` should prefer inputs).
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

/// The `BrowserDriver` trait.
///
/// Send + Sync so it can be `Box<dyn BrowserDriver>` in the executor's
/// state machine; `'static` so tokio tasks own them.
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
    fn from_meta_without_chrome_hiding_has_empty_args() {
        let cfg = LaunchConfig::from_meta(
            &meta_with_app(Some("https://example.com")),
            &LaunchOptions::default(),
        );
        assert!(cfg.args.is_empty());
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
        assert!(cfg.args.is_empty(), "javascript: URL leaked into args: {:?}", cfg.args);
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
