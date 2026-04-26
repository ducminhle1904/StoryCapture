//! `NoopDriver` — a fallback stub used when a real fallback driver isn't
//! needed (Playwright-only prototype path). All action methods return an
//! `Unavailable` error; its `launch()` is a silent no-op so the executor's
//! double-launch loop doesn't open a second browser window.
//!
//! `capabilities()` reports an all-false set so the executor's capability
//! router always prefers the primary driver.

use crate::driver::{BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector};
use crate::error::{AutomationError, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use story_parser::{ScrollDir, SelectorOrText};

#[derive(Default)]
pub struct NoopDriver;

impl NoopDriver {
    pub fn new() -> Self {
        Self
    }
    fn unavailable<T>() -> Result<T> {
        Err(AutomationError::DriverUnavailable(
            "noop driver invoked — this should never happen".into(),
        ))
    }
}

#[async_trait]
impl BrowserDriver for NoopDriver {
    async fn launch(&mut self, _config: LaunchConfig) -> Result<()> {
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        Ok(())
    }
    async fn goto(&self, _url: &str) -> Result<()> {
        Self::unavailable()
    }
    async fn click(&self, _s: &ResolvedSelector) -> Result<()> {
        Self::unavailable()
    }
    async fn type_text(&self, _s: &ResolvedSelector, _t: &str) -> Result<()> {
        Self::unavailable()
    }
    async fn scroll(&self, _d: ScrollDir, _a: Option<f32>) -> Result<()> {
        Self::unavailable()
    }
    async fn hover(&self, _s: &ResolvedSelector) -> Result<()> {
        Self::unavailable()
    }
    async fn drag(&self, _f: &ResolvedSelector, _t: &ResolvedSelector) -> Result<()> {
        Self::unavailable()
    }
    async fn select_option(&self, _s: &ResolvedSelector, _v: &str) -> Result<()> {
        Self::unavailable()
    }
    async fn upload_file(&self, _s: &ResolvedSelector, _p: &Path) -> Result<()> {
        Self::unavailable()
    }
    async fn wait_ms(&self, _ms: u64) -> Result<()> {
        Self::unavailable()
    }
    async fn wait_for(
        &self,
        _t: &SelectorOrText,
        _nth: Option<u32>,
        _ms: u64,
    ) -> Result<()> {
        Self::unavailable()
    }
    async fn assert_present(
        &self,
        _t: &SelectorOrText,
        _nth: Option<u32>,
    ) -> Result<()> {
        Self::unavailable()
    }
    async fn screenshot(&self, _n: &str, _d: &Path) -> Result<PathBuf> {
        Self::unavailable()
    }
    async fn element_state(&self, _s: &ResolvedSelector) -> Result<ElementState> {
        Self::unavailable()
    }
    async fn current_cursor_position(&self) -> Result<(i32, i32)> {
        Self::unavailable()
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet {
            file_upload: false,
            wait_for_download: false,
            shadow_dom_click: false,
            oauth_popup: false,
            network_idle: false,
            iframes: false,
        }
    }
    fn name(&self) -> &'static str {
        "noop"
    }
}
