//! Simulator executor tests.
//!
//! Cover the four simulator `run_story` parameters (`stop_after_ordinal`,
//! `capture_frames`, `frame_dir`, `self_heal`) + the two new
//! `ExecutorEvent` variants (`RunPaused`, `StepFrameCaptured`) + the
//! `StepFrame.match_kind` discriminator.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use automation::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::error::{AutomationError, Result as AutoResult};
use automation::events::{ExecutorEvent, MatchKind, SelectorStrategy};
use automation::executor::{continue_run, Executor};
use automation::noop_driver::NoopDriver;
use automation::RunControl;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::time::{timeout, Duration};

// Stub driver — all actions succeed, screenshot writes a tiny PNG, and
// element_state returns a stable bbox so wait_actionable clears.
struct StubDriver {
    name: &'static str,
}

impl StubDriver {
    fn new() -> Self {
        Self { name: "stub" }
    }
}

#[async_trait]
impl BrowserDriver for StubDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn click(&self, _s: &ResolvedSelector) -> AutoResult<()> {
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
    async fn screenshot(&self, name: &str, out_dir: &Path) -> AutoResult<PathBuf> {
        std::fs::create_dir_all(out_dir).ok();
        let path = out_dir.join(format!("{name}.png"));
        // tiny valid PNG: the 8-byte signature is enough for existence checks.
        std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).ok();
        Ok(path)
    }
    async fn element_state(&self, _s: &ResolvedSelector) -> AutoResult<ElementState> {
        Ok(ElementState {
            visible: true,
            bbox: Some(BoundingBox {
                x: 1.0,
                y: 2.0,
                w: 10.0,
                h: 20.0,
            }),
            animating: false,
            in_viewport: true,
        })
    }
    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((42, 84))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        self.name
    }
}

// Fuzzy driver — emulates a page where `#save-v1` is missing and
// `#save-v2` is the promoted fallback (self-healing path trigger).
struct FuzzyDriver {
    clicks: Arc<AtomicU32>,
    writes_allowed: bool,
}

impl FuzzyDriver {
    fn new() -> Self {
        Self {
            clicks: Arc::new(AtomicU32::new(0)),
            writes_allowed: true,
        }
    }
    fn matches_v2(sel: &ResolvedSelector) -> bool {
        sel.strategy == SelectorStrategy::Css && sel.value == "#save-v2"
    }
}

#[async_trait]
impl BrowserDriver for FuzzyDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn click(&self, _s: &ResolvedSelector) -> AutoResult<()> {
        self.clicks.fetch_add(1, Ordering::SeqCst);
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
    async fn screenshot(&self, name: &str, out_dir: &Path) -> AutoResult<PathBuf> {
        std::fs::create_dir_all(out_dir).ok();
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).ok();
        Ok(path)
    }
    async fn element_state(&self, sel: &ResolvedSelector) -> AutoResult<ElementState> {
        if Self::matches_v2(sel) {
            Ok(ElementState {
                visible: true,
                bbox: Some(BoundingBox {
                    x: 5.0,
                    y: 6.0,
                    w: 50.0,
                    h: 40.0,
                }),
                animating: false,
                in_viewport: true,
            })
        } else {
            // Primary `#save-v1` misses — drives wait_actionable into the
            // self-healing fallback probe.
            Err(AutomationError::Browser(format!(
                "not found: {}",
                sel.value
            )))
        }
    }
    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((7, 9))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        if self.writes_allowed {
            "fuzzy"
        } else {
            "fuzzy-ro"
        }
    }
}

fn parse_story(src: &str) -> story_parser::Story {
    let parsed = story_parser::parse(src);
    assert!(
        parsed
            .diagnostics
            .iter()
            .all(|d| !matches!(d.severity, story_parser::Severity::Error)),
        "parse diagnostics: {:?}",
        parsed.diagnostics
    );
    parsed.ast.expect("story parses")
}

async fn drain(rx: &mut tokio::sync::mpsc::Receiver<ExecutorEvent>) -> Vec<ExecutorEvent> {
    let mut out = Vec::new();
    let fut = async {
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
    };
    timeout(Duration::from_secs(30), fut)
        .await
        .expect("executor must complete within 30s");
    out
}

