// Phase 11-05 simulator-side FSM integration tests. Gap-closure for
// PHASE-11.1 / PHASE-11.8 — proves the commands/simulator.rs call
// surface can drive AuthorDriverRegistry through the D-13 / D-14 / D-15
// matrix without a live sidecar harness. Real Tauri command invocation
// requires an App instance which is heavy; instead these tests exercise
// the helpers DIRECTLY against AuthorDriverRegistry + the stable
// picker_start_author_impl trait seam.

use std::sync::Arc;

use async_trait::async_trait;
use automation::PickElementResponse;
use storycapture::author_driver::{AuthorDriverError, AuthorDriverRegistry, AuthorDriverState};
use storycapture::commands::picker::{picker_start_author_impl, AuthorPreviewControl};
use storycapture::error::AppError;

// --- Stub AuthorPreviewControls -------------------------------------------

/// Panicking stub — used when a test must prove the picker's can_start_pick
/// gate rejected BEFORE any side effect was performed (SL-3).
struct NeverCalled;
#[async_trait]
impl AuthorPreviewControl for NeverCalled {
    async fn author_navigate_to(&self, _s: &str, _u: &str) -> Result<(), AppError> {
        panic!("author_navigate_to must not be called — picker gate should reject first")
    }
    async fn pause_author_preview(&self, _s: &str) -> Result<(), AppError> {
        panic!("pause_author_preview must not be called — picker gate should reject first")
    }
    async fn resume_author_preview(&self, _s: &str) -> Result<(), AppError> {
        panic!("resume_author_preview must not be called — picker gate should reject first")
    }
    async fn pick_element_start_author(
        &self,
        _s: &str,
        _t: u64,
    ) -> Result<PickElementResponse, AppError> {
        panic!("pick_element_start_author must not be called — picker gate should reject first")
    }
}

/// Happy-path stub — accepts all calls, returns Picked. Used when the
/// test needs the pick flow to run end-to-end and only inspects FSM state.
#[derive(Default)]
struct StubPickOk;
#[async_trait]
impl AuthorPreviewControl for StubPickOk {
    async fn author_navigate_to(&self, _s: &str, _u: &str) -> Result<(), AppError> {
        Ok(())
    }
    async fn pause_author_preview(&self, _s: &str) -> Result<(), AppError> {
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
        Ok(picked_response())
    }
}

fn picked_response() -> PickElementResponse {
    // Mirrors the serde_json construction used in PR-1..PR-6. Picked is
    // an untagged variant keyed by the `emitted` field.
    serde_json::from_value(serde_json::json!({
        "emitted": "click \"Save\"",
        "locator": { "kind": "selector", "value": "#save" },
        "candidates": []
    }))
    .expect("construct Picked")
}

fn tiny_story() -> String {
    "story \"SL\" { meta { app: \"https://x.test\" } scene \"s\" { click \"Save\" } }".into()
}

// --- SL-1..SL-8 -----------------------------------------------------------

// SL-1 (D-15 reject): the simulator_start gate (can_start_simulator then
// begin_simulator) MUST refuse and leave registry unchanged when state is
// Picking.
#[tokio::test]
async fn sl_1_simulator_start_rejected_during_pick() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::Picking {
            stream_id: "s1".into(),
            resume_to: None,
        };
    }

    // Simulate the gate simulator_start MUST run under the registry lock:
    // can_start_simulator then begin_simulator iff ok.
    let result = {
        let mut g = registry.state.lock().await;
        match g.can_start_simulator() {
            Ok(()) => {
                // If this ever runs, the gate is broken and state would be clobbered.
                let _prior = g.begin_simulator("should-not-happen".into());
                Ok(())
            }
            Err(e) => Err(e),
        }
    };

    assert!(
        matches!(result, Err(AuthorDriverError::AlreadyPicking)),
        "can_start_simulator must reject with AlreadyPicking; got {:?}",
        result
    );

    // State must NOT have been clobbered by begin_simulator.
    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::Picking { .. }),
        "registry must remain in Picking; got {:?}",
        *g
    );
}

// SL-2 (D-15 happy transition + snapshot): simulator_start from
// LivePreview must:
//   1) validate can_start_simulator()
//   2) transition to SimulatorRunning{session}
//   3) return the prior LivePreview{s1} snapshot so simulator_cancel /
//      StoryEnded can restore it.
#[tokio::test]
async fn sl_2_simulator_start_happy_transition_and_snapshot() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }

    let prior = {
        let mut g = registry.state.lock().await;
        g.can_start_simulator()
            .expect("guard must allow from LivePreview");
        g.begin_simulator("run1".into())
    };

    assert!(
        matches!(&prior, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "begin_simulator must return prior LivePreview snapshot; got {:?}",
        prior
    );

    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::SimulatorRunning { session } if session == "run1"),
        "registry must be SimulatorRunning{{run1}}; got {:?}",
        *g
    );
}

