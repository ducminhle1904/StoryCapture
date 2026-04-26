//! OpenAI TTS provider — fallback when ElevenLabs is quota-exhausted or
//! slow. Single POST to `/v1/audio/speech`; response is a non-streamed MP3
//! payload (OpenAI does not chunk the audio endpoint the way ElevenLabs does).
//!
//! Wire shape:
//! - Body: `{ model, input, voice, response_format: "mp3", speed: 1.0 }`.
//! - Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`.
//! - Six built-in voices: `alloy, echo, fable, onyx, nova, shimmer` — all
//!   `locale = "en"`, `premium = false`. The set is static (no network call
//!   for `list_voices`).
//! - Voice whitelist is enforced BEFORE the network call (threat T-03-09-02)
//!   so a spoofed voice id cannot reach the provider.
//! - HTTP error mapping mirrors the ElevenLabs provider:
//!   401/403 → AuthFailed, 402 → QuotaExceeded, 429 → RateLimited, other non-2xx
//!   → Provider(status + truncated body).

use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use tracing::{instrument, warn};

use super::{TtsError, TtsProvider, TtsRequest, VoiceInfo};
use crate::secrets::Redacted;

pub const OPENAI_TTS_URL: &str = "https://api.openai.com";
pub const OPENAI_TTS_DEFAULT_MODEL: &str = "tts-1";
pub const BUILTIN_VOICES: &[&str] = &["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
/// Cap on bytes of provider error body echoed into `TtsError::Provider`.
const PROVIDER_BODY_TRUNCATE: usize = 256;

/// OpenAI TTS provider. Construct with [`OpenAiTtsProvider::new`] in production;
/// use [`OpenAiTtsProvider::with_base_url`] to redirect to `wiremock` in tests.
pub struct OpenAiTtsProvider {
    http: Client,
    api_key: Redacted<String>,
    base_url: String,
}

impl OpenAiTtsProvider {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, OPENAI_TTS_URL.to_string())
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        // 180s timeout mirrors the ElevenLabs provider — OpenAI `/audio/speech`
        // is usually <1s for short clips but paragraph-length input can stretch
        // well past the 120s LLM ceiling.
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
            base_url: OPENAI_TTS_URL.to_string(),
        }
    }

    fn synth_url(&self) -> String {
        format!("{}/v1/audio/speech", self.base_url.trim_end_matches('/'))
    }
}

#[async_trait::async_trait]
impl TtsProvider for OpenAiTtsProvider {
    #[instrument(skip_all, fields(voice_id = %req.voice_id, model = %req.model))]
    async fn synthesize(&self, req: TtsRequest) -> Result<Bytes, TtsError> {
        // voice id whitelist BEFORE network call. A spoofed voice
        // id must not reach the provider — fail fast with a local error.
        if !BUILTIN_VOICES.contains(&req.voice_id.as_str()) {
            return Err(TtsError::VoiceNotFound(req.voice_id));
        }

        let model = if req.model.is_empty() {
            OPENAI_TTS_DEFAULT_MODEL.to_string()
        } else {
            req.model.clone()
        };
        let body = serde_json::json!({
            "model":           model,
            "input":           req.text,
            "voice":           req.voice_id,
            "response_format": "mp3",
            "speed":           1.0,
        });

        let url = self.synth_url();
        let resp = self
            .http
            .post(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key.expose()))
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(classify_http_error(status, resp).await);
        }

        // OpenAI returns the full MP3 as the response body (non-streamed).
        let audio = resp.bytes().await?;
        Ok(audio)
    }

    #[instrument(skip_all)]
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError> {
        // Built-in voices are static; no network call needed.
        Ok(BUILTIN_VOICES
            .iter()
            .map(|v| VoiceInfo {
                id: (*v).to_string(),
                name: capitalize(v),
                locale: Some("en".to_string()),
                premium: false,
            })
            .collect())
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ---- HTTP error classification --------------------------------------------

async fn classify_http_error(status: StatusCode, resp: reqwest::Response) -> TtsError {
    match status.as_u16() {
        401 | 403 => TtsError::AuthFailed,
        402 => TtsError::QuotaExceeded,
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
            warn!(%status, "openai tts non-2xx response");
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
    fn builtin_voices_has_six_canonical_names() {
        assert_eq!(BUILTIN_VOICES.len(), 6);
        for v in ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] {
            assert!(BUILTIN_VOICES.contains(&v), "missing voice {}", v);
        }
    }

    #[test]
    fn capitalize_first_letter() {
        assert_eq!(capitalize("alloy"), "Alloy");
        assert_eq!(capitalize(""), "");
        assert_eq!(capitalize("a"), "A");
    }

    #[test]
    fn truncate_body_under_cap_is_identity() {
        assert_eq!(truncate_body("short"), "short");
    }

    #[test]
    fn truncate_body_over_cap_is_ellipsised() {
        let long: String = "a".repeat(PROVIDER_BODY_TRUNCATE + 10);
        let t = truncate_body(&long);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), PROVIDER_BODY_TRUNCATE + 1);
    }

    #[test]
    fn provider_url_formatting() {
        let p = OpenAiTtsProvider::with_base_url("k".into(), "https://example.test/".into());
        assert_eq!(p.synth_url(), "https://example.test/v1/audio/speech");
    }
}
