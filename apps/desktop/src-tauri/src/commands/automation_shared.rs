// Plan 05-02: SharedPlaywrightDriver — a BrowserDriver adapter that delegates
// every verb to an `Arc<Mutex<PlaywrightSidecarDriver>>`. The wrapper lets
// a background probe task call `browser_process()` on the same driver
// instance the executor is driving, without forcing the executor to change
// its `Box<dyn BrowserDriver>` signature.
//
// The mutex cost is minimal in practice: the executor serializes verbs
// sequentially, and the probe task polls at 200ms granularity. Contention
// is negligible.
//
// SharedAuthorDriver (Phase 11-03+) — parallel adapter for the author-
// session path. Wraps `Arc<PlaywrightSidecarDriver>` directly (no outer
// Mutex) so `pick_element_start_author` (up to 60 s) does not serialize
// concurrent `author_dispatch_input` calls forwarding LivePreview canvas
// pointer events. Launch/close return an error because author sessions
// launch once at `start_author_preview` and never via this adapter.

use async_trait::async_trait;
use automation::{
    AutomationError, BrowserDriver, CapabilitySet, ElementState, LaunchConfig,
    PlaywrightSidecarDriver, ResolvedSelector,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::sync::Mutex;

pub struct SharedPlaywrightDriver {
    inner: Arc<Mutex<PlaywrightSidecarDriver>>,
}

impl SharedPlaywrightDriver {
    pub fn new(inner: Arc<Mutex<PlaywrightSidecarDriver>>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl BrowserDriver for SharedPlaywrightDriver {
    async fn launch(&mut self, config: LaunchConfig) -> automation::Result<()> {
        let mut d = self.inner.lock().await;
        d.launch(config).await
    }
    async fn close(&mut self) -> automation::Result<()> {
        let mut d = self.inner.lock().await;
        d.close().await
    }
    async fn goto(&self, url: &str) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.goto(url).await
    }
    async fn click(&self, sel: &ResolvedSelector) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.click(sel).await
    }
    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.type_text(sel, text).await
    }
    async fn scroll(&self, direction: ScrollDir, amount: Option<f32>) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.scroll(direction, amount).await
    }
    async fn hover(&self, sel: &ResolvedSelector) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.hover(sel).await
    }
    async fn drag(&self, from: &ResolvedSelector, to: &ResolvedSelector) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.drag(from, to).await
    }
    async fn select_option(&self, sel: &ResolvedSelector, value: &str) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.select_option(sel, value).await
    }
    async fn upload_file(&self, sel: &ResolvedSelector, path: &Path) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.upload_file(sel, path).await
    }
    async fn wait_ms(&self, ms: u64) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.wait_ms(ms).await
    }
    async fn wait_for(&self, target: &SelectorOrText, timeout_ms: u64) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.wait_for(target, timeout_ms).await
    }
    async fn assert_present(&self, target: &SelectorOrText) -> automation::Result<()> {
        let d = self.inner.lock().await;
        d.assert_present(target).await
    }
    async fn screenshot(&self, name: &str, out_dir: &Path) -> automation::Result<PathBuf> {
        let d = self.inner.lock().await;
        d.screenshot(name, out_dir).await
    }
    async fn element_state(&self, sel: &ResolvedSelector) -> automation::Result<ElementState> {
        let d = self.inner.lock().await;
        d.element_state(sel).await
    }
    async fn current_cursor_position(&self) -> automation::Result<(i32, i32)> {
        let d = self.inner.lock().await;
        d.current_cursor_position().await
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "playwright-shared"
    }
}

/// Phase 11-03+ — BrowserDriver adapter for the author-session path.
///
/// Unlike `SharedPlaywrightDriver` (recording path), this wraps
/// `Arc<PlaywrightSidecarDriver>` directly. The driver's `&self` methods
/// already use fine-grained interior locks (`stdin`, `pending`), so
/// concurrent callers — picker's long-lived `pick_element_start_author`,
/// simulator executor verbs, and LivePreview canvas `author_dispatch_input`
/// — don't serialize behind each other.
///
/// `launch`/`close` are unreachable in practice: author sessions launch at
/// `start_author_preview` and tear down at `stop_author_preview`. The
/// executor passes `already_launched=true` via `continue_run`. We return an
/// error loudly if anything ever calls them through this adapter.
pub struct SharedAuthorDriver {
    inner: Arc<PlaywrightSidecarDriver>,
}

impl SharedAuthorDriver {
    pub fn new(inner: Arc<PlaywrightSidecarDriver>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl BrowserDriver for SharedAuthorDriver {
    async fn launch(&mut self, _config: LaunchConfig) -> automation::Result<()> {
        Err(AutomationError::Protocol(
            "SharedAuthorDriver::launch unsupported — author sessions launch via start_author_preview".into(),
        ))
    }
    async fn close(&mut self) -> automation::Result<()> {
        Err(AutomationError::Protocol(
            "SharedAuthorDriver::close unsupported — author sessions close via stop_author_preview".into(),
        ))
    }
    async fn goto(&self, url: &str) -> automation::Result<()> {
        self.inner.goto(url).await
    }
    async fn click(&self, sel: &ResolvedSelector) -> automation::Result<()> {
        self.inner.click(sel).await
    }
    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> automation::Result<()> {
        self.inner.type_text(sel, text).await
    }
    async fn scroll(
        &self,
        direction: ScrollDir,
        amount: Option<f32>,
    ) -> automation::Result<()> {
        self.inner.scroll(direction, amount).await
    }
    async fn hover(&self, sel: &ResolvedSelector) -> automation::Result<()> {
        self.inner.hover(sel).await
    }
    async fn drag(
        &self,
        from: &ResolvedSelector,
        to: &ResolvedSelector,
    ) -> automation::Result<()> {
        self.inner.drag(from, to).await
    }
    async fn select_option(
        &self,
        sel: &ResolvedSelector,
        value: &str,
    ) -> automation::Result<()> {
        self.inner.select_option(sel, value).await
    }
    async fn upload_file(
        &self,
        sel: &ResolvedSelector,
        path: &Path,
    ) -> automation::Result<()> {
        self.inner.upload_file(sel, path).await
    }
    async fn wait_ms(&self, ms: u64) -> automation::Result<()> {
        self.inner.wait_ms(ms).await
    }
    async fn wait_for(
        &self,
        target: &SelectorOrText,
        timeout_ms: u64,
    ) -> automation::Result<()> {
        self.inner.wait_for(target, timeout_ms).await
    }
    async fn assert_present(&self, target: &SelectorOrText) -> automation::Result<()> {
        self.inner.assert_present(target).await
    }
    async fn screenshot(&self, name: &str, out_dir: &Path) -> automation::Result<PathBuf> {
        self.inner.screenshot(name, out_dir).await
    }
    async fn element_state(&self, sel: &ResolvedSelector) -> automation::Result<ElementState> {
        self.inner.element_state(sel).await
    }
    async fn current_cursor_position(&self) -> automation::Result<(i32, i32)> {
        self.inner.current_cursor_position().await
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "playwright-author-shared"
    }
}

