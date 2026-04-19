//! Plan 07-04c — self-healing integration smoke.
//!
//! SCOPE: proves the end-to-end wiring from
//! `parse -> Executor::run_with_story_path -> wait_actionable miss ->
//! targets_store fallback promotion -> atomic sidecar rewrite`, against a
//! programmable mock driver that emulates a real page where the primary
//! `#save-v1` no longer exists but `#save-v2` does. This is the
//! PHASE-7.5 acceptance gate in CI form; the operator smoke runbook
//! (`07-04c-SMOKE.md`) exercises the same path against real Chromium.
//!
//! The `#[ignore]` live test documents the CLI for a developer who wants
//! to run the same scenario against a real sidecar.

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};

use async_trait::async_trait;
use automation::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::error::{AutomationError, Result as AutoResult};
use automation::events::SelectorStrategy;
use automation::executor::Executor;
use automation::noop_driver::NoopDriver;
use automation::targets_store;
use std::path::Path;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::time::{timeout, Duration};

// -----------------------------------------------------------------------
// Mock driver — emulates a page where `#save-v1` is missing and
// `#save-v2` (and the `role=button:Save` fallback) is present.
//
// `element_state(sel)` returns a bbox-stable visible element for anything
// matching `#save-v2` or `role=button:Save`, and an `AutomationError`
// for `#save-v1` — this is what drives `wait_actionable` to fail on the
// primary and succeed on the fallback.
// -----------------------------------------------------------------------

struct HealingMockDriver {
    /// Increments every time `click()` is invoked so the test can assert
    /// the executor actually reached the action after self-healing.
    clicks: Arc<AtomicU32>,
    /// The selector value the last click was dispatched against.
    last_click_value: Arc<tokio::sync::Mutex<Option<String>>>,
    /// Cached last-seen bbox so the `wait_actionable` bbox-stability check
    /// flips to `stable = true` on the second poll.
    last_bbox: Arc<tokio::sync::Mutex<Option<BoundingBox>>>,
}

impl HealingMockDriver {
    fn new() -> Self {
        Self {
            clicks: Arc::new(AtomicU32::new(0)),
            last_click_value: Arc::new(tokio::sync::Mutex::new(None)),
            last_bbox: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    fn matches_save_v2(sel: &ResolvedSelector) -> bool {
        // `#save-v2` resolves via `explicit_strategy` as (Css, "#save-v2").
        // `role=button:Save` resolves as (Role, "role=button:Save").
        matches!(sel.strategy, SelectorStrategy::Css) && sel.value == "#save-v2"
            || matches!(sel.strategy, SelectorStrategy::Role) && sel.value == "role=button:Save"
    }
}

#[async_trait]
impl BrowserDriver for HealingMockDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }

    async fn click(&self, sel: &ResolvedSelector) -> AutoResult<()> {
        self.clicks.fetch_add(1, Ordering::SeqCst);
        *self.last_click_value.lock().await = Some(sel.value.clone());
        Ok(())
    }

    async fn type_text(&self, _s: &ResolvedSelector, _t: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn scroll(&self, _d: ScrollDir, _a: Option<f32>) -> AutoResult<()> {
        Ok(())
    }
    async fn hover(&self, _s: &ResolvedSelector) -> AutoResult<()> {
        Ok(())
    }
    async fn drag(&self, _f: &ResolvedSelector, _t: &ResolvedSelector) -> AutoResult<()> {
        Ok(())
    }
    async fn select_option(&self, _s: &ResolvedSelector, _v: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn upload_file(&self, _s: &ResolvedSelector, _p: &Path) -> AutoResult<()> {
        Ok(())
    }
    async fn wait_ms(&self, _ms: u64) -> AutoResult<()> {
        Ok(())
    }
    async fn wait_for(&self, _t: &SelectorOrText, _ms: u64) -> AutoResult<()> {
        Ok(())
    }
    async fn assert_present(&self, _t: &SelectorOrText) -> AutoResult<()> {
        Ok(())
    }
    async fn screenshot(&self, _n: &str, _d: &Path) -> AutoResult<PathBuf> {
        Ok(PathBuf::from("/tmp/nope.png"))
    }

    async fn element_state(&self, sel: &ResolvedSelector) -> AutoResult<ElementState> {
        if Self::matches_save_v2(sel) {
            // Bbox-stable after the first poll so wait_actionable's
            // two-tick stability check flips to true.
            let bbox = BoundingBox {
                x: 10.0,
                y: 10.0,
                w: 100.0,
                h: 40.0,
            };
            let mut g = self.last_bbox.lock().await;
            *g = Some(bbox);
            Ok(ElementState {
                visible: true,
                bbox: Some(bbox),
                animating: false,
                in_viewport: true,
            })
        } else {
            // Primary `#save-v1` never resolves.
            Err(AutomationError::Browser(format!(
                "element not found: {}={}",
                sel.strategy.as_str(),
                sel.value
            )))
        }
    }

    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "healing-mock"
    }
}

// -----------------------------------------------------------------------
// The PHASE-7.5 acceptance gate.
// -----------------------------------------------------------------------

#[tokio::test]
async fn primary_miss_promotes_first_passing_fallback() {
    // Stage fixtures into a temp dir so the rewrite assertions are isolated
    // from the in-tree fixture files.
    let tmp = tempfile::tempdir().unwrap();
    let story_path = tmp.path().join("self_healing.story");
    let targets_path = tmp.path().join("self_healing.story.targets.json");

    std::fs::copy("tests/fixtures/self_healing.story", &story_path).unwrap();
    std::fs::copy(
        "tests/fixtures/self_healing.story.targets.json",
        &targets_path,
    )
    .unwrap();

    let src_before = std::fs::read_to_string(&story_path).unwrap();

    // Parse the story.
    let parsed = story_parser::parse(&src_before);
    assert!(
        parsed
            .diagnostics
            .iter()
            .all(|d| !matches!(d.severity, story_parser::Severity::Error)),
        "parse must be clean: {:?}",
        parsed.diagnostics,
    );
    let story = parsed.ast.expect("story must parse");

    // Sanity: the command must carry the step_id from the fixture.
    let expected_step_id = uuid::Uuid::parse_str("018f4c1e-7b3a-7000-8000-0000000000aa").unwrap();
    let parsed_step_id = story.scenes[0].commands[0].step_id();
    assert_eq!(
        parsed_step_id,
        Some(expected_step_id),
        "parser must thread the # @id=<uuid> comment into Command.step_id",
    );

    // Run the executor against a mock driver that rejects the primary.
    let mock = HealingMockDriver::new();
    let clicks = mock.clicks.clone();
    let last_click_value = mock.last_click_value.clone();
    let primary: Box<dyn BrowserDriver> = Box::new(mock);
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());

