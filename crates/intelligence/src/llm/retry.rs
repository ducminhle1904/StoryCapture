//! 429 / Retry-After exponential backoff with jitter, cap 3 retries.
//!
//! Implements AI-SPEC §4b pitfall #8:
//! - Parse `Retry-After` header (both seconds and HTTP-date forms).
//! - Exponential backoff `min(2^n, 30)s` with `[0, 1000ms)` jitter.
//! - Cap at 3 retries before surfacing `LlmError::Provider("retry exhausted")`.

use std::future::Future;
use std::time::Duration;

use super::LlmError;

// Re-export from the shared http module for backward compatibility.
pub use crate::http::parse_retry_after;

/// Exponential backoff delay for `attempt` (0-indexed): `min(2^attempt, 30)s`
/// plus `[0, 1000ms)` jitter.
pub fn backoff_delay(attempt: u32) -> Duration {
    let base_secs = (1u64 << attempt.min(5)).min(30);
    let jitter_ms = rand::random::<u64>() % 1000;
    Duration::from_millis(base_secs * 1000 + jitter_ms)
}

/// Retry `f` up to 3 total attempts on `LlmError::RateLimited`, waiting
/// the longer of `retry_after_s` or [`backoff_delay`]. Other errors bubble
/// immediately. After 3 consecutive rate-limit errors, returns
/// `LlmError::Provider("retry exhausted")`.
pub async fn with_backoff<F, Fut, T>(f: F) -> Result<T, LlmError>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, LlmError>>,
{
    with_backoff_inner(f, |d| Box::pin(tokio::time::sleep(d))).await
}

/// Test-facing variant of [`with_backoff`] that takes an injected async
/// sleeper. Production callers use [`with_backoff`].
pub async fn with_backoff_inner<F, Fut, T, S, SFut>(
    mut f: F,
    mut sleep_fn: S,
) -> Result<T, LlmError>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, LlmError>>,
    S: FnMut(Duration) -> SFut,
    SFut: Future<Output = ()>,
{
    for attempt in 0..3u32 {
        match f(attempt).await {
            Ok(v) => return Ok(v),
            Err(LlmError::RateLimited { retry_after_s }) => {
                let hdr_wait = Duration::from_secs(retry_after_s);
                let back_wait = backoff_delay(attempt);
                let wait = if hdr_wait > back_wait { hdr_wait } else { back_wait };
                sleep_fn(wait).await;
            }
            Err(other) => return Err(other),
        }
    }
    Err(LlmError::Provider("retry exhausted".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn backoff_delay_is_capped_and_jittered() {
        // 2^0 = 1s, jitter < 1000ms → delay in [1000ms, 2000ms)
        let d0 = backoff_delay(0);
        assert!(d0.as_millis() >= 1000 && d0.as_millis() < 2000, "{:?}", d0);
        // 2^3 = 8s → [8000ms, 9000ms)
        let d3 = backoff_delay(3);
        assert!(d3.as_millis() >= 8000 && d3.as_millis() < 9000, "{:?}", d3);
        // attempts >= 5 cap at 30s → [30000ms, 31000ms)
        let d_big = backoff_delay(10);
        assert!(
            d_big.as_millis() >= 30000 && d_big.as_millis() < 31000,
            "{:?}",
            d_big
        );
    }

    #[tokio::test]
    async fn with_backoff_inner_retries_then_succeeds() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<&'static str, LlmError> = with_backoff_inner(
            |_attempt| {
                let n = calls_c.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 2 {
                        Err(LlmError::RateLimited { retry_after_s: 1 })
                    } else {
                        Ok("ok")
                    }
                }
            },
            |_d| async {}, // no-op sleeper
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn with_backoff_inner_exhausts_after_three_retries() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<(), LlmError> = with_backoff_inner(
            |_attempt| {
                calls_c.fetch_add(1, Ordering::SeqCst);
                async { Err(LlmError::RateLimited { retry_after_s: 1 }) }
            },
            |_d| async {},
        )
        .await;
        match result {
            Err(LlmError::Provider(msg)) => assert!(msg.contains("retry exhausted")),
            other => panic!("expected Provider(retry exhausted), got {:?}", other),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn with_backoff_inner_bubbles_non_ratelimit_errors() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let result: Result<(), LlmError> = with_backoff_inner(
            |_attempt| {
                calls_c.fetch_add(1, Ordering::SeqCst);
                async { Err(LlmError::AuthFailed) }
            },
            |_d| async {},
        )
        .await;
        assert!(matches!(result, Err(LlmError::AuthFailed)));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "should not retry on non-RateLimited");
    }

    #[tokio::test]
    async fn with_backoff_inner_honours_retry_after_when_longer_than_backoff() {
        // Verify the sleeper is called with the header-derived wait when it
        // exceeds the exponential-backoff floor.
        let observed: Arc<std::sync::Mutex<Vec<Duration>>> =
            Arc::new(std::sync::Mutex::new(vec![]));
        let observed_c = observed.clone();
        let calls = Arc::new(AtomicU32::new(0));
        let calls_c = calls.clone();
        let _ = with_backoff_inner(
            |_attempt| {
                let n = calls_c.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 1 {
                        Err::<(), _>(LlmError::RateLimited { retry_after_s: 60 })
                    } else {
                        Ok(())
                    }
                }
            },
            |d| {
                observed_c.lock().unwrap().push(d);
                async {}
            },
        )
        .await;
        let waits = observed.lock().unwrap().clone();
        assert_eq!(waits.len(), 1);
        // First attempt: backoff = 1s + jitter; header = 60s → sleeper gets 60s
        assert_eq!(waits[0], Duration::from_secs(60));
    }
}
