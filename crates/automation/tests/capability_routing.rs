//! Routing proof (browser-free).
//!
//! Two mock `BrowserDriver` doubles — `MockChromiumoxide` (capability
//! profile matches `CapabilitySet::LIMITED`) and `MockPlaywright`
//! (`CapabilitySet::PLAYWRIGHT`). Each records whether any of its action
//! methods was called via an `AtomicBool last_called`. Routing is
//! exercised through `Executor::pick_driver_for_cmd` (the executor's own
//! dispatch fn) so we test the production code path without standing up
//! the full executor task or a real browser.

use async_trait::async_trait;
use automation::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::Executor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use story_parser::{Command, ScrollDir, SelectorOrText, Span};

struct Mock {
    name_: &'static str,
    caps: CapabilitySet,
    pub last_called: Arc<AtomicBool>,
}

impl Mock {
    fn new(name: &'static str, caps: CapabilitySet) -> Self {
        Self {
            name_: name,
            caps,
            last_called: Arc::new(AtomicBool::new(false)),
        }
    }
    fn touch(&self) {
        self.last_called.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl BrowserDriver for Mock {
    async fn launch(&mut self, _: LaunchConfig) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn close(&mut self) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn goto(&self, _: &str) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn click(&self, _: &ResolvedSelector) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn type_text(&self, _: &ResolvedSelector, _: &str) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn scroll(&self, _: ScrollDir, _: Option<f32>) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn hover(&self, _: &ResolvedSelector) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn drag(&self, _: &ResolvedSelector, _: &ResolvedSelector) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn select_option(&self, _: &ResolvedSelector, _: &str) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn upload_file(&self, _: &ResolvedSelector, _: &Path) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn wait_ms(&self, _: u64) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn wait_for(
        &self,
        _: &SelectorOrText,
        _nth: Option<u32>,
        _: u64,
    ) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn assert_present(
        &self,
        _: &SelectorOrText,
        _nth: Option<u32>,
    ) -> automation::Result<()> {
        self.touch();
        Ok(())
    }
    async fn screenshot(&self, _: &str, out: &Path) -> automation::Result<PathBuf> {
        self.touch();
        Ok(out.to_path_buf())
    }
    async fn element_state(&self, _: &ResolvedSelector) -> automation::Result<ElementState> {
        Ok(ElementState {
            visible: true,
            in_viewport: true,
            animating: false,
            bbox: Some(BoundingBox {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            }),
        })
    }
    async fn current_cursor_position(&self) -> automation::Result<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        self.caps
    }
    fn name(&self) -> &'static str {
        self.name_
    }
}

fn upload_cmd() -> Command {
    Command::Upload {
        target: SelectorOrText::Selector("#f".into()),

        target_nth: None,
        path: "/tmp/x".into(),
        span: Span::empty(),
        step_id: None,
    }
}

fn plain_click_cmd() -> Command {
    Command::Click {
        target: SelectorOrText::Selector("#save".into()),

        target_nth: None,
        span: Span::empty(),
        step_id: None,
    }
}

fn shadow_dom_click_cmd() -> Command {
    Command::Click {
        target: SelectorOrText::Selector("div::shadow button".into()),

        target_nth: None,
        span: Span::empty(),
        step_id: None,
    }
}

fn wait_for_download_cmd() -> Command {
    Command::WaitFor {
        target: SelectorOrText::Text("download:report.pdf".into()),

        target_nth: None,
        timeout_ms: Some(2_000),
        span: Span::empty(),
        step_id: None,
    }
}

fn oauth_click_cmd() -> Command {
    Command::Click {
        target: SelectorOrText::Text("oauth:Sign in with Microsoft".into()),

        target_nth: None,
        span: Span::empty(),
        step_id: None,
    }
}

#[tokio::test]
async fn upload_routes_to_playwright() {
    let primary = Mock::new("limited", CapabilitySet::LIMITED);
    let fallback = Mock::new("playwright", CapabilitySet::PLAYWRIGHT);

    let chosen = Executor::pick_driver_for_cmd(&primary, &fallback, &upload_cmd());
    assert_eq!(chosen.name(), "playwright");

    // Drive the side-effect-checking call to the chosen driver and confirm
    // `last_called` flips on the right side.
    chosen
        .upload_file(
            &ResolvedSelector {
                strategy: automation::SelectorStrategy::Css,
                value: "#f".into(),
                origin: SelectorOrText::Selector("#f".into()),
                nth: None,
            },
            Path::new("/tmp/x"),
        )
        .await
        .unwrap();

    assert!(fallback.last_called.load(Ordering::SeqCst));
    assert!(!primary.last_called.load(Ordering::SeqCst));
}

#[tokio::test]
async fn plain_click_routes_to_limited_primary() {
    let primary = Mock::new("limited", CapabilitySet::LIMITED);
    let fallback = Mock::new("playwright", CapabilitySet::PLAYWRIGHT);

    let chosen = Executor::pick_driver_for_cmd(&primary, &fallback, &plain_click_cmd());
    assert_eq!(chosen.name(), "limited");

    chosen
        .click(&ResolvedSelector {
            strategy: automation::SelectorStrategy::Css,
            value: "#save".into(),
            origin: SelectorOrText::Selector("#save".into()),
            nth: None,
        })
        .await
        .unwrap();

    assert!(primary.last_called.load(Ordering::SeqCst));
    assert!(!fallback.last_called.load(Ordering::SeqCst));
}

#[tokio::test]
async fn shadow_dom_click_routes_to_playwright() {
    let primary = Mock::new("limited", CapabilitySet::LIMITED);
    let fallback = Mock::new("playwright", CapabilitySet::PLAYWRIGHT);

    let chosen = Executor::pick_driver_for_cmd(&primary, &fallback, &shadow_dom_click_cmd());
    assert_eq!(chosen.name(), "playwright");
}

#[tokio::test]
async fn wait_for_download_routes_to_playwright() {
    let primary = Mock::new("limited", CapabilitySet::LIMITED);
    let fallback = Mock::new("playwright", CapabilitySet::PLAYWRIGHT);

    let chosen = Executor::pick_driver_for_cmd(&primary, &fallback, &wait_for_download_cmd());
    assert_eq!(chosen.name(), "playwright");
}

#[tokio::test]
async fn oauth_click_routes_to_playwright() {
    let primary = Mock::new("limited", CapabilitySet::LIMITED);
    let fallback = Mock::new("playwright", CapabilitySet::PLAYWRIGHT);

    let chosen = Executor::pick_driver_for_cmd(&primary, &fallback, &oauth_click_cmd());
    assert_eq!(chosen.name(), "playwright");
}

#[test]
fn capability_set_limited_lacks_uploads() {
    assert!(!CapabilitySet::LIMITED.file_upload);
    assert!(!CapabilitySet::LIMITED.shadow_dom_click);
    assert!(!CapabilitySet::LIMITED.wait_for_download);
    assert!(!CapabilitySet::LIMITED.oauth_popup);
}

#[test]
fn capability_set_playwright_is_all_true() {
    let c = CapabilitySet::PLAYWRIGHT;
    assert!(c.file_upload && c.wait_for_download && c.shadow_dom_click);
    assert!(c.oauth_popup && c.network_idle && c.iframes);
}