    let screenshot_dir = tmp.path().join("shots");
    std::fs::create_dir_all(&screenshot_dir).unwrap();

    let mut rx = Executor::run_with_story_path(
        story,
        Some(story_path.clone()),
        primary,
        fallback,
        None,
        screenshot_dir,
        Default::default(),
        None,
    );

    // Drain events with a hard timeout so a hang fails the test rather
    // than the runner.
    let drain = async { while rx.recv().await.is_some() {} };
    timeout(Duration::from_secs(30), drain)
        .await
        .expect("executor must complete within 30s");

    // PHASE-7.5 assertion #1: the click actually fired, against the
    // promoted fallback selector (NOT the primary that no longer exists).
    assert_eq!(
        clicks.load(Ordering::SeqCst),
        1,
        "executor must reach click() after self-healing",
    );
    let last_val = last_click_value.lock().await.clone();
    assert_eq!(
        last_val.as_deref(),
        Some("#save-v2"),
        "self-healing must dispatch the click against the promoted fallback",
    );

    // PHASE-7.5 assertion #2: `.story` source is UNCHANGED.
    let src_after = std::fs::read_to_string(&story_path).unwrap();
    assert_eq!(
        src_after, src_before,
        "self-healing must NEVER modify the .story source",
    );

    // PHASE-7.5 assertion #3: `.story.targets.json` REWRITTEN with
    // `#save-v2` as new primary and the old `#save-v1` demoted to
    // `fallbacks[0]`.
    let reread = targets_store::load(&targets_path).unwrap();
    let step = reread
        .steps
        .get(&expected_step_id)
        .expect("step must be present after rewrite");
    assert_eq!(step.primary.kind, "selector");
    assert_eq!(step.primary.value, serde_json::json!("#save-v2"));
    assert_eq!(
        step.fallbacks[0].kind, "selector",
        "old primary must be demoted to fallbacks[0]",
    );
    assert_eq!(
        step.fallbacks[0].value,
        serde_json::json!("#save-v1"),
        "old primary value must be retained at fallbacks[0]",
    );
    // The other pre-existing fallback (role=button:Save) must still be
    // present somewhere in the fallbacks list — order after the promoted
    // slot is implementation-defined, but the candidate must not be
    // dropped.
    assert!(
        step.fallbacks.iter().any(|fb| fb.kind == "role"),
        "role-based fallback must be retained post-promotion: {:?}",
        step.fallbacks,
    );
}

/// Legacy `.story` files (no `# @id=<uuid>` comment) must bypass the
/// targets-store path entirely — the sidecar helpers still behave, the
/// executor simply never calls them.
#[test]
fn legacy_story_without_step_id_does_not_touch_targets_store() {
    let p = std::path::PathBuf::from("/nonexistent/nowhere.story");
    let tp = targets_store::targets_path_for(&p);
    assert_eq!(
        tp.to_string_lossy(),
        "/nonexistent/nowhere.story.targets.json",
    );
    let result = targets_store::load(&tp).unwrap();
    assert!(
        result.steps.is_empty(),
        "missing sidecar must decode as empty"
    );
}

/// Live-sidecar variant — requires a running Playwright sidecar + real
/// Chromium. Operator runbook is `07-04c-SMOKE.md`; this entry point is a
/// developer convenience:
///
/// ```text
/// cargo test -p automation --test self_healing -- --ignored
/// ```
#[tokio::test]
#[ignore = "live sidecar required — see 07-04c-SMOKE.md for the operator runbook"]
async fn primary_miss_promotes_first_passing_fallback_live() {
    // The operator runbook covers this case end-to-end against real
    // Chromium. A live test here would need the Playwright SEA binary
    // resolved at runtime, which is the target of 07-04c-SMOKE.md. This
    // ignored test exists so `cargo test --test self_healing -- --ignored`
    // has a well-known entry point to point developers at the runbook.
    eprintln!(
        "live self-healing smoke — run the operator runbook at \
         .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md",
    );
}
