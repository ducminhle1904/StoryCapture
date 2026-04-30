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

// SM-10 (Phase 11-05, D-15 happy): begin_simulator on Idle transitions
// to SimulatorRunning{session} and returns the prior Idle state so the
// caller can stash it for later end_simulator().
#[test]
fn sm_10_begin_simulator_from_idle_returns_idle_and_transitions_to_running() {
    let mut s = AuthorDriverState::Idle;
    let prior = s.begin_simulator("run-abc".into());
    assert!(matches!(prior, AuthorDriverState::Idle));
    assert!(
        matches!(&s, AuthorDriverState::SimulatorRunning { session } if session == "run-abc"),
        "expected SimulatorRunning{{run-abc}}, got {:?}",
        s
    );
}

// SM-11 (Phase 11-05): begin_simulator on LivePreview{s1} returns the
// prior LivePreview snapshot and transitions to SimulatorRunning.
#[test]
fn sm_11_begin_simulator_from_live_preview_returns_live_preview_snapshot() {
    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    let prior = s.begin_simulator("run1".into());
    assert!(
        matches!(&prior, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "expected prior=LivePreview{{s1}}, got {:?}",
        prior
    );
    assert!(
        matches!(&s, AuthorDriverState::SimulatorRunning { session } if session == "run1"),
        "expected SimulatorRunning{{run1}}, got {:?}",
        s
    );
}

// SM-12 (Phase 11-05, D-14 registry writeback): pause_simulator on
// SimulatorRunning{s} transitions to SimulatorPaused{s} preserving the
// session identifier.
#[test]
fn sm_12_pause_simulator_transitions_running_to_paused_same_session() {
    let mut s = AuthorDriverState::SimulatorRunning {
        session: "run1".into(),
    };
    s.pause_simulator();
    assert!(
        matches!(&s, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "expected SimulatorPaused{{run1}}, got {:?}",
        s
    );
}

// SM-13 (Phase 11-05): pause_simulator on non-SimulatorRunning state is
// a no-op (guards against racey RunPaused arriving after simulator_cancel
// has already restored the prior state).
#[test]
fn sm_13_pause_simulator_is_noop_when_not_running() {
    let mut s = AuthorDriverState::Idle;
    s.pause_simulator();
    assert!(matches!(s, AuthorDriverState::Idle));

    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    s.pause_simulator();
    assert!(matches!(&s, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"));

    let mut s = AuthorDriverState::SimulatorPaused {
        session: "run1".into(),
    };
    s.pause_simulator();
    assert!(matches!(&s, AuthorDriverState::SimulatorPaused { session } if session == "run1"));

    let mut s = AuthorDriverState::Picking {
        stream_id: "s1".into(),
        resume_to: None,
    };
    s.pause_simulator();
    assert!(matches!(&s, AuthorDriverState::Picking { .. }));
}

// SM-14 (Phase 11-05, cancel/end restore): end_simulator on
// SimulatorRunning{s} with prior=LivePreview{s1} restores LivePreview{s1}.
#[test]
fn sm_14_end_simulator_from_running_with_prior_live_preview_restores() {
    let mut s = AuthorDriverState::SimulatorRunning {
        session: "run1".into(),
    };
    s.end_simulator(AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    });
    assert!(
        matches!(&s, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"),
        "expected LivePreview{{s1}}, got {:?}",
        s
    );
}

// SM-15 (Phase 11-05): end_simulator on SimulatorPaused{s} with
// prior=Idle restores Idle. Proves end_simulator works from either
// Simulator* variant.
#[test]
fn sm_15_end_simulator_from_paused_with_prior_idle_restores() {
    let mut s = AuthorDriverState::SimulatorPaused {
        session: "run1".into(),
    };
    s.end_simulator(AuthorDriverState::Idle);
    assert!(
        matches!(&s, AuthorDriverState::Idle),
        "expected Idle, got {:?}",
        s
    );
}

// SM-16 (Phase 11-05): end_simulator is a no-op when state is not
// Simulator* (guards double-cancel race between forwarder StoryEnded
// and simulator_cancel).
#[test]
fn sm_16_end_simulator_is_noop_when_not_simulator() {
    let mut s = AuthorDriverState::Idle;
    s.end_simulator(AuthorDriverState::LivePreview {
        stream_id: "bogus".into(),
    });
    assert!(matches!(s, AuthorDriverState::Idle));

    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    s.end_simulator(AuthorDriverState::Idle);
    assert!(matches!(&s, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1"));

    let mut s = AuthorDriverState::Picking {
        stream_id: "s1".into(),
        resume_to: None,
    };
    s.end_simulator(AuthorDriverState::Idle);
    assert!(matches!(&s, AuthorDriverState::Picking { .. }));
}

// SM-17 (Phase 11-05, D-14 enum-layer round-trip): begin_simulator ->
// pause_simulator -> begin_pick -> end_pick restores SimulatorPaused.
// Already passes via existing begin_pick/end_pick but now we exercise
// the full combined sequence with the new helpers.
#[test]
fn sm_17_simulator_paused_pick_round_trip_via_new_helpers() {
    // Start from LivePreview{s1}, launch simulator.
    let mut s = AuthorDriverState::LivePreview {
        stream_id: "s1".into(),
    };
    let prior_before_sim = s.begin_simulator("run1".into());
    assert!(
        matches!(&prior_before_sim, AuthorDriverState::LivePreview { stream_id } if stream_id == "s1")
    );
    // Simulator pauses (forwarder analog).
    s.pause_simulator();
    assert!(matches!(&s, AuthorDriverState::SimulatorPaused { session } if session == "run1"));
    // User picks from the paused state; begin_pick boxes the prior Paused.
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
                "expected resume_to=Some(SimulatorPaused{{run1}}), got {:?}",
                resume_to
            );
        }
        other => panic!("expected Picking{{stream_id:s1, resume_to:Some(SimulatorPaused{{run1}})}}, got {other:?}"),
    }
    // Pick ends; end_pick restores SimulatorPaused.
    s.end_pick();
    assert!(
        matches!(&s, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "end_pick with resume_to=SimulatorPaused must restore; got {:?}",
        s
    );
}
