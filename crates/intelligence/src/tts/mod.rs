//! TTS provider trait + associated request/error types.
//!
//! See AI-SPEC §3 (Key Abstractions) and D-10 in 03-CONTEXT.

use thiserror::Error;

pub mod elevenlabs;
pub mod openai_tts;

#[derive(Debug, Clone)]
pub struct TtsRequest {
    pub model: String,
    pub voice_id: String,
    pub text: String,
    pub stability: Option<f32>,
    pub similarity_boost: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub locale: Option<String>,
    pub premium: bool,
}

#[derive(Debug, Error)]
pub enum TtsError {
    #[error("HTTP transport error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("quota exceeded")]
    QuotaExceeded,
    #[error("voice not found: {0}")]
    VoiceNotFound(String),
    #[error("rate limited — retry after {retry_after_s}s")]
    RateLimited { retry_after_s: u64 },
    #[error("authentication failed")]
    AuthFailed,
    #[error("provider error: {0}")]
    Provider(String),
}

/// Synchronous synthesis contract — returns raw audio bytes in the
/// provider's native container (mp3 for ElevenLabs, opus/mp3 for OpenAI).
#[async_trait::async_trait]
pub trait TtsProvider: Send + Sync {
    async fn synthesize(&self, req: TtsRequest) -> Result<bytes::Bytes, TtsError>;
    async fn list_voices(&self) -> Result<Vec<VoiceInfo>, TtsError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_bounds<T: std::error::Error + Send + Sync + 'static>() {}

    #[test]
    fn tts_error_is_send_sync_static() {
        assert_error_bounds::<TtsError>();
    }

    #[test]
    fn tts_provider_is_object_safe() {
        fn _takes_box(_p: Box<dyn TtsProvider>) {}
        let _ = _takes_box;
    }
}
