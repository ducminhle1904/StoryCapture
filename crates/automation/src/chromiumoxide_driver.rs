//! `ChromiumoxideDriver` — primary in-process CDP driver (D-11).
//!
//! Wraps [`chromiumoxide::Browser`] (pinned `=0.7.0`). Designed for the
//! 90 % case (plain navigation, click, type, scroll, hover, drag, assert,
//! screenshot). Verbs flagged in [`crate::CapabilitySet::CHROMIUMOXIDE`] as
//! `false` (file_upload, wait_for_download, shadow_dom_click, oauth_popup,
//! network_idle) are routed to the [`crate::PlaywrightSidecarDriver`] by
//! the executor — never executed here.
//!
//! **Phase 1 status:** the trait surface compiles against chromiumoxide 0.7
//! and the `launch` / `goto` / `screenshot` paths exercise real CDP. The
//! deeper auto-wait introspection (CDP `DOM.getBoxModel`,
//! `Animation.getAnimations`) is wired through `element_state` to a minimal
//! "visible + bbox via `Page::find_element` + getBoundingClientRect via
//! `evaluate`" call so the auto-wait module has something real to poll. The
//! full CDP coverage is iterated in Phase 1 follow-up tasks (verb-coverage
//! spike — see STATE.md Open Todos). Real-browser tests are gated behind
//! the `real-browser-tests` feature flag so CI without Chromium passes.

use crate::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use crate::error::{AutomationError, Result};
use async_trait::async_trait;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::Page;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::sync::Mutex;

pub struct ChromiumoxideDriver {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    browser: Option<Browser>,
    page: Option<Page>,
    base_url: Option<String>,
    config: Option<LaunchConfig>,
}

impl Default for ChromiumoxideDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl ChromiumoxideDriver {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    fn map_err<E: std::fmt::Display>(e: E) -> AutomationError {
        AutomationError::Browser(e.to_string())
    }

    async fn page(&self) -> Result<Page> {
        let guard = self.inner.lock().await;
        guard
            .page
            .as_ref()
            .cloned()
            .ok_or_else(|| AutomationError::DriverUnavailable("chromium page not launched".into()))
    }

    /// Resolve a `ResolvedSelector` into a CSS selector chromiumoxide can
    /// pass to `Page::find_element`. The SmartSelector emitted strategy-
    /// prefixed values; here we map them back to a CSS query.
    ///
    /// For Phase 1, ranked text strategies fall back to `*:contains(...)`-
    /// style approximations via XPath. The full accessible-name tree walk
    /// is a Phase 1 follow-up (see STATE.md verb-coverage spike).
    fn to_css(sel: &ResolvedSelector) -> String {
        use crate::events::SelectorStrategy::*;
        match sel.strategy {
            Css | TestId | Aria => sel.value.clone(),
            // Strip the synth-prefix. Drivers consume the trailing literal.
            AccessibleName => sel
                .value
                .strip_prefix("aria-name=")
                .map(|s| format!("[aria-label=\"{s}\"], [aria-labelledby=\"{s}\"]"))
                .unwrap_or_else(|| sel.value.clone()),
            VisibleText => sel
                .value
                .strip_prefix("text=")
                .map(|s| format!("//*[normalize-space(text())=\"{s}\"]"))
                .unwrap_or_else(|| sel.value.clone()),
            LabelAssoc => sel
                .value
                .strip_prefix("label=")
                .map(|s| format!("//label[normalize-space(text())=\"{s}\"]/following::*[self::input or self::textarea or self::select][1]"))
                .unwrap_or_else(|| sel.value.clone()),
            FuzzyText => sel
                .value
                .strip_prefix("text~=")
                .map(|s| format!("//*[contains(normalize-space(text()),\"{s}\")]"))
                .unwrap_or_else(|| sel.value.clone()),
        }
    }
}

