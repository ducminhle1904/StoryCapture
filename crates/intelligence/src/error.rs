use thiserror::Error;

/// Unified error taxonomy for the `intelligence` crate. Re-exports provider-specific
/// errors via `#[from]` so callers can bubble any inner failure through a single type.
#[derive(Debug, Error)]
pub enum IntelError {
    #[error("LLM error: {0}")]
    Llm(#[from] crate::llm::LlmError),
    #[error("TTS error: {0}")]
    Tts(#[from] crate::tts::TtsError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_bounds<T: std::error::Error + Send + Sync + 'static>() {}

    #[test]
    fn intel_error_is_send_sync_static() {
        assert_error_bounds::<IntelError>();
    }
}
