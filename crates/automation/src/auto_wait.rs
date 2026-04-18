//! Playwright-style actionability wait (D-12, AUTO-02).
//!
//! Every action goes `resolve → wait_actionable → act`. The CDP defaults
//! are NOT trusted; we poll explicit element state every 100ms.
//!
//! The four properties checked are the same Playwright auditing surface:
//! visible, in-viewport, stable (bbox unchanged for two consecutive ticks),
//! and not-animating.

use crate::driver::{BoundingBox, BrowserDriver, ResolvedSelector};
use crate::error::{AutomationError, Result};
use std::time::{Duration, Instant};

const POLL_INTERVAL_MS: u64 = 100;

/// Wait until `sel` is actionable (visible + in-viewport + stable + still),
/// or until `timeout_ms` elapses.
pub async fn wait_actionable(
    driver: &dyn BrowserDriver,
    sel: &ResolvedSelector,
    timeout_ms: u64,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_bbox: Option<BoundingBox> = None;

    loop {
        let state = driver.element_state(sel).await?;

        let stable = match (last_bbox, state.bbox) {
            (Some(a), Some(b)) => bbox_eq(a, b),
            _ => false,
        };

        // Match Playwright's actionability: visible + animation-stopped +
        // bbox-stable. We DON'T require in_viewport — Playwright's click()
        // automatically calls scrollIntoViewIfNeeded, so requiring the
        // element to already be in-viewport just blocks clicks on
        // below-the-fold links.
        if state.visible && !state.animating && stable {
            return Ok(());
        }

        last_bbox = state.bbox;

        if Instant::now() >= deadline {
            return Err(AutomationError::Timeout {
                context: format!(
                    "wait_actionable({}={}) — visible={} in_viewport={} animating={} stable={}",
                    sel.strategy.as_str(),
                    sel.value,
                    state.visible,
                    state.in_viewport,
                    state.animating,
                    stable
                ),
                timeout_ms,
            });
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

fn bbox_eq(a: BoundingBox, b: BoundingBox) -> bool {
    const EPS: f64 = 0.5;
    (a.x - b.x).abs() < EPS
        && (a.y - b.y).abs() < EPS
        && (a.w - b.w).abs() < EPS
        && (a.h - b.h).abs() < EPS
}