#[tokio::test]
async fn run_stops_at_ordinal() {
    let src = r#"story "s1" {
  meta { app: "about:blank" }
  scene "sc" {
    navigate "https://a.example"
    wait 10ms
    wait 10ms
    wait 10ms
    wait 10ms
  }
}
"#;
    let story = parse_story(src);
    let tmp = tempfile::tempdir().unwrap();
    let primary: Box<dyn BrowserDriver> = Box::new(StubDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());
    let mut rx = Executor::run_simulator(
        story,
        None,
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        Some(3),
        false,
        None,
        true,
    );
    let events = drain(&mut rx).await;
    let types: Vec<&str> = events
        .iter()
        .map(|e| match e {
            ExecutorEvent::StoryStarted { .. } => "story_started",
            ExecutorEvent::SceneEntered { .. } => "scene_entered",
            ExecutorEvent::StepStarted { .. } => "step_started",
            ExecutorEvent::StepAttempt { .. } => "step_attempt",
            ExecutorEvent::StepSucceeded { .. } => "step_succeeded",
            ExecutorEvent::StepFailed { .. } => "step_failed",
            ExecutorEvent::StoryEnded { .. } => "story_ended",
            ExecutorEvent::RunPaused { .. } => "run_paused",
            ExecutorEvent::StepFrameCaptured { .. } => "step_frame_captured",
            ExecutorEvent::ActionRecorded { .. } => "action_recorded",
        })
        .collect();
    assert!(
        types.contains(&"run_paused"),
        "expected RunPaused in: {:?}",
        types
    );
    assert!(
        !types.contains(&"story_ended"),
        "must NOT emit StoryEnded when paused: {:?}",
        types
    );
    // Final event is RunPaused with the stop ordinal.
    match events.last().expect("non-empty") {
        ExecutorEvent::RunPaused { ordinal } => assert_eq!(*ordinal, 3),
        other => panic!("expected RunPaused{{3}}, got {:?}", other),
    }
    // Exactly 3 StepSucceeded.
    let succeeded = events
        .iter()
        .filter(|e| matches!(e, ExecutorEvent::StepSucceeded { .. }))
        .count();
    assert_eq!(succeeded, 3);
}

#[tokio::test]
async fn frame_capture_writes_png_and_bbox() {
    let src = r##"story "s2" {
  meta { app: "about:blank" }
  scene "sc" {
    click selector "#a"
    click selector "#b"
  }
}
"##;
    let story = parse_story(src);
    let tmp = tempfile::tempdir().unwrap();
    let frame_dir = tmp.path().join("frames");
    let primary: Box<dyn BrowserDriver> = Box::new(StubDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());
    let mut rx = Executor::run_simulator(
        story,
        None,
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        None,
        true,
        Some(frame_dir.clone()),
        true,
    );
    let events = drain(&mut rx).await;
    let frames: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ExecutorEvent::StepFrameCaptured { frame, .. } => Some(frame),
            _ => None,
        })
        .collect();
    assert_eq!(frames.len(), 2);
    for f in &frames {
        let p = f.screenshot_path.as_ref().expect("screenshot path");
        assert!(p.starts_with(&frame_dir));
        assert!(p.exists(), "{} must exist", p.display());
        assert!(f.matched_bbox.is_some(), "click should set bbox");
        assert_eq!(f.match_kind, MatchKind::Primary);
        assert_eq!(f.cursor_xy, (42, 84));
        assert!(f.matched_selector.is_some());
    }
}

#[tokio::test]
async fn self_heal_false_bypasses_promote_emits_fuzzy() {
    // Copy fixture sidecar into a fresh tmp dir so we can assert unchanged.
    let tmp = tempfile::tempdir().unwrap();
    let story_path = tmp.path().join("s.story");
    let targets_path = tmp.path().join("s.story.targets.json");
    std::fs::copy("tests/fixtures/self_healing.story", &story_path).unwrap();
    std::fs::copy(
        "tests/fixtures/self_healing.story.targets.json",
        &targets_path,
    )
    .unwrap();
    let sidecar_before = std::fs::read_to_string(&targets_path).unwrap();

    let src = std::fs::read_to_string(&story_path).unwrap();
    let story = parse_story(&src);

    let primary: Box<dyn BrowserDriver> = Box::new(FuzzyDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());

    let mut rx = Executor::run_simulator(
        story,
        Some(story_path.clone()),
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        None,
        true,
        Some(tmp.path().join("frames")),
        false, // self_heal OFF
    );
    let events = drain(&mut rx).await;
    // Sidecar must be unchanged.
    let sidecar_after = std::fs::read_to_string(&targets_path).unwrap();
    assert_eq!(
        sidecar_before, sidecar_after,
        "self_heal=false must not rewrite .story.targets.json"
    );
    // Frame for step 1 must carry match_kind=Fuzzy.
    let frame = events
        .iter()
        .find_map(|e| match e {
            ExecutorEvent::StepFrameCaptured { frame, .. } => Some(frame),
            _ => None,
        })
        .expect("frame must be captured");
    assert_eq!(frame.match_kind, MatchKind::Fuzzy);
}

