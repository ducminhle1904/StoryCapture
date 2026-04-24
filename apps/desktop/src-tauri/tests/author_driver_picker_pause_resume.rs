// Phase 11-03 D-12 coverage — pause/resume invariant on every exit path
// of `picker_start_author_impl`. The mock `AuthorPreviewControl` records
// pause/resume counters + allows simulating user-cancel, unsupported-url,
// timeout, driver error, and panic exit paths.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use automation::PickElementResponse;
use storycapture::author_driver::{AuthorDriverRegistry, AuthorDriverState};
use storycapture::commands::picker::{picker_start_author_impl, AuthorPreviewControl};
use storycapture::error::AppError;

// Mock that counts pause/resume calls and lets the test script the pick
// outcome (Ok(Picked) / Ok(Cancelled::<reason>) / Err).
struct MockControl {
    paused: AtomicUsize,
    resumed: AtomicUsize,
    navigate_calls: AtomicUsize,
    pick_outcome: std::sync::Mutex<Option<Result<PickElementResponse, AppError>>>,
    // If set, panic inside pick_element_start_author to drive PR-5.
    panic_in_pick: bool,
}

impl MockControl {
    fn new(outcome: Result<PickElementResponse, AppError>) -> Self {
        Self {
            paused: AtomicUsize::new(0),
            resumed: AtomicUsize::new(0),
            navigate_calls: AtomicUsize::new(0),
            pick_outcome: std::sync::Mutex::new(Some(outcome)),
            panic_in_pick: false,
        }
    }
    fn panicking() -> Self {
        Self {
            paused: AtomicUsize::new(0),
            resumed: AtomicUsize::new(0),
            navigate_calls: AtomicUsize::new(0),
            pick_outcome: std::sync::Mutex::new(None),
            panic_in_pick: true,
        }
    }
}

