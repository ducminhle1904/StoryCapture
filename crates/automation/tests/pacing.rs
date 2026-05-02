use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use automation::driver::{
    BoundingBox, BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use automation::events::ExecutorEvent;
use automation::{NoopDriver, PacingProfile};
use story_parser::{ScrollDir, SelectorOrText};
use tokio::time::{timeout, Duration};

#[derive(Clone, Default)]
struct Tracking {
    waits: Arc<Mutex<Vec<u64>>>,
    actions: Arc<Mutex<Vec<&'static str>>>,
}

struct TrackingDriver {
    tracking: Tracking,
}

impl TrackingDriver {
    fn new(tracking: Tracking) -> Self {
        Self { tracking }
    }
}

#[async_trait]
impl BrowserDriver for TrackingDriver {
    async fn launch(&mut self, _config: LaunchConfig) -> automation::Result<()> {
        Ok(())
    }

    async fn close(&mut self) -> automation::Result<()> {
        Ok(())
    }

    async fn goto(&self, _url: &str) -> automation::Result<()> {
        self.tracking.actions.lock().unwrap().push("navigate");
        Ok(())
    }

    async fn click(&self, _sel: &ResolvedSelector) -> automation::Result<()> {
        self.tracking.actions.lock().unwrap().push("click");
        Ok(())
    }

    async fn type_text(&self, _sel: &ResolvedSelector, _text: &str) -> automation::Result<()> {
        self.tracking.actions.lock().unwrap().push("type");
        Ok(())
    }

    async fn scroll(&self, _direction: ScrollDir, _amount: Option<f32>) -> automation::Result<()> {
        Ok(())
    }

    async fn hover(&self, _sel: &ResolvedSelector) -> automation::Result<()> {
        Ok(())
    }

    async fn drag(
        &self,
        _from: &ResolvedSelector,
        _to: &ResolvedSelector,
    ) -> automation::Result<()> {
        Ok(())
    }

    async fn select_option(&self, _sel: &ResolvedSelector, _value: &str) -> automation::Result<()> {
        Ok(())
    }

    async fn upload_file(&self, _sel: &ResolvedSelector, _path: &Path) -> automation::Result<()> {
        Ok(())
    }

    async fn wait_ms(&self, ms: u64) -> automation::Result<()> {
        self.tracking.waits.lock().unwrap().push(ms);
        Ok(())
    }

    async fn wait_for(
        &self,
        _target: &SelectorOrText,
        _target_nth: Option<u32>,
        _timeout_ms: u64,
    ) -> automation::Result<()> {
        self.tracking.actions.lock().unwrap().push("wait-for");
        Ok(())
    }

    async fn assert_present(
        &self,
        _target: &SelectorOrText,
        _target_nth: Option<u32>,
    ) -> automation::Result<()> {
        Ok(())
    }

    async fn screenshot(&self, name: &str, out_dir: &Path) -> automation::Result<PathBuf> {
        self.tracking.actions.lock().unwrap().push("screenshot");
        std::fs::create_dir_all(out_dir).ok();
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).ok();
        Ok(path)
    }

    async fn element_state(&self, _sel: &ResolvedSelector) -> automation::Result<ElementState> {
        Ok(ElementState {
            visible: true,
            bbox: Some(BoundingBox {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            }),
            animating: false,
            in_viewport: true,
        })
    }

    async fn current_cursor_position(&self) -> automation::Result<(i32, i32)> {
        Ok((0, 0))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }

    fn name(&self) -> &'static str {
        "tracking"
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

async fn run_with_pacing(src: &str, pacing: PacingProfile) -> Tracking {
    let tracking = Tracking::default();
    let tmp = tempfile::tempdir().unwrap();
    let mut rx = automation::Executor::run_with_story_path_and_pacing(
        parse_story(src),
        None,
        Box::new(TrackingDriver::new(tracking.clone())),
        Box::new(NoopDriver::new()),
        None,
        tmp.path().join("shots"),
        Default::default(),
        None,
        false,
        pacing,
        false,
    );
    timeout(Duration::from_secs(5), async {
        while let Some(event) = rx.recv().await {
            if matches!(event, ExecutorEvent::StoryEnded { .. }) {
                break;
            }
        }
    })
    .await
    .expect("executor completes");
    tracking
}

#[tokio::test]
async fn raw_pacing_adds_no_automatic_waits() {
    let tracking = run_with_pacing(
        r##"story "raw" {
  meta { app: "about:blank" }
  scene "s" {
    click selector "#save"
    screenshot "done"
  }
}
"##,
        PacingProfile::Raw,
    )
    .await;

    assert_eq!(*tracking.waits.lock().unwrap(), Vec::<u64>::new());
    assert_eq!(
        *tracking.actions.lock().unwrap(),
        vec!["click", "screenshot"]
    );
}

#[tokio::test]
async fn normal_pacing_adds_click_and_screenshot_dwells() {
    let tracking = run_with_pacing(
        r##"story "normal" {
  meta { app: "about:blank" }
  scene "s" {
    click selector "#save"
    screenshot "done"
  }
}
"##,
        PacingProfile::Normal,
    )
    .await;

    assert_eq!(*tracking.waits.lock().unwrap(), vec![250, 450, 1000]);
    assert_eq!(
        *tracking.actions.lock().unwrap(),
        vec!["click", "screenshot"]
    );
}

#[tokio::test]
async fn explicit_wait_is_not_multiplied_by_pacing() {
    let tracking = run_with_pacing(
        r#"story "wait" {
  meta { app: "about:blank" }
  scene "s" {
    wait 1000ms
    screenshot "done"
  }
}
"#,
        PacingProfile::Normal,
    )
    .await;

    assert_eq!(*tracking.waits.lock().unwrap(), vec![1000, 1000]);
    assert_eq!(*tracking.actions.lock().unwrap(), vec!["screenshot"]);
}

#[tokio::test]
async fn navigate_wait_for_settles_once_after_wait_for() {
    let tracking = run_with_pacing(
        r##"story "nav" {
  meta { app: "about:blank" }
  scene "s" {
    navigate "https://example.com"
    wait-for selector "#app"
    screenshot "ready"
  }
}
"##,
        PacingProfile::Normal,
    )
    .await;

    assert_eq!(*tracking.waits.lock().unwrap(), vec![700, 1000]);
    assert_eq!(
        *tracking.actions.lock().unwrap(),
        vec!["navigate", "wait-for", "screenshot"]
    );
}
