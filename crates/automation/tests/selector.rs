//! Browser-free unit tests for the SmartSelector and capability mapping.
//!
//! These run in the default test set (no browser, no Node).

use async_trait::async_trait;
use automation::driver::{
    ActionKind, BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig,
    ResolvedSelector,
};
use automation::events::{AttemptOutcome, SelectorStrategy};
use automation::{capability, Capability, SmartSelector};
use std::path::{Path, PathBuf};
use story_parser::{ScrollDir, SelectorOrText, Span};

/// Trivial driver double that does NOT execute anything; used so the
/// SmartSelector + capability tests can run without a browser. It claims
/// playwright-style capabilities so `wait_actionable` etc. don't get in
/// the way.
#[derive(Default)]
struct StubDriver;

#[async_trait]
impl BrowserDriver for StubDriver {
    async fn launch(&mut self, _: LaunchConfig) -> automation::Result<()> {
        Ok(())
    }
    async fn close(&mut self) -> automation::Result<()> {
        Ok(())
    }
    async fn goto(&self, _: &str) -> automation::Result<()> {
        Ok(())
    }
    async fn click(&self, _: &ResolvedSelector) -> automation::Result<()> {
        Ok(())
    }
    async fn type_text(&self, _: &ResolvedSelector, _: &str) -> automation::Result<()> {
        Ok(())
    }
    async fn scroll(&self, _: ScrollDir, _: Option<f32>) -> automation::Result<()> {
        Ok(())
    }
    async fn hover(&self, _: &ResolvedSelector) -> automation::Result<()> {
        Ok(())
    }
    async fn drag(&self, _: &ResolvedSelector, _: &ResolvedSelector) -> automation::Result<()> {
        Ok(())
    }
    async fn select_option(&self, _: &ResolvedSelector, _: &str) -> automation::Result<()> {
        Ok(())
    }
    async fn upload_file(&self, _: &ResolvedSelector, _: &Path) -> automation::Result<()> {
        Ok(())
    }
    async fn wait_ms(&self, _: u64) -> automation::Result<()> {
        Ok(())
    }
    async fn wait_for(&self, _: &SelectorOrText, _: u64) -> automation::Result<()> {
        Ok(())
    }
    async fn assert_present(&self, _: &SelectorOrText) -> automation::Result<()> {
        Ok(())
    }
    async fn screenshot(&self, _: &str, _: &Path) -> automation::Result<PathBuf> {
        Ok(PathBuf::new())
    }
    async fn element_state(&self, _: &ResolvedSelector) -> automation::Result<ElementState> {
        Ok(ElementState {
            visible: true,
            in_viewport: true,
            animating: false,
            bbox: Some(BoundingBox {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            }),
        })
    }
    async fn current_cursor_position(&self) -> automation::Result<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "stub"
    }
}

// ------ capability::required_for ------

#[test]
fn capability_routing_upload() {
    let cmd = story_parser::Command::Upload {
        target: SelectorOrText::Selector("#f".into()),
        path: "/tmp/x".into(),
        span: Span::empty(),
        step_id: None,
    };
    assert_eq!(capability::required_for(&cmd), Capability::FileUpload);
}

#[test]
fn capability_routing_plain_click_is_none() {
    let cmd = story_parser::Command::Click {
        target: SelectorOrText::Text("Save".into()),
        span: Span::empty(),
        step_id: None,
    };
    assert_eq!(capability::required_for(&cmd), Capability::None);
}

#[test]
fn capability_routing_shadow_dom_click() {
    let cmd = story_parser::Command::Click {
        target: SelectorOrText::Selector("div#host::shadow button".into()),
        span: Span::empty(),
        step_id: None,
    };
    assert_eq!(
        capability::required_for(&cmd),
        Capability::ShadowDomPiercing
    );
}

#[test]
fn capability_routing_wait_for_download() {
    let cmd = story_parser::Command::WaitFor {
        target: SelectorOrText::Text("download:report.pdf".into()),
        timeout_ms: Some(5_000),
        span: Span::empty(),
        step_id: None,
    };
    assert_eq!(capability::required_for(&cmd), Capability::WaitForDownload);
}

#[test]
fn capability_routing_oauth_popup_click() {
    let cmd = story_parser::Command::Click {
        target: SelectorOrText::Text("oauth:Sign in with Google".into()),
        span: Span::empty(),
        step_id: None,
    };
    assert_eq!(capability::required_for(&cmd), Capability::OAuthPopup);
}

// ------ SmartSelector resolution ------

#[tokio::test]
async fn explicit_css_selector_resolves_strict() {
    let driver = StubDriver;
    let target = SelectorOrText::Selector("#save".into());
    let (sel, attempts) =
        SmartSelector::resolve_with_attempts(&driver, ActionKind::Click, &target, 1_000)
            .await
            .unwrap();
    assert_eq!(sel.strategy, SelectorStrategy::Css);
    assert_eq!(sel.value, "#save");
    assert_eq!(attempts.len(), 1);
    assert!(matches!(attempts[0].outcome, AttemptOutcome::Found { .. }));
}

#[tokio::test]
async fn explicit_testid_does_not_fall_back() {
    let driver = StubDriver;
    let target = SelectorOrText::TestId("missing".into());
    let (sel, _) = SmartSelector::resolve_with_attempts(&driver, ActionKind::Click, &target, 1_000)
        .await
        .unwrap();
    // Strict — never collapses into a CSS / text strategy.
    assert_eq!(sel.strategy, SelectorStrategy::TestId);
    assert_eq!(sel.value, "[data-testid=\"missing\"]");
}

#[tokio::test]
async fn explicit_aria_resolves_strict() {
    let driver = StubDriver;
    let target = SelectorOrText::Aria("Sign in".into());
    let (sel, _) = SmartSelector::resolve_with_attempts(&driver, ActionKind::Click, &target, 1_000)
        .await
        .unwrap();
    assert_eq!(sel.strategy, SelectorStrategy::Aria);
    assert_eq!(sel.value, "Sign in");
}

#[tokio::test]
async fn text_target_for_type_prefers_label_assoc_over_visible_text() {
    let driver = StubDriver;
    let target = SelectorOrText::Text("Email".into());
    let (sel, attempts) =
        SmartSelector::resolve_with_attempts(&driver, ActionKind::Type, &target, 1_000)
            .await
            .unwrap();
    // For Type action: the top-scored strategy is AccessibleName (1.0) by
    // design, but LabelAssoc (0.95) outranks VisibleText (0.7).
    assert_eq!(sel.strategy, SelectorStrategy::AccessibleName);
    let label_pos = attempts
        .iter()
        .position(|a| a.strategy == SelectorStrategy::LabelAssoc)
        .unwrap();
    let visible_pos = attempts
        .iter()
        .position(|a| a.strategy == SelectorStrategy::VisibleText)
        .unwrap();
    assert!(
        label_pos < visible_pos,
        "label assoc should be tried before visible text for Type action"
    );
}

#[tokio::test]
async fn text_target_logs_every_attempt() {
    let driver = StubDriver;
    let target = SelectorOrText::Text("Save".into());
    let (_sel, attempts) =
        SmartSelector::resolve_with_attempts(&driver, ActionKind::Click, &target, 1_000)
            .await
            .unwrap();
    // 4 strategies tried for Click (accessible-name, visible-text,
    // label-assoc, fuzzy-text).
    assert_eq!(attempts.len(), 4);
}
