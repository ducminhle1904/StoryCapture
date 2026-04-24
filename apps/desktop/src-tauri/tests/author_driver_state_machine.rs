// AuthorDriverState FSM tests (Phase 11-01, covers D-13/D-14/D-15/D-16).
//
// Exercises the pure-sync transition helpers on the enum — no tokio
// runtime, no Tauri State. Registry-level concurrency lives in the
// sibling `author_driver_concurrency.rs` test file.

use storycapture::author_driver::{AuthorDriverError, AuthorDriverState};

// SM-1: LivePreview -> Picking -> LivePreview round-trip keeps the stream_id.
#[test]
fn live_preview_pick_round_trip_preserves_stream_id() {
    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    s.begin_pick("s1".into());
    match &s {
        AuthorDriverState::Picking {
            stream_id,
            resume_to,
        } => {
            assert_eq!(stream_id, "s1");
            assert!(
                resume_to.is_none(),
                "pick from LivePreview should not carry a resume_to box"
            );
        }
        other => panic!("expected Picking, got {other:?}"),
    }
    s.end_pick();
    assert!(matches!(s, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"));
}

// SM-2 (D-14): Pick from SimulatorPaused carries resume_to=Some(paused); on exit, restore.
#[test]
fn pick_from_simulator_paused_restores_on_exit() {
    let mut s = AuthorDriverState::SimulatorPaused {
        session: "run1".into(),
    };
    s.begin_pick("s1".into());
    match &s {
        AuthorDriverState::Picking {
            stream_id,
            resume_to,
        } => {
            assert_eq!(stream_id, "s1");
            assert!(
                matches!(
                    resume_to.as_deref(),
                    Some(AuthorDriverState::SimulatorPaused { session }) if session == "run1"
                ),
                "resume_to must box the prior SimulatorPaused variant"
            );
        }
        other => panic!("expected Picking, got {other:?}"),
    }
    s.end_pick();
    assert!(
        matches!(&s, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "end_pick with resume_to must land back in SimulatorPaused"
    );
}

// SM-3 (D-13): can_start_pick rejects when SimulatorRunning.
#[test]
fn can_start_pick_rejects_simulator_running() {
    let s = AuthorDriverState::SimulatorRunning {
        session: "run1".into(),
    };
    assert!(matches!(
        s.can_start_pick(),
        Err(AuthorDriverError::SimulatorBusy)
    ));
}

// SM-4: can_start_pick rejects when already Picking.
#[test]
fn can_start_pick_rejects_when_already_picking() {
    let s = AuthorDriverState::Picking {
        stream_id: "s1".into(),
        resume_to: None,
    };
    assert!(matches!(
        s.can_start_pick(),
        Err(AuthorDriverError::AlreadyPicking)
    ));
}

// SM-5 (D-15): can_start_simulator rejects when Picking.
#[test]
fn can_start_simulator_rejects_when_picking() {
    let s = AuthorDriverState::Picking {
        stream_id: "s1".into(),
        resume_to: None,
    };
    assert!(matches!(
        s.can_start_simulator(),
        Err(AuthorDriverError::AlreadyPicking)
    ));
}

// SM-6: Default is Idle.
#[test]
fn default_is_idle() {
    let s = AuthorDriverState::default();
    assert!(matches!(s, AuthorDriverState::Idle));
}

// SM-7: can_start_pick is Ok from Idle and LivePreview.
#[test]
fn can_start_pick_ok_from_idle_and_live_preview() {
    assert!(AuthorDriverState::Idle.can_start_pick().is_ok());
    assert!(AuthorDriverState::LivePreview {
        stream_id: "s1".into()
    }
    .can_start_pick()
    .is_ok());
    // D-14: can_start_pick must allow SimulatorPaused.
    assert!(AuthorDriverState::SimulatorPaused {
        session: "run1".into()
    }
    .can_start_pick()
    .is_ok());
}

// SM-8: can_start_simulator is Ok from every non-Picking state.
#[test]
fn can_start_simulator_ok_outside_picking() {
    assert!(AuthorDriverState::Idle.can_start_simulator().is_ok());
    assert!(AuthorDriverState::LivePreview {
        stream_id: "s1".into()
    }
    .can_start_simulator()
    .is_ok());
    assert!(AuthorDriverState::SimulatorRunning {
        session: "run1".into()
    }
    .can_start_simulator()
    .is_ok());
    assert!(AuthorDriverState::SimulatorPaused {
        session: "run1".into()
    }
    .can_start_simulator()
    .is_ok());
}

// SM-9: end_pick on a non-Picking state is a no-op (defensive — never
// observed via the transition helpers, but the impl is defensive).
#[test]
fn end_pick_is_noop_when_not_picking() {
    let mut s = AuthorDriverState::Idle;
    s.end_pick();
    assert!(matches!(s, AuthorDriverState::Idle));

    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    s.end_pick();
    assert!(matches!(s, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"));
}