#[tokio::test]
async fn navigate_and_waitms_yield_null_bbox_and_none_kind() {
    let src = r#"story "s4" {
  meta { app: "about:blank" }
  scene "sc" {
    navigate "https://a.example"
    wait 5ms
  }
}
"#;
    let story = parse_story(src);
    let tmp = tempfile::tempdir().unwrap();
    let primary: Box<dyn BrowserDriver> = Box::new(StubDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());
    let mut rx = Executor::run_simulator(
        story,
        None,
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        None,
        true,
        Some(tmp.path().join("frames")),
        true,
    );
    let events = drain(&mut rx).await;
    let frames: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ExecutorEvent::StepFrameCaptured { frame, .. } => Some(frame),
            _ => None,
        })
        .collect();
    assert_eq!(frames.len(), 2);
    for f in &frames {
        assert!(f.matched_bbox.is_none(), "no target → no bbox");
        assert!(f.matched_selector.is_none(), "no target → no selector");
        assert_eq!(f.match_kind, MatchKind::None);
    }
}

// Counting driver — wraps stub action behavior but tracks `launch()` calls.
struct CountingDriver {
    launches: Arc<AtomicU32>,
}

impl CountingDriver {
    fn new() -> Self {
        Self {
            launches: Arc::new(AtomicU32::new(0)),
        }
    }
}

#[async_trait]
impl BrowserDriver for CountingDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn click(&self, _s: &ResolvedSelector) -> AutoResult<()> {
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
    async fn screenshot(&self, name: &str, out_dir: &Path) -> AutoResult<PathBuf> {
        std::fs::create_dir_all(out_dir).ok();
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).ok();
        Ok(path)
    }
    async fn element_state(&self, _s: &ResolvedSelector) -> AutoResult<ElementState> {
        Ok(ElementState {
            visible: true,
            bbox: Some(BoundingBox {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            }),
            animating: false,
            in_viewport: true,
        })
    }
    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "counting"
    }
}

#[tokio::test]
async fn continue_run_reuses_already_launched_drivers() {
    let src = r#"story "s6" {
  meta { app: "about:blank" }
  scene "sc" {
    wait 1ms
    wait 1ms
    wait 1ms
    wait 1ms
    wait 1ms
  }
}
"#;
    let story = parse_story(src);
    let tmp = tempfile::tempdir().unwrap();

    let primary = CountingDriver::new();
    let primary_launches = primary.launches.clone();
    let fallback = CountingDriver::new();
    let fallback_launches = fallback.launches.clone();

    let mut rx = Executor::run_simulator(
        story.clone(),
        None,
        Box::new(primary),
        Box::new(fallback),
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        Some(2),
        false,
        None,
        true,
    );
    let first_events = drain(&mut rx).await;
    // After pausing, launch must have been called exactly once per driver.
    assert_eq!(primary_launches.load(Ordering::SeqCst), 1);
    assert_eq!(fallback_launches.load(Ordering::SeqCst), 1);
    let paused = first_events
        .iter()
        .any(|e| matches!(e, ExecutorEvent::RunPaused { ordinal: 2 }));
    assert!(paused, "expected RunPaused{{2}} in {:?}", first_events);

    // Resume with fresh drivers whose launch counters start fresh — the
    // point of continue_run is that it does NOT call launch(). We simulate
    // this by passing drivers that have never been launched; if
    // continue_run did call launch, the counter would go to 1.
    let primary2 = CountingDriver::new();
    let p2_launches = primary2.launches.clone();
    let fallback2 = CountingDriver::new();
    let f2_launches = fallback2.launches.clone();

    let (tx, mut rx2) = tokio::sync::mpsc::channel(256);
    let screenshot_dir = tmp.path().join("shots2");
    tokio::spawn(async move {
        let _ = continue_run(
            story,
            None,
            Box::new(primary2),
            Box::new(fallback2),
            None,
            screenshot_dir,
            None,
            2,
            None,
            false,
            None,
            true,
            tx,
        )
        .await;
    });
    let events = drain(&mut rx2).await;
    // continue_run must NOT have called launch().
    assert_eq!(
        p2_launches.load(Ordering::SeqCst),
        0,
        "continue_run must not launch the primary",
    );
    assert_eq!(
        f2_launches.load(Ordering::SeqCst),
        0,
        "continue_run must not launch the fallback",
    );
    // Steps 3..=5 must have fired (step 1 and 2 were skipped).
    let succeeded_ordinals: Vec<u32> = events
        .iter()
        .filter_map(|e| match e {
            ExecutorEvent::StepSucceeded { ordinal, .. } => Some(*ordinal),
            _ => None,
        })
        .collect();
    assert_eq!(succeeded_ordinals, vec![3, 4, 5]);
    // No StoryStarted on resume.
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ExecutorEvent::StoryStarted { .. })),
        "continue_run must not re-emit StoryStarted"
    );
}