#[async_trait]
impl BrowserDriver for ChromiumoxideDriver {
    async fn launch(&mut self, config: LaunchConfig) -> Result<()> {
        let mut bcfg = BrowserConfig::builder();
        if config.headless {
            // chromiumoxide 0.7 default is headless; explicit for clarity.
            bcfg = bcfg.with_head().with_head().disable_default_args(); // no-op chain; placeholder
        }
        // Viewport
        bcfg = bcfg.viewport(Some(chromiumoxide::handler::viewport::Viewport {
            width: config.viewport.width,
            height: config.viewport.height,
            device_scale_factor: None,
            emulating_mobile: false,
            is_landscape: false,
            has_touch: false,
        }));

        let cfg = bcfg.build().map_err(Self::map_err)?;
        let (browser, mut handler) = Browser::launch(cfg).await.map_err(Self::map_err)?;

        // Spawn the CDP event handler driver task. Required by chromiumoxide
        // 0.7+ (the Browser is a thin handle; the handler owns the websocket).
        tokio::spawn(async move {
            while let Some(_evt) = futures::StreamExt::next(&mut handler).await {
                // Phase 1: discard handler events. Phase 2 surfaces them
                // for download interception and console capture.
            }
        });

        let page = browser
            .new_page("about:blank")
            .await
            .map_err(Self::map_err)?;

        let mut guard = self.inner.lock().await;
        guard.browser = Some(browser);
        guard.page = Some(page);
        guard.base_url = config.base_url.clone();
        guard.config = Some(config);
        Ok(())
    }

    async fn close(&mut self) -> Result<()> {
        let mut guard = self.inner.lock().await;
        guard.page = None;
        if let Some(mut b) = guard.browser.take() {
            let _ = b.close().await;
        }
        Ok(())
    }

