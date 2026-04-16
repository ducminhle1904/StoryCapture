// Integration tests for the DryRunOrchestrator (Plan 03-16, Task 1).
//
// Uses a `MockBrowserDriver` with a pre-planned result queue to exercise
// the orchestrator's event emission, failure handling, selector fallback
// chain preservation, cancellation, and timing accumulation.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use tokio::sync::mpsc;

use intelligence::dryrun::{
    run, BrowserDriver, DriverError, DryRunEvent, ExecStep, SelectorAttempt, StepResult,
};

// ---------------------------------------------------------------------------
// Mock driver
// ---------------------------------------------------------------------------

struct MockBrowserDriver {
    plan: Mutex<VecDeque<Result<StepResult, MockDriverError>>>,
}

/// We need our own error type that can convert to DriverError because
/// DriverError is not Clone. The mock stores these and converts on execute.
enum MockDriverError {
    SelectorNotFound {
        message: String,
        selector_attempts: Vec<SelectorAttempt>,
    },
}

impl MockBrowserDriver {
    fn new(plan: Vec<Result<StepResult, MockDriverError>>) -> Self {
        Self {
            plan: Mutex::new(plan.into()),
        }
    }
}

#[async_trait]
impl BrowserDriver for MockBrowserDriver {
    async fn execute(&self, _step: &ExecStep) -> Result<StepResult, DriverError> {
        let next = self
            .plan
            .lock()
            .unwrap()
            .pop_front()
            .expect("MockBrowserDriver: no more planned results");
        match next {
            Ok(r) => Ok(r),
            Err(MockDriverError::SelectorNotFound {
                message,
                selector_attempts,
            }) => Err(DriverError::SelectorNotFound {
                message,
                selector_attempts,
            }),
        }
    }

    async fn navigate(&self, _url: &str) -> Result<(), DriverError> {
        Ok(())
    }

    async fn close(&self) -> Result<(), DriverError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_steps(n: usize) -> Vec<ExecStep> {
    (0..n)
        .map(|i| ExecStep {
            id: format!("step-{i}"),
            verb: "click".into(),
            target: Some(format!("#btn-{i}")),
            value: None,
        })
        .collect()
}

fn ok_result(elapsed_ms: u64) -> Result<StepResult, MockDriverError> {
    Ok(StepResult {
        elapsed_ms,
        selector_attempts: vec![SelectorAttempt {
            strategy: "explicit-testid".into(),
            success: true,
            elapsed_ms: elapsed_ms / 2,
        }],
        screenshot: None,
    })
}

async fn collect_events(mut rx: mpsc::Receiver<DryRunEvent>) -> Vec<DryRunEvent> {
    let mut events = Vec::new();
    while let Some(ev) = rx.recv().await {
        events.push(ev);
    }
    events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Test 1 (happy): 3 steps all pass; orchestrator emits
/// Queued*3, Running*3, Pass*3, Summary, Done.
#[tokio::test]
async fn happy_path_three_steps_all_pass() {
    let driver = MockBrowserDriver::new(vec![ok_result(100), ok_result(200), ok_result(150)]);
    let steps = make_steps(3);
    let (tx, rx) = mpsc::channel(64);

    let task_id = "task-happy".to_string();
    let handle = tokio::spawn(async move {
        run(&driver, steps, task_id, tx).await.unwrap();
    });

    let events = collect_events(rx).await;
    handle.await.unwrap();

    // Count event kinds.
    let queued = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Queued { .. }))
        .count();
    let running = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Running { .. }))
        .count();
    let pass = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Pass { .. }))
        .count();
    let summary = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Summary { .. }))
        .count();
    let done = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Done { .. }))
        .count();

    assert_eq!(queued, 3, "expected 3 Queued events");
    assert_eq!(running, 3, "expected 3 Running events");
    assert_eq!(pass, 3, "expected 3 Pass events");
    assert_eq!(summary, 1, "expected 1 Summary event");
    assert_eq!(done, 1, "expected 1 Done event");

    // Verify summary content.
    if let Some(DryRunEvent::Summary {
        total_steps,
        passed,
        failed,
        total_ms,
    }) = events.iter().find(|e| matches!(e, DryRunEvent::Summary { .. }))
    {
        assert_eq!(*total_steps, 3);
        assert_eq!(*passed, 3);
        assert_eq!(*failed, 0);
        assert_eq!(*total_ms, 450); // 100 + 200 + 150
    }
}