#[async_trait]
impl AuthorPreviewControl for MockControl {
    async fn author_navigate_to(&self, _stream_id: &str, _url: &str) -> Result<(), AppError> {
        self.navigate_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn pause_author_preview(&self, _stream_id: &str) -> Result<(), AppError> {
        self.paused.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn resume_author_preview(&self, _stream_id: &str) -> Result<(), AppError> {
        self.resumed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn pick_element_start_author(
        &self,
        _stream_id: &str,
        _timeout_ms: u64,
    ) -> Result<PickElementResponse, AppError> {
        if self.panic_in_pick {
            panic!("simulated panic inside pick_element_start_author");
        }
        self.pick_outcome
            .lock()
            .unwrap()
            .take()
            .expect("pick_outcome consumed twice")
    }
}

fn tiny_story() -> String {
    "story \"PR\" { meta { app: \"https://x.test\" } scene \"s\" { click \"Ok\" } }".into()
}

fn picked_response() -> PickElementResponse {
    // Minimal Picked variant — test only checks counters, not payload.
    serde_json::from_value(serde_json::json!({
        "emitted": "click \"Ok\"",
        "locator": { "kind": "selector", "value": "#ok" },
        "candidates": []
    }))
    .expect("construct Picked")
}

fn cancelled(reason: &str) -> PickElementResponse {
    serde_json::from_value(serde_json::json!({
        "cancelled": true,
        "reason": reason
    }))
    .expect("construct Cancelled")
}

// Helper: seed the registry in LivePreview and run the picker once.
async fn run_once(
    mock: Arc<MockControl>,
) -> (Arc<AuthorDriverRegistry>, Result<(), AppError>) {
    let registry = AuthorDriverRegistry::new();
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }
    let res = picker_start_author_impl(
        registry.clone(),
        mock,
        "s1".into(),
        tiny_story(),
        999,
        5_000,
    )
    .await
    .map(|_dto| ());
    (registry, res)
}

// PR-1: happy path — pause/resume each fire exactly once; final state is
// LivePreview; picker returns Ok.
#[tokio::test]
async fn pr1_happy_path_pause_resume_once_each() {
    let mock = Arc::new(MockControl::new(Ok(picked_response())));
    let (registry, res) = run_once(mock.clone()).await;
    res.expect("happy path ok");
    assert_eq!(mock.paused.load(Ordering::SeqCst), 1);
    assert_eq!(mock.resumed.load(Ordering::SeqCst), 1);
    let g = registry.state.lock().await;
    assert!(matches!(&*g, AuthorDriverState::LivePreview { .. }));
}

// PR-2: user-cancel exit path — resume still fires, state restores.
#[tokio::test]
async fn pr2_user_cancel_resumes() {
    let mock = Arc::new(MockControl::new(Ok(cancelled("user-cancel"))));
    let (registry, res) = run_once(mock.clone()).await;
    res.expect("cancel is still Ok at the Rust layer — payload carries cancelled flag");
    assert_eq!(mock.resumed.load(Ordering::SeqCst), 1, "resume must fire on user-cancel");
    let g = registry.state.lock().await;
    assert!(matches!(&*g, AuthorDriverState::LivePreview { .. }));
}

// PR-3: unsupported-url exit path — resume still fires.
#[tokio::test]
async fn pr3_unsupported_url_resumes() {
    let mock = Arc::new(MockControl::new(Ok(cancelled("unsupported-url"))));
    let (registry, res) = run_once(mock.clone()).await;
    res.expect("unsupported-url surfaces as cancelled payload, not Err");
    assert_eq!(mock.resumed.load(Ordering::SeqCst), 1);
    let g = registry.state.lock().await;
    assert!(matches!(&*g, AuthorDriverState::LivePreview { .. }));
}

// PR-4: driver error (pick itself returns Err) — resume still fires via
// the explicit "always resume" branch in picker_start_author_impl.
#[tokio::test]
async fn pr4_driver_error_resumes() {
    let mock = Arc::new(MockControl::new(Err(AppError::Automation(
        "sidecar exploded".into(),
    ))));
    let (registry, res) = run_once(mock.clone()).await;
    assert!(
        matches!(res, Err(AppError::Automation(ref m)) if m.contains("sidecar exploded")),
        "driver error must propagate; got {res:?}"
    );
    assert_eq!(
        mock.resumed.load(Ordering::SeqCst),
        1,
        "resume must fire even when the pick errors"
    );
    // end_pick ran — state should be LivePreview (success-style restore).
    let g = registry.state.lock().await;
    assert!(matches!(&*g, AuthorDriverState::LivePreview { .. }));
}

// PR-5: panic during pick — `PickerResumeGuard::Drop` restores the prior
// state via a spawned task; resume is NOT expected on this path (Drop's
// TODO-commented hook is not yet wired — that's 11-03+ work beyond this
// plan's guarantee). We verify the FSM invariant: after unwind and a few
// yields, state MUST NOT be stuck in Picking — it must revert to the
// prior LivePreview state.
#[tokio::test]
async fn pr5_panic_in_pick_fsm_reverts_via_guard_drop() {
    let mock = Arc::new(MockControl::panicking());
    let registry = AuthorDriverRegistry::new();
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }

    // Spawn the picker on a worker task. The mock panics inside pick,
    // which unwinds through picker_start_author_impl — the Drop impl on
    // PickerResumeGuard runs during unwind and fires off the FSM-revert
    // spawn. JoinError signals the panic to our observation point without
    // needing futures_util::catch_unwind.
    let registry_for_run = registry.clone();
    let join = tokio::spawn(async move {
        picker_start_author_impl(
            registry_for_run,
            mock,
            "s1".into(),
            tiny_story(),
            999,
            5_000,
        )
        .await
    });
    let join_result = join.await;
    assert!(
        join_result.is_err() && join_result.as_ref().unwrap_err().is_panic(),
        "task must unwind via panic so PickerResumeGuard Drop fires; got {:?}",
        join_result
    );

    // Yield generously so the PickerResumeGuard's spawned Drop task lands.
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }

    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "panic-path Drop must revert FSM to prior LivePreview; got {:?}",
        *g
    );
}

// PR-6: pause fires BEFORE pick (the Task 2 orchestration explicitly
// documents pause as step 4, pick as step 5). This regression guards
// against accidental reordering that would leave the picker overlay
// fighting the screencast CDP for CPU.
#[tokio::test]
async fn pr6_pause_precedes_pick() {
    // Capture ordering by using a dedicated counter that pick_outcome
    // inspects. Build a shim control that records ordering inline.
    struct OrderCtrl {
        paused_before_pick: std::sync::atomic::AtomicBool,
        pause_count: AtomicUsize,
    }
    #[async_trait]
    impl AuthorPreviewControl for OrderCtrl {
        async fn author_navigate_to(&self, _s: &str, _u: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn pause_author_preview(&self, _s: &str) -> Result<(), AppError> {
            self.pause_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn resume_author_preview(&self, _s: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn pick_element_start_author(
            &self,
            _s: &str,
            _t: u64,
        ) -> Result<PickElementResponse, AppError> {
            // If pause hasn't fired yet, we've regressed.
            if self.pause_count.load(Ordering::SeqCst) >= 1 {
                self.paused_before_pick.store(true, Ordering::SeqCst);
            }
            Ok(picked_response())
        }
    }
    let ctrl = Arc::new(OrderCtrl {
        paused_before_pick: std::sync::atomic::AtomicBool::new(false),
        pause_count: AtomicUsize::new(0),
    });
    let registry = AuthorDriverRegistry::new();
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }
    picker_start_author_impl(
        registry,
        ctrl.clone(),
        "s1".into(),
        tiny_story(),
        999,
        5_000,
    )
    .await
    .expect("happy path");
    assert!(
        ctrl.paused_before_pick.load(Ordering::SeqCst),
        "pause_author_preview MUST fire before pick_element_start_author"
    );
}
