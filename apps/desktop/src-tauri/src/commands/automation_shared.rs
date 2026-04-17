// Plan 05-02: SharedPlaywrightDriver — a BrowserDriver adapter that delegates
// every verb to an `Arc<Mutex<PlaywrightSidecarDriver>>`. The wrapper lets
// a background probe task call `browser_process()` on the same driver
// instance the executor is driving, without forcing the executor to change
// its `Box<dyn BrowserDriver>` signature.
//
// The mutex cost is minimal in practice: the executor serializes verbs
// sequentially, and the probe task polls at 200ms granularity. Contention
// is negligible.

use automation::{
    BrowserDriver, CapabilitySet, ElementState, LaunchConfig, PlaywrightSidecarDriver,
    ResolvedSelector,
};
use async_trait::async_trait;
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