// Slow driver — adds a real sleep to wait_ms so cancellation has time to
// interrupt a multi-step run.
struct SlowDriver;

#[async_trait]
impl BrowserDriver for SlowDriver {
    async fn launch(&mut self, _c: LaunchConfig) -> AutoResult<()> {
        Ok(())
    }
    async fn close(&mut self) -> AutoResult<()> {
        Ok(())
    }
    async fn goto(&self, _u: &str) -> AutoResult<()> {
        Ok(())
    }
    async fn click(&self, _s: &ResolvedSelector) -> AutoResult<()> {
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
    async fn wait_ms(&self, ms: u64) -> AutoResult<()> {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        Ok(())
    }
    async fn wait_for(&self, _t: &SelectorOrText, _nth: Option<u32>, _ms: u64) -> AutoResult<()> {
        Ok(())
    }
    async fn assert_present(&self, _t: &SelectorOrText, _nth: Option<u32>) -> AutoResult<()> {
        Ok(())
    }
    async fn screenshot(&self, name: &str, out_dir: &Path) -> AutoResult<PathBuf> {
        std::fs::create_dir_all(out_dir).ok();
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).ok();
        Ok(path)
    }
    async fn element_state(&self, _s: &ResolvedSelector) -> AutoResult<ElementState> {
        Ok(ElementState {
            visible: true,
            bbox: None,
            animating: false,
            in_viewport: true,
        })
    }
    async fn current_cursor_position(&self) -> AutoResult<(i32, i32)> {
        Ok((0, 0))
    }
    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }
    fn name(&self) -> &'static str {
        "slow"
    }
}

#[tokio::test]
async fn cancel_exits_scene_loop_after_current_step() {
    // Ten 100ms waits so real wall-clock time elapses between steps and
    // the cancel signal propagates before the next step starts.
    let src = r#"story "s7" {
  meta { app: "about:blank" }
  scene "sc" {
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
    wait 100ms
  }
}
"#;
    let story = parse_story(src);
    let tmp = tempfile::tempdir().unwrap();
    let control = Arc::new(RunControl::new());
    let primary: Box<dyn BrowserDriver> = Box::new(SlowDriver);
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());
    let mut rx = Executor::run_simulator(
        story,
        None,
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        Some(control.clone()),
        None,
        false,
        None,
        true,
    );

    let mut seen_succeeded = 0u32;
    let mut highest_started = 0u32;
    let fut = async {
        while let Some(ev) = rx.recv().await {
            match ev {
                ExecutorEvent::StepSucceeded { ordinal, .. } => {
                    seen_succeeded = ordinal;
                    if ordinal == 1 {
                        control.cancel();
                    }
                }
                ExecutorEvent::StepStarted { ordinal, .. } => {
                    highest_started = ordinal.max(highest_started);
                }
                _ => {}
            }
        }
    };
    timeout(Duration::from_secs(30), fut)
        .await
        .expect("must complete");
    assert!(seen_succeeded >= 1);
    assert!(
        highest_started < 10,
        "cancel must stop before the 10th step started (saw up to {})",
        highest_started,
    );
}

#[tokio::test]
async fn self_heal_true_promotes_and_emits_fuzzy() {
    let tmp = tempfile::tempdir().unwrap();
    let story_path = tmp.path().join("s.story");
    let targets_path = tmp.path().join("s.story.targets.json");
    std::fs::copy("tests/fixtures/self_healing.story", &story_path).unwrap();
    std::fs::copy(
        "tests/fixtures/self_healing.story.targets.json",
        &targets_path,
    )
    .unwrap();
    let sidecar_before = std::fs::read_to_string(&targets_path).unwrap();

    let src = std::fs::read_to_string(&story_path).unwrap();
    let story = parse_story(&src);

    let primary: Box<dyn BrowserDriver> = Box::new(FuzzyDriver::new());
    let fallback: Box<dyn BrowserDriver> = Box::new(NoopDriver::new());

    let mut rx = Executor::run_simulator(
        story,
        Some(story_path.clone()),
        primary,
        fallback,
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        None,
        true,
        Some(tmp.path().join("frames")),
        true, // self_heal ON
    );
    let events = drain(&mut rx).await;
    // Sidecar must have been rewritten.
    let sidecar_after = std::fs::read_to_string(&targets_path).unwrap();
    assert_ne!(
        sidecar_before, sidecar_after,
        "self_heal=true must rewrite .story.targets.json on fuzzy match"
    );
    // Frame must still carry Fuzzy.
    let frame = events
        .iter()
        .find_map(|e| match e {
            ExecutorEvent::StepFrameCaptured { frame, .. } => Some(frame),
            _ => None,
        })
        .expect("frame must be captured");
    assert_eq!(frame.match_kind, MatchKind::Fuzzy);
}
