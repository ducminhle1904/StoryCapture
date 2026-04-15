//! Placeholder filled in by Task 3.
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputFormat {
    Mp4,
    WebM,
    Gif,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Resolution {
    R720p,
    R1080p,
    R4k,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Quality {
    Low,
    Med,
    High,
}

#[derive(Debug, Clone)]
pub struct OutputSpec {
    pub format: OutputFormat,
    pub resolution: Resolution,
    pub fps: u32,
    pub quality: Quality,
    pub output_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct FanoutPlan {
    pub outputs: Vec<OutputSpec>,
}

pub fn bitrate_for(_r: Resolution, _q: Quality, _codec: &str) -> String {
    String::new()
}

pub fn resolution_width(r: Resolution) -> u32 {
    match r {
        Resolution::R720p => 1280,
        Resolution::R1080p => 1920,
        Resolution::R4k => 3840,
    }
}

pub async fn fanout_encode() -> crate::Result<Vec<PathBuf>> {
    Err(crate::EncoderError::InvalidConfig(
        "fanout_encode filled in by Task 3".into(),
    ))
}
