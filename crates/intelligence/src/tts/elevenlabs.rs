//! ElevenLabs TTS provider — streaming MP3 synthesis + voice catalog.
//!
//! Implements the `TtsProvider` trait per AI-SPEC §4 (TTS):
//!
//! - `synthesize` posts to `/v1/text-to-speech/{voice_id}/stream` with
//!   `model_id: "eleven_multilingual_v2"` plus default voice_settings
//!   (`stability: 0.5`, `similarity_boost: 0.75`, `style: 0`,
//!   `use_speaker_boost: true`). Response is chunked MP3 bytes; we drain
//!   into a single `Bytes` buffer for the cache layer (Plan 11).
//! - `list_voices` hits `GET /v1/voices` and maps `voices[]` to
//!   `Vec<VoiceInfo>` (locale from `labels.accent` when present, premium
//!   when `category == "professional"`).
//! - HTTP error mapping: `401`/`403` → `AuthFailed`, `402` → `QuotaExceeded`,
//!   `404` → `VoiceNotFound`, `429` → `RateLimited { retry_after_s }`,
//!   other non-2xx → `Provider(status + truncated body)`.
//! - API key travels via `xi-api-key` header wrapped in `Redacted<String>`;
//!   Plan 03-01's redaction layer scrubs the `xi-*` pattern as
//!   defence-in-depth.

use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tracing::{instrument, warn};

use super::{TtsError, TtsProvider, TtsRequest, VoiceInfo};
use crate::secrets::Redacted;

pub const ELEVENLABS_URL: &str = "https://api.elevenlabs.io";
pub const ELEVENLABS_DEFAULT_MODEL: &str = "eleven_multilingual_v2";
/// Cap on bytes of provider error body echoed into `TtsError::Provider`.
const PROVIDER_BODY_TRUNCATE: usize = 256;

/// ElevenLabs TTS provider. Construct with [`ElevenLabsProvider::new`] in
/// production; use [`ElevenLabsProvider::with_base_url`] to redirect to
/// `wiremock` or a staging host in tests.
pub struct ElevenLabsProvider {
    http: Client,
    api_key: Redacted<String>,
    base_url: String,
}

impl ElevenLabsProvider {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, ELEVENLABS_URL.to_string())
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        // Longer overall timeout than the LLM clients — MP3 streams for
        // long narrations can run well past the 120s LLM cap.
        let http = Client::builder()
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .build()
            .expect("reqwest client builds with rustls-tls");
        Self {
            http,
            api_key: Redacted::new(api_key),
            base_url,
        }
    }

    /// Constructor accepting a pre-built [`Client`] for connection pool reuse
    /// across providers. The caller is responsible for configuring timeouts.
    pub fn with_client(client: Client, api_key: String) -> Self {
        Self {
            http: client,
            api_key: Redacted::new(api_key),
            base_url: ELEVENLABS_URL.to_string(),
        }
    }

    fn synth_url(&self, voice_id: &str) -> String {
        format!(
            "{}/v1/text-to-speech/{}/stream",
            self.base_url.trim_end_matches('/'),
            voice_id
        )
    }

    fn voices_url(&self) -> String {
        format!("{}/v1/voices", self.base_url.trim_end_matches('/'))
    }
}

#[async_trait::async_trait]
impl TtsProvider for ElevenLabsProvider {
    #[instrument(skip_all, fields(voice_id = %req.voice_id, model = %req.model))]
    async fn synthesize(&self, req: TtsRequest) -> Result<Bytes, TtsError> {
        let url = self.synth_url(&req.voice_id);
        let model = if req.model.is_empty() {
            ELEVENLABS_DEFAULT_MODEL.to_string()
        } else {
            req.model.clone()
        };
        let body = serde_json::json!({
            "text": req.text,
            "model_id": model,
            "voice_settings": {
                "stability":         req.stability.unwrap_or(0.5),
                "similarity_boost":  req.similarity_boost.unwrap_or(0.75),
                "style":             0,
                "use_speaker_boost": true,
            }
        });

        let resp = self
            .http
            .post(&url)
            .header("xi-api-key", self.api_key.expose())
            .header(ACCEPT, "audio/mpeg")
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(classify_http_error(status, resp, Some(req.voice_id.clone())).await);
        }

        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buf.extend_from_slice(&chunk);
        }
        Ok(Bytes::from(buf))
    }

    #[instrument(skip_all)]
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        let url = self.voices_url();
        let resp = self
            .http
            .get(&url)
            .header("xi-api-key", self.api_key.expose())
            .header(ACCEPT, "application/json")
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(classify_http_error(status, resp, None).await);
        }

        let body: VoicesListResponse = resp.json().await?;
        Ok(body.voices.into_iter().map(Into::into).collect())
    }
}