// SL-3 (D-13 host-side reject): With registry in SimulatorRunning, the
// picker's host-side FSM gate (can_start_pick inside
// picker_start_author_impl) must reject BEFORE any AuthorPreviewControl
// method fires. The NeverCalled stub enforces this by panicking on any
// call.
#[tokio::test]
async fn sl_3_pick_rejected_while_simulator_running() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorRunning {
            session: "run1".into(),
        };
    }

    let result = picker_start_author_impl(
        registry.clone(),
        Arc::new(NeverCalled),
        "s1".into(),
        tiny_story(),
        999,
        1_000,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Automation(ref m)) if m.contains("Simulator running")),
        "picker must reject SimulatorBusy while SimulatorRunning; got {:?}",
        result
    );

    // Registry must remain SimulatorRunning — gate rejected BEFORE begin_pick.
    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::SimulatorRunning { session } if session == "run1"),
        "registry must still be SimulatorRunning; got {:?}",
        *g
    );
}

// SL-4 (D-14 round-trip): Pick from SimulatorPaused must restore
// SimulatorPaused on completion. Exercises begin_pick's resume_to box +
// end_pick's restore. This already passes at the FSM-layer today; SL-4
// re-proves it through the production orchestration
// (picker_start_author_impl), now that Task 2 wires simulator.rs to
// write SimulatorPaused in the production code path.
#[tokio::test]
async fn sl_4_pick_from_paused_round_trips() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorPaused {
            session: "run1".into(),
        };
    }

    let _ = picker_start_author_impl(
        registry.clone(),
        Arc::new(StubPickOk::default()),
        "s1".into(),
        tiny_story(),
        999,
        1_000,
    )
    .await
    .expect("pick from SimulatorPaused must succeed");

    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "after pick from SimulatorPaused, state must restore to SimulatorPaused{{run1}}; got {:?}",
        *g
    );
}

// SL-5 (D-15 gate — helper view): Direct re-check of can_start_simulator
// rejecting Picking. Redundant with CC-3 but documents the gate from
// the simulator.rs lens.
#[tokio::test]
async fn sl_5_can_start_simulator_rejects_picking() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::Picking {
            stream_id: "s1".into(),
            resume_to: None,
        };
    }
    let g = registry.state.lock().await;
    assert!(matches!(
        g.can_start_simulator(),
        Err(AuthorDriverError::AlreadyPicking)
    ));
}

// SL-6 (D-14 pause writeback — forwarder RunPaused analog): Seeding
// SimulatorRunning and calling pause_simulator under the registry lock
// flips to SimulatorPaused preserving session. This is the FSM-layer
// analog of what the spawn_run forwarder does on ExecutorEvent::RunPaused.
#[tokio::test]
async fn sl_6_pause_simulator_writeback() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorRunning {
            session: "run1".into(),
        };
    }
    {
        let mut g = registry.state.lock().await;
        g.pause_simulator();
    }
    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "pause_simulator must flip Running -> Paused preserving session; got {:?}",
        *g
    );
}

// SL-7 (cancel restore — FSM analog of simulator_cancel): after
// begin_simulator from LivePreview and end_simulator(prior), state is
// LivePreview. Mirrors the write simulator_cancel performs via the
// ResumableSession.prior_author_driver_state snapshot.
#[tokio::test]
async fn sl_7_end_simulator_restores_live_preview() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    let prior = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorRunning {
            session: "run1".into(),
        };
    }
    {
        let mut g = registry.state.lock().await;
        g.end_simulator(prior.clone());
    }
    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "end_simulator(prior=LivePreview) must restore LivePreview; got {:?}",
        *g
    );
}

// SL-8 (double-cancel idempotence): end_simulator is a no-op if current
// state is not Simulator*. Guards the race where StoryEnded and
// simulator_cancel both fire end_simulator.
#[tokio::test]
async fn sl_8_end_simulator_idempotent_when_already_restored() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    let prior = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorRunning {
            session: "run1".into(),
        };
    }
    {
        let mut g = registry.state.lock().await;
        g.end_simulator(prior.clone());
        // Second call — state is already LivePreview; MUST be a no-op.
        g.end_simulator(AuthorDriverState::Idle);
    }
    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "second end_simulator must be a no-op; state must remain LivePreview, got {:?}",
        *g
    );
}
