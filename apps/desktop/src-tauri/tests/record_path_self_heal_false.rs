//! Phase 11-02 — Record path self_heal=false invariance test.
//!
//! Proves two D-06 guarantees:
//!
//! 1. The record-path Executor invocation raises
//!    `AutomationError::PrimaryMissNoHeal` on a primary-miss (no fallback
//!    probe, no silent self-heal).
//! 2. A pre-existing `.story.targets.json` sidecar is left byte-identical
//!    and mtime-unchanged after the run — recording never mutates the
//!    sidecar.
//!
//! Harness note: `launch_automation` is a `#[tauri::command]` bound to
//! AppState + Channel + shell sidecars — unreachable from a
//! #[tokio::test]. Per plan: "If that harness is not yet usable,
//! downgrade to `#[tokio::test]` that calls `run_with_story_path`
//! directly with a NoopDriver pair that always returns
//! ElementNotFound." This test exercises the same gate
//! (`wait_actionable` miss → PrimaryMissNoHeal) the production call
//! site relies on.

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use std::time::Duration;

use async_trait::async_trait;
use automation::driver::{
    BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::error::{AutomationError, Result as AutoResult};
use automation::executor::Executor;
use automation::noop_driver::NoopDriver;
use automation::ExecutorEvent;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::time::timeout;

// -----------------------------------------------------------------------
// Always-miss driver — primary resolve + wait_actionable always fail.
// -----------------------------------------------------------------------

struct AlwaysMissDriver {
    calls: Arc<AtomicU32>,
}

impl AlwaysMissDriver {
    fn new() -> Self {
        Self {
            calls: Arc::new(AtomicU32::new(0)),
        }
    }
}

#[async_trait]
impl BrowserDriver for AlwaysMissDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn click(&self, _sel: &ResolvedSelector) -> AutoResult<()> {
        // If we get here the test failed — record path should have
        // short-circuited before reaching the action.
        self.calls.fetch_add(1, Ordering::SeqCst);
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
    async fn wait_for(&self, _t: &SelectorOrText, _nth: Option<u32>, _ms: u64) -> AutoResult<()> {
        Ok(())
    }
    async fn assert_present(&self, _t: &SelectorOrText, _nth: Option<u32>) -> AutoResult<()> {
        Ok(())
    }
    async fn screenshot(&self, _n: &str, _d: &Path) -> AutoResult<PathBuf> {
        Ok(PathBuf::from("/tmp/nope.png"))
    }
    async fn element_state(&self, sel: &ResolvedSelector) -> AutoResult<ElementState> {
        // Every selector resolves as "not found". This drives both
        // `resolve_via_smart` + `wait_actionable` into failure.
        Err(AutomationError::Browser(format!(
            "element not found: {}={}",
            sel.strategy.as_str(),
            sel.value
        )))
    }
    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "always-miss"
    }
}

// -----------------------------------------------------------------------

/// Minimal `.story.targets.json` fixture content — contains one entry
/// whose UUID matches the stamped step_id in the story fixture. The
/// record-path run must NOT rewrite this file.
const TARGETS_JSON: &str = r##"{
  "version": 1,
  "steps": {
    "018f4c1e-7b3a-7000-8000-0000000000aa": {
      "primary": { "kind": "css", "value": "#nonexistent" },
      "fallbacks": [
        { "kind": "css", "value": "#also-nonexistent" }
      ]
    }
  }
}"##;

/// Story with one click command stamped with a UUIDv7 id. Uses an
/// explicit `selector "#nonexistent"` target so the AlwaysMissDriver's
/// `element_state` rejection drives `wait_actionable` into the
/// PrimaryMissNoHeal gate (the driver refuses every selector).
const STORY_SRC: &str = r##"story "rec" {
  meta { app: "about:blank" }
  scene "s" {
    click selector "#nonexistent"  # @id=018f4c1e-7b3a-7000-8000-0000000000aa
  }
}
"##;