// ---- Response shapes -------------------------------------------------------

#[derive(Deserialize, Debug)]
struct VoicesListResponse {
    voices: Vec<VoiceRaw>,
}

#[derive(Deserialize, Debug)]
struct VoiceRaw {
    voice_id: String,
    name: String,
    #[serde(default)]
    labels: Option<VoiceLabels>,
    #[serde(default)]
    category: Option<String>,
}

#[derive(Deserialize, Debug)]
struct VoiceLabels {
    #[serde(default)]
    accent: Option<String>,
}

impl From<VoiceRaw> for VoiceInfo {
    fn from(raw: VoiceRaw) -> Self {
        let locale = raw
            .labels
            .as_ref()
            .and_then(|l| l.accent.as_ref())
            .map(|accent| accent_to_locale(accent));
        let premium = matches!(raw.category.as_deref(), Some("professional"));
        VoiceInfo {
            id: raw.voice_id,
            name: raw.name,
            locale,
            premium,
        }
    }
}

/// ElevenLabs reports `labels.accent` as a human string (e.g. "american",
/// "british", "australian"). Map the common English-speaking accents to
/// BCP-47 `en`; unknown values stay as the raw accent string so callers
/// can surface them in a "language" pill.
fn accent_to_locale(accent: &str) -> String {
    let a = accent.to_ascii_lowercase();
    if matches!(
        a.as_str(),
        "american" | "british" | "australian" | "irish" | "english"
    ) {
        "en".to_string()
    } else {
        accent.to_string()
    }
}

// ---- HTTP error classification --------------------------------------------

async fn classify_http_error(
    status: StatusCode,
    resp: reqwest::Response,
    voice_id: Option<String>,
) -> TtsError {
    match status.as_u16() {
        401 | 403 => TtsError::AuthFailed,
        402 => TtsError::QuotaExceeded,
        404 => TtsError::VoiceNotFound(voice_id.unwrap_or_default()),
        429 => {
            let retry_after_s = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(5);
            TtsError::RateLimited { retry_after_s }
        }
        _ => {
            let body = resp.text().await.unwrap_or_default();
            let truncated = truncate_body(&body);
            warn!(%status, "elevenlabs non-2xx response");
            TtsError::Provider(format!("{}: {}", status, truncated))
        }
    }
}

fn truncate_body(body: &str) -> String {
    if body.chars().count() <= PROVIDER_BODY_TRUNCATE {
        body.to_string()
    } else {
        let mut out: String = body.chars().take(PROVIDER_BODY_TRUNCATE).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accent_to_locale_maps_common_english() {
        assert_eq!(accent_to_locale("american"), "en");
        assert_eq!(accent_to_locale("British"), "en");
        assert_eq!(accent_to_locale("Australian"), "en");
    }

    #[test]
    fn accent_to_locale_preserves_unknown() {
        assert_eq!(accent_to_locale("swedish"), "swedish");
    }

    #[test]
    fn truncate_body_under_cap_is_identity() {
        assert_eq!(truncate_body("short"), "short");
    }

    #[test]
    fn truncate_body_over_cap_is_ellipsised() {
        let long: String = "a".repeat(PROVIDER_BODY_TRUNCATE + 50);
        let t = truncate_body(&long);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), PROVIDER_BODY_TRUNCATE + 1);
    }

    #[test]
    fn provider_url_formatting() {
        let p = ElevenLabsProvider::with_base_url("k".into(), "https://example.test/".into());
        assert_eq!(
            p.synth_url("voice-xyz"),
            "https://example.test/v1/text-to-speech/voice-xyz/stream"
        );
        assert_eq!(p.voices_url(), "https://example.test/v1/voices");
    }
}
