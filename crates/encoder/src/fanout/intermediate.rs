//! Placeholder filled in by Task 3.
use std::path::PathBuf;

pub struct IntermediateOutput {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub async fn render_intermediate() -> crate::Result<IntermediateOutput> {
    Err(crate::EncoderError::InvalidConfig(
        "render_intermediate filled in by Task 3".into(),
    ))
}