#[tokio::test]
async fn record_path_primary_miss_raises_primary_miss_no_heal() {
    let tmp = tempfile::tempdir().unwrap();
    let story_path = tmp.path().join("rec.story");
    let targets_path = tmp.path().join("rec.story.targets.json");

    std::fs::write(&story_path, STORY_SRC).unwrap();
    std::fs::write(&targets_path, TARGETS_JSON).unwrap();

    // Snapshot sidecar bytes + mtime BEFORE the run.
    let bytes_before = std::fs::read(&targets_path).unwrap();
    let mtime_before = std::fs::metadata(&targets_path).unwrap().modified().unwrap();

    let parsed = story_parser::parse(STORY_SRC);
    let story = parsed.ast.expect("story must parse");

    let primary: Box<dyn BrowserDriver> = Box::new(AlwaysMissDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());

    let screenshot_dir = tmp.path().join("shots");
    std::fs::create_dir_all(&screenshot_dir).unwrap();

    // Record path: self_heal=false. This is the production record-path
    // call shape after 11-02 (see apps/desktop/src-tauri/src/commands/automation.rs).
    let mut rx = Executor::run_with_story_path(
        story,
        Some(story_path.clone()),
        primary,
        fallback,
        None,
        screenshot_dir,
        Default::default(),
        None,
        /* self_heal */ false,
    );

    let mut step_failed_msg: Option<String> = None;
    let mut all_events: Vec<String> = Vec::new();
    let drain = async {
        while let Some(evt) = rx.recv().await {
            all_events.push(format!("{:?}", evt));
            if let ExecutorEvent::StepFailed {
                error_message,
                ordinal,
                ..
            } = &evt
            {
                assert_eq!(*ordinal, 1, "only one step in fixture");
                step_failed_msg = Some(error_message.clone());
            }
        }
    };
    timeout(Duration::from_secs(60), drain)
        .await
        .expect("executor must terminate within 60s");

    // Assertion A: a StepFailed event fired, carrying the PrimaryMissNoHeal
    // Display copy verbatim (UI-SPEC §Record-path primary-miss).
    let msg = step_failed_msg.unwrap_or_else(|| {
        panic!(
            "executor must emit a StepFailed event. Events seen:\n{}",
            all_events.join("\n"),
        )
    });
    assert!(
        msg.contains("could not match any element"),
        "error_message must include PrimaryMissNoHeal phrasing; got: {msg}",
    );
    assert!(
        msg.contains("Self-healing is disabled during recording"),
        "error_message must include the UI-SPEC locked body; got: {msg}",
    );
    assert!(
        msg.contains("Open this story in Simulator"),
        "error_message must direct the author to Simulator; got: {msg}",
    );

    // Assertion B: targets.json is byte-identical + mtime-unchanged.
    // D-06: record path is read-only against the sidecar.
    let bytes_after = std::fs::read(&targets_path).unwrap();
    assert_eq!(
        bytes_before, bytes_after,
        ".story.targets.json bytes must be unchanged after a record-path primary-miss",
    );
    let mtime_after = std::fs::metadata(&targets_path).unwrap().modified().unwrap();
    assert_eq!(
        mtime_before, mtime_after,
        ".story.targets.json mtime must be unchanged after a record-path primary-miss",
    );
}

#[tokio::test]
async fn record_path_does_not_emit_fallback_promotion() {
    // A second guardrail that the record path never probes fallbacks:
    // replay the same scenario and assert no `step_succeeded` event fires
    // (which would be the symptom of a silent fallback promotion).
    let tmp = tempfile::tempdir().unwrap();
    let story_path = tmp.path().join("rec2.story");
    let targets_path = tmp.path().join("rec2.story.targets.json");

    std::fs::write(&story_path, STORY_SRC).unwrap();
    std::fs::write(&targets_path, TARGETS_JSON).unwrap();

    let parsed = story_parser::parse(STORY_SRC);
    let story = parsed.ast.expect("story must parse");

    let primary: Box<dyn BrowserDriver> = Box::new(AlwaysMissDriver::new());
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
        /* self_heal */ false,
    );

    let mut saw_succeeded = false;
    let drain = async {
        while let Some(evt) = rx.recv().await {
            if matches!(evt, ExecutorEvent::StepSucceeded { .. }) {
                saw_succeeded = true;
            }
        }
    };
    timeout(Duration::from_secs(60), drain)
        .await
        .expect("executor must terminate within 60s");

    assert!(
        !saw_succeeded,
        "record path must NOT promote a fallback — no StepSucceeded should fire",
    );
}
