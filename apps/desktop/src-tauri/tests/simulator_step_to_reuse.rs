//! No-relaunch invariant: the simulator command layer always routes through
//! `automation::continue_run`, so the author-preview driver is never
//! re-launched. Asserts `launch()` fires zero times across repeated
//! `simulator_step_to` calls.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use automation::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::error::Result as AutoResult;
use automation::events::ExecutorEvent;
use automation::executor::continue_run;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::time::{timeout, Duration};

struct CountingDriver {
    launches: Arc<AtomicU32>,
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

fn parse(src: &str) -> story_parser::Story {
    story_parser::parse(src).ast.expect("story parses")
}

#[tokio::test]
async fn two_sequential_step_to_calls_never_relaunch() {
    let src = r#"story "s" {
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
    let story = parse(src);
    let tmp = tempfile::tempdir().unwrap();

    // Persistent counters — the same logical "session" spans both calls.
    // The simulator's command layer achieves this by reusing the 9-04
    // author driver Arc; here we simulate it by threading the AtomicU32
    // into a fresh Box<dyn BrowserDriver> each call (a cheap wrapper, just
    // like `SharedPlaywrightDriver` is a cheap Arc wrapper).
    let primary_count = Arc::new(AtomicU32::new(0));
    let fallback_count = Arc::new(AtomicU32::new(0));

    // Call 1 — mimics simulator_start: continue_run with start_after=0.
    {
        let primary: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: primary_count.clone(),
        });
        let fallback: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: fallback_count.clone(),
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ExecutorEvent>(64);
        let story1 = story.clone();
        let dir = tmp.path().join("shots1");
        let h = tokio::spawn(async move {
            let _ = continue_run(
                story1, None, primary, fallback, None, dir, None, 0, Some(2), false, None, false,
                tx,
            )
            .await;
        });
        let fut = async {
            while rx.recv().await.is_some() {}
        };
        timeout(Duration::from_secs(10), fut).await.unwrap();
        h.abort();
    }

    // Call 2 — mimics simulator_step_to: continue_run with start_after=2.
    {
        let primary: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: primary_count.clone(),
        });
        let fallback: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: fallback_count.clone(),
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ExecutorEvent>(64);
        let story2 = story.clone();
        let dir = tmp.path().join("shots2");
        let h = tokio::spawn(async move {
            let _ = continue_run(
                story2, None, primary, fallback, None, dir, None, 2, Some(4), false, None, false,
                tx,
            )
            .await;
        });
        let fut = async {
            while rx.recv().await.is_some() {}
        };
        timeout(Duration::from_secs(10), fut).await.unwrap();
        h.abort();
    }

    // Call 3 — mimics a second simulator_step_to.
    {
        let primary: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: primary_count.clone(),
        });
        let fallback: Box<dyn BrowserDriver> = Box::new(CountingDriver {
            launches: fallback_count.clone(),
        });
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ExecutorEvent>(64);
        let story3 = story.clone();
        let dir = tmp.path().join("shots3");
        let h = tokio::spawn(async move {
            let _ = continue_run(
                story3, None, primary, fallback, None, dir, None, 4, Some(5), false, None, false,
                tx,
            )
            .await;
        });
        let fut = async {
            while rx.recv().await.is_some() {}
        };
        timeout(Duration::from_secs(10), fut).await.unwrap();
        h.abort();
    }

    // Across three sequential continue_run calls — simulating a start +
    // two step_to invocations — launch() must have been called ZERO times
    // on both the primary and fallback. The real sidecar launch happened
    // inside start_author_preview (9-04) and is intentionally not counted
    // by this command-layer test.
    assert_eq!(
        primary_count.load(Ordering::SeqCst),
        0,
        "simulator path must never call primary.launch()",
    );
    assert_eq!(
        fallback_count.load(Ordering::SeqCst),
        0,
        "simulator path must never call fallback.launch()",
    );
}
