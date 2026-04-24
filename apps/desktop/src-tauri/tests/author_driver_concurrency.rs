// AuthorDriverRegistry concurrency tests (Phase 11-01, D-13/D-15 host-layer
// guard per Pitfall 6). Exercises the shared tokio::Mutex<AuthorDriverState>
// and the PickerResumeGuard Drop path.

use std::sync::Arc;

use storycapture::author_driver::{
    AuthorDriverError, AuthorDriverRegistry, AuthorDriverState, PickerResumeGuard,
};

// CC-1: Two tasks race can_start_pick + transition under the mutex; exactly
// one succeeds, the loser gets AlreadyPicking.
#[tokio::test]
async fn concurrent_pick_start_exactly_one_wins() {
    let registry = Arc::new(AuthorDriverRegistry::default());

    // Seed state: LivePreview (both tasks are valid candidates).
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }

    async fn try_start(registry: Arc<AuthorDriverRegistry>) -> Result<(), AuthorDriverError> {
        // Critical section: check + transition while holding the lock.
        let mut g = registry.state.lock().await;
        g.can_start_pick()?;
        g.begin_pick("s1".into());
        Ok(())
    }

    let r1 = registry.clone();
    let r2 = registry.clone();
    let h1 = tokio::spawn(async move { try_start(r1).await });
    let h2 = tokio::spawn(async move { try_start(r2).await });

    let a = h1.await.unwrap();
    let b = h2.await.unwrap();

    let (ok_count, err_count) = [&a, &b].iter().fold((0, 0), |(o, e), r| match r {
        Ok(()) => (o + 1, e),
        Err(_) => (o, e + 1),
    });
    assert_eq!(ok_count, 1, "exactly one task should win the pick race");
    assert_eq!(err_count, 1, "exactly one task should lose");

    // Loser must observe AlreadyPicking (not SimulatorBusy).
    let loser = [a, b].into_iter().find(|r| r.is_err()).unwrap();
    assert!(matches!(loser, Err(AuthorDriverError::AlreadyPicking)));

    let g = registry.state.lock().await;
    assert!(matches!(*g, AuthorDriverState::Picking { .. }));
}

// CC-2a: PickerResumeGuard armed + dropped WITHOUT disarm reverts state.
#[tokio::test]
async fn resume_guard_reverts_state_on_drop() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::SimulatorPaused {
            session: "run1".into(),
        };
    }

    // Take the prior state, transition into Picking, arm the guard.
    {
        let mut g = registry.state.lock().await;
        let prior = g.clone();
        g.begin_pick("s1".into());
        // Guard captures the prior (SimulatorPaused) state to restore on Drop.
        let _guard = PickerResumeGuard::new(registry.clone(), "s1".into(), prior);
        // Drop the mutex guard before the resume guard goes out of scope;
        // the Drop impl re-acquires the registry mutex inside a spawned task.
        drop(g);
        // _guard drops at end of this scope without disarm.
    }

    // Drop's spawned task is async — yield several times to let it run.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::SimulatorPaused { session } if session == "run1"),
        "PickerResumeGuard Drop must restore the prior SimulatorPaused state; got {:?}",
        *g
    );
}

// CC-2b: PickerResumeGuard disarmed -> Drop is a no-op, state is NOT
// reverted (command body owns restoration on the success path).
#[tokio::test]
async fn resume_guard_disarm_is_noop_on_drop() {
    let registry = Arc::new(AuthorDriverRegistry::default());
    {
        let mut g = registry.state.lock().await;
        *g = AuthorDriverState::LivePreview {
            stream_id: "s1".into(),
        };
    }

    {
        let mut g = registry.state.lock().await;
        let prior = g.clone();
        g.begin_pick("s1".into());
        let guard = PickerResumeGuard::new(registry.clone(), "s1".into(), prior);
        drop(g);
        guard.disarm();
        // guard drops here — disarm already took the restore; Drop is no-op.
    }

    // Yield generously to guarantee no stale spawn flips state out from under us.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    let g = registry.state.lock().await;
    assert!(
        matches!(&*g, AuthorDriverState::Picking { .. }),
        "disarmed guard must NOT revert state; expected Picking, got {:?}",
        *g
    );
}

// CC-3: Under the lock, can_start_simulator rejects Picking (host-layer
// guard per Pitfall 6 — UI-only gating is insufficient).
#[tokio::test]
async fn host_layer_guards_simulator_start_against_picking() {
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