    async fn goto(&self, url: &str) -> Result<()> {
        let page = self.page().await?;
        let absolute = {
            let guard = self.inner.lock().await;
            join_base_url(guard.base_url.as_deref(), url)
        };
        page.goto(&absolute).await.map_err(Self::map_err)?;
        page.wait_for_navigation().await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn click(&self, sel: &ResolvedSelector) -> Result<()> {
        let page = self.page().await?;
        let css = Self::to_css(sel);
        let element = page.find_element(css).await.map_err(Self::map_err)?;
        element.click().await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> Result<()> {
        let page = self.page().await?;
        let css = Self::to_css(sel);
        let element = page.find_element(css).await.map_err(Self::map_err)?;
        element.type_str(text).await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn scroll(&self, direction: ScrollDir, amount: Option<f32>) -> Result<()> {
        let page = self.page().await?;
        let dy = match (direction, amount.unwrap_or(400.0)) {
            (ScrollDir::Down, n) => (0.0, n as f64),
            (ScrollDir::Up, n) => (0.0, -(n as f64)),
            (ScrollDir::Right, n) => (n as f64, 0.0),
            (ScrollDir::Left, n) => (-(n as f64), 0.0),
        };
        let js = format!("window.scrollBy({}, {})", dy.0, dy.1);
        page.evaluate(js).await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn hover(&self, sel: &ResolvedSelector) -> Result<()> {
        let page = self.page().await?;
        let css = Self::to_css(sel);
        let element = page.find_element(css).await.map_err(Self::map_err)?;
        element.hover().await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn drag(&self, _from: &ResolvedSelector, _to: &ResolvedSelector) -> Result<()> {
        // chromiumoxide drag emulation is patchy in 0.7; kept here as a
        // best-effort that the executor can route to Playwright via a
        // capability flag in a future revision (see STATE.md verb spike).
        Err(AutomationError::CapabilityMismatch {
            command: "drag".into(),
            driver: "chromiumoxide".into(),
            required: "DragGesture".into(),
        })
    }

    async fn select_option(&self, sel: &ResolvedSelector, value: &str) -> Result<()> {
        let page = self.page().await?;
        let css = Self::to_css(sel);
        let js = format!(
            "(() => {{ const el = document.querySelector({css:?}); if(!el) throw new Error('not found'); el.value = {value:?}; el.dispatchEvent(new Event('change', {{bubbles:true}})); }})()",
            css = css,
            value = value
        );
        page.evaluate(js).await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn upload_file(&self, _sel: &ResolvedSelector, _path: &Path) -> Result<()> {
        // Routed to Playwright via capability flag — never executed here.
        Err(AutomationError::CapabilityMismatch {
            command: "upload".into(),
            driver: "chromiumoxide".into(),
            required: "FileUpload".into(),
        })
    }

    async fn wait_ms(&self, ms: u64) -> Result<()> {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(())
    }

    async fn wait_for(&self, target: &SelectorOrText, timeout_ms: u64) -> Result<()> {
        let page = self.page().await?;
        let css = match target {
            SelectorOrText::Selector(s) => s.clone(),
            SelectorOrText::TestId(s) => format!("[data-testid=\"{s}\"]"),
            SelectorOrText::Aria(s) => format!("[aria-label=\"{s}\"]"),
            SelectorOrText::Text(s) => format!("//*[contains(text(),\"{s}\")]"),
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            if page.find_element(css.clone()).await.is_ok() {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(AutomationError::Timeout {
                    context: format!("wait_for({css})"),
                    timeout_ms,
                });
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    async fn assert_present(&self, target: &SelectorOrText) -> Result<()> {
        self.wait_for(target, 1_000).await
    }

    async fn screenshot(&self, name: &str, out_dir: &Path) -> Result<PathBuf> {
        std::fs::create_dir_all(out_dir)?;
        let page = self.page().await?;
        let bytes = page
            .screenshot(chromiumoxide::page::ScreenshotParams::builder().build())
            .await
            .map_err(Self::map_err)?;
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, bytes)?;
        Ok(path)
    }

    async fn element_state(&self, sel: &ResolvedSelector) -> Result<ElementState> {
        let page = self.page().await?;
        let css = Self::to_css(sel);
        let js = format!(
            r#"(() => {{
                const el = document.querySelector({css:?});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const visible = style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0;
                const inViewport = rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
                const animating = el.getAnimations ? el.getAnimations().some(a => a.playState === 'running') : false;
                return {{ visible, inViewport, animating, x: rect.x, y: rect.y, w: rect.width, h: rect.height }};
            }})()"#,
            css = css
        );
        let value = page.evaluate(js).await.map_err(Self::map_err)?;
        let v = value
            .into_value::<serde_json::Value>()
            .map_err(Self::map_err)?;
        if v.is_null() {
            return Ok(ElementState {
                visible: false,
                bbox: None,
                animating: false,
                in_viewport: false,
            });
        }
        Ok(ElementState {
            visible: v["visible"].as_bool().unwrap_or(false),
            in_viewport: v["inViewport"].as_bool().unwrap_or(false),
            animating: v["animating"].as_bool().unwrap_or(false),
            bbox: Some(BoundingBox {
                x: v["x"].as_f64().unwrap_or(0.0),
                y: v["y"].as_f64().unwrap_or(0.0),
                w: v["w"].as_f64().unwrap_or(0.0),
                h: v["h"].as_f64().unwrap_or(0.0),
            }),
        })
    }

    async fn current_cursor_position(&self) -> Result<(i32, i32)> {
        // chromiumoxide doesn't expose mouse cursor coords; we track our
        // own in Phase 2 (cursor trail). For Phase 1 return (0,0) so the
        // recorder can stub.
        Ok((0, 0))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::CHROMIUMOXIDE
    }

    fn name(&self) -> &'static str {
        "chromiumoxide"
    }
}

fn join_base_url(base: Option<&str>, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") || target == "about:blank" {
        return target.to_string();
    }
    if let Some(base) = base {
        if let Ok(b) = url::Url::parse(base) {
            if let Ok(joined) = b.join(target) {
                return joined.to_string();
            }
        }
    }
    target.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_base_url_absolute_passes_through() {
        assert_eq!(
            join_base_url(Some("https://x.test"), "https://other.test/p"),
            "https://other.test/p"
        );
    }

    #[test]
    fn join_base_url_relative_is_resolved() {
        assert_eq!(
            join_base_url(Some("https://x.test"), "/login"),
            "https://x.test/login"
        );
    }

    #[test]
    fn capabilities_match_chromiumoxide_constant() {
        let d = ChromiumoxideDriver::new();
        assert_eq!(d.capabilities(), CapabilitySet::CHROMIUMOXIDE);
        assert!(!d.capabilities().file_upload);
        assert!(!d.capabilities().shadow_dom_click);
    }
}