/// Test 2 (failure): step 2 fails; orchestrator emits Fail for step 2,
/// skips remaining steps, emits Summary { passed: 1, failed: 1, ... } and Done.
#[tokio::test]
async fn failure_stops_on_first_error() {
    let driver = MockBrowserDriver::new(vec![
        ok_result(50),
        Err(MockDriverError::SelectorNotFound {
            message: "element not found".into(),
            selector_attempts: vec![SelectorAttempt {
                strategy: "explicit-testid".into(),
                success: false,
                elapsed_ms: 80,
            }],
        }),
        ok_result(100), // should NOT be reached
    ]);
    let steps = make_steps(3);
    let (tx, rx) = mpsc::channel(64);

    let task_id = "task-fail".to_string();
    let handle = tokio::spawn(async move {
        run(&driver, steps, task_id, tx).await.unwrap();
    });

    let events = collect_events(rx).await;
    handle.await.unwrap();

    let fail_count = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Fail { .. }))
        .count();
    let pass_count = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Pass { .. }))
        .count();

    assert_eq!(fail_count, 1, "expected 1 Fail event");
    assert_eq!(pass_count, 1, "expected 1 Pass event (step 0 only)");

    // Only 2 Running events (step 0 + step 1), step 2 never started.
    let running_count = events
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Running { .. }))
        .count();
    assert_eq!(running_count, 2, "step 2 should never start");

    // Summary should show passed=1, failed=1.
    if let Some(DryRunEvent::Summary {
        passed, failed, ..
    }) = events.iter().find(|e| matches!(e, DryRunEvent::Summary { .. }))
    {
        assert_eq!(*passed, 1);
        assert_eq!(*failed, 1);
    } else {
        panic!("no Summary event found");
    }
}

/// Test 3 (selector fallback chain): mock driver returns a StepResult with
/// multiple selector attempts; orchestrator preserves the chain verbatim in
/// the Pass event.
#[tokio::test]
async fn selector_fallback_chain_preserved_in_pass_event() {
    let chain = vec![
        SelectorAttempt {
            strategy: "explicit-testid".into(),
            success: false,
            elapsed_ms: 50,
        },
        SelectorAttempt {
            strategy: "accessible-name".into(),
            success: true,
            elapsed_ms: 120,
        },
    ];

    let driver = MockBrowserDriver::new(vec![Ok(StepResult {
        elapsed_ms: 170,
        selector_attempts: chain.clone(),
        screenshot: None,
    })]);
    let steps = make_steps(1);
    let (tx, rx) = mpsc::channel(64);

    let task_id = "task-chain".to_string();
    let handle = tokio::spawn(async move {
        run(&driver, steps, task_id, tx).await.unwrap();
    });

    let events = collect_events(rx).await;
    handle.await.unwrap();

    // Find the Pass event and verify the selector_attempts chain.
    let pass_event = events
        .iter()
        .find(|e| matches!(e, DryRunEvent::Pass { .. }))
        .expect("no Pass event found");

    if let DryRunEvent::Pass {
        selector_attempts, ..
    } = pass_event
    {
        assert_eq!(selector_attempts.len(), 2);
        assert_eq!(selector_attempts[0].strategy, "explicit-testid");
        assert!(!selector_attempts[0].success);
        assert_eq!(selector_attempts[0].elapsed_ms, 50);
        assert_eq!(selector_attempts[1].strategy, "accessible-name");
        assert!(selector_attempts[1].success);
        assert_eq!(selector_attempts[1].elapsed_ms, 120);
    }
}

