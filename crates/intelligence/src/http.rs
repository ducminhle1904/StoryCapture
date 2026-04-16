//! Shared HTTP error classification and retry-header parsing.
//!
//! Used by both LLM providers (Anthropic, OpenAI) and TTS providers to
//! classify non-2xx responses into retryable vs terminal categories.

use std::time::{Duration, SystemTime};

use reqwest::StatusCode;

/// Cap on bytes of provider error body echoed into error messages.
pub const PROVIDER_BODY_TRUNCATE: usize = 256;

/// Classify an HTTP error response into `(is_retryable, detail)`.
///
/// - 429 Too Many Requests -> `(true, "rate_limited:<retry_after_s>")`
/// - 401/403 -> auth failure: `(false, "auth_failed")`
/// - Other -> `(false, "<status>: <truncated body>")`
///
/// Each provider maps this result to its own error type.
pub async fn classify_http_error(
    status: StatusCode,
    resp: reqwest::Response,
) -> (bool, String, Option<u64>) {
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after_s = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after)
            .map(|d| d.as_secs())
            .unwrap_or(1);
        return (true, "rate_limited".to_string(), Some(retry_after_s));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return (false, "auth_failed".to_string(), None);
    }
    let body = resp.text().await.unwrap_or_default();
    let mut truncated: String = body.chars().take(PROVIDER_BODY_TRUNCATE).collect();
    if body.len() > truncated.len() {
        truncated.push_str("\u{2026}");
    }
    (false, format!("{}: {}", status, truncated), None)
}

/// Parse the `Retry-After` header value per RFC 7231 section 7.1.3.
///
/// Accepts both delta-seconds (e.g. `"5"`) and HTTP-date (e.g.
/// `"Wed, 21 Oct 2026 07:28:00 GMT"`). For HTTP-date, returns the delta
/// between the parsed instant and `SystemTime::now()` -- zero if the date
/// is in the past.
pub fn parse_retry_after(header: &str) -> Option<Duration> {
    let trimmed = header.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let when = httpdate::parse_http_date(trimmed).ok()?;
    let now = SystemTime::now();
    match when.duration_since(now) {
        Ok(delta) => Some(delta),
        Err(_) => Some(Duration::from_secs(0)), // past date -> no wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_retry_after_seconds_form() {
        assert_eq!(parse_retry_after("5"), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after("  0 "), Some(Duration::from_secs(0)));
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
    }

    #[test]
    fn parse_retry_after_httpdate_form() {
        let future = SystemTime::now() + Duration::from_secs(3600);
        let header = httpdate::fmt_http_date(future);
        let d = parse_retry_after(&header).expect("date parses");
        assert!(d.as_secs() > 0, "expected non-zero wait, got {:?}", d);

        let past_ts = SystemTime::UNIX_EPOCH + Duration::from_secs(631_152_000);
        let past_header = httpdate::fmt_http_date(past_ts);
        let past = parse_retry_after(&past_header).expect("date parses");
        assert_eq!(past, Duration::from_secs(0));
    }

    #[test]
    fn parse_retry_after_junk_returns_none() {
        assert_eq!(parse_retry_after("not-a-value"), None);
    }
}