/// Test 4 (cancel): while running a 10-step dry-run, abort after step 3.
/// The orchestrator stops emitting further events cleanly.
#[tokio::test]
async fn cancel_aborts_mid_run() {
    // Each step takes ~10ms via tokio::time::sleep inside the mock.
    struct SlowMockDriver;

    #[async_trait]
    impl BrowserDriver for SlowMockDriver {
        async fn execute(&self, _step: &ExecStep) -> Result<StepResult, DriverError> {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Ok(StepResult {
                elapsed_ms: 10,
                selector_attempts: vec![],
                screenshot: None,
            })
        }
        async fn navigate(&self, _url: &str) -> Result<(), DriverError> {
            Ok(())
        }
        async fn close(&self) -> Result<(), DriverError> {
            Ok(())
        }
    }

    let driver = SlowMockDriver;
    let steps = make_steps(10);
    let (tx, mut rx) = mpsc::channel(64);

    let task_id = "task-cancel".to_string();
    let join = tokio::spawn(async move {
        run(&driver, steps, task_id, tx).await.ok();
    });
    let abort_handle = join.abort_handle();

    // Collect events until we see at least 3 Pass events, then abort.
    let mut collected = Vec::new();
    let mut pass_seen = 0usize;
    while let Some(ev) = rx.recv().await {
        if matches!(&ev, DryRunEvent::Pass { .. }) {
            pass_seen += 1;
        }
        collected.push(ev);
        if pass_seen >= 3 {
            abort_handle.abort();
            break;
        }
    }
    // Drain any remaining buffered events.
    while let Ok(ev) = rx.try_recv() {
        collected.push(ev);
    }

    // We should have seen at least 3 Pass events but fewer than 10.
    let total_pass = collected
        .iter()
        .filter(|e| matches!(e, DryRunEvent::Pass { .. }))
        .count();
    assert!(
        total_pass >= 3,
        "expected at least 3 Pass events, got {total_pass}"
    );
    assert!(
        total_pass < 10,
        "expected fewer than 10 Pass events (abort should have stopped), got {total_pass}"
    );
}

/// Test 5 (summary timing): total_ms equals the sum of per-step elapsed_ms
/// within a tight tolerance.
#[tokio::test]
async fn summary_total_ms_matches_step_sum() {
    let driver = MockBrowserDriver::new(vec![
        ok_result(33),
        ok_result(67),
        ok_result(100),
        ok_result(50),
    ]);
    let steps = make_steps(4);
    let (tx, rx) = mpsc::channel(64);

    let task_id = "task-timing".to_string();
    let handle = tokio::spawn(async move {
        run(&driver, steps, task_id, tx).await.unwrap();
    });

    let events = collect_events(rx).await;
    handle.await.unwrap();

    // Sum elapsed_ms from Pass events.
    let step_sum: u64 = events
        .iter()
        .filter_map(|e| {
            if let DryRunEvent::Pass { elapsed_ms, .. } = e {
                Some(*elapsed_ms)
            } else {
                None
            }
        })
        .sum();

    // Extract Summary total_ms.
    let summary_total_ms = events
        .iter()
        .find_map(|e| {
            if let DryRunEvent::Summary { total_ms, .. } = e {
                Some(*total_ms)
            } else {
                None
            }
        })
        .expect("no Summary event found");

    let expected = 33 + 67 + 100 + 50; // 250
    assert_eq!(step_sum, expected);
    assert_eq!(summary_total_ms, expected);

    // Within tolerance (exact in mock, but verify the contract).
    let diff = (summary_total_ms as i64 - step_sum as i64).unsigned_abs();
    assert!(
        diff <= 50,
        "total_ms ({summary_total_ms}) and step sum ({step_sum}) differ by {diff}ms (tolerance: 50ms)"
    );
}
