//! Quality catalogue + codec-aware bitrate/CRF tables for EXPORT-03.
//!
//! Bitrates roughly follow Research §12. Low = "web preview", Med =
//! "default share", High = "archival". CRF is preferred when the codec
//! supports it (VP9, H.264 libx264 family); hardware encoders use bitrate.

use serde::{Deserialize, Serialize};

use super::resolution::Resolution;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Quality {
    Low,
    Med,
    High,
}

impl Quality {
    pub fn all() -> &'static [Quality] {
        &[Self::Low, Self::Med, Self::High]
    }
}

/// Bitrate label (`"8M"`, `"12M"`, etc.) sized by (resolution, quality,
/// codec). Values tuned for Research §12's "good-enough" defaults.
pub fn bitrate_for(r: Resolution, q: Quality, codec: &str) -> String {
    match (r, q, codec) {
        // H.264
        (Resolution::R720p, Quality::Low, "h264") => "3M".into(),
        (Resolution::R720p, Quality::Med, "h264") => "5M".into(),
        (Resolution::R720p, Quality::High, "h264") => "8M".into(),
        (Resolution::R1080p, Quality::Low, "h264") => "6M".into(),
        (Resolution::R1080p, Quality::Med, "h264") => "10M".into(),
        (Resolution::R1080p, Quality::High, "h264") => "16M".into(),
        (Resolution::R4k, Quality::Low, "h264") => "18M".into(),
        (Resolution::R4k, Quality::Med, "h264") => "30M".into(),
        (Resolution::R4k, Quality::High, "h264") => "50M".into(),
        // VP9 (CRF-driven in practice; bitrate is the cap)
        (Resolution::R720p, _, "vp9") => "3M".into(),
        (Resolution::R1080p, _, "vp9") => "6M".into(),
        (Resolution::R4k, _, "vp9") => "18M".into(),
        _ => "5M".into(),
    }
}

/// CRF label for codecs that support quality-constant encoding. Lower = better.
pub fn crf_for(_r: Resolution, q: Quality, codec: &str) -> u8 {
    match (q, codec) {
        (Quality::Low, "vp9") => 36,
        (Quality::Med, "vp9") => 32,
        (Quality::High, "vp9") => 28,
        (Quality::Low, "h264") => 28,
        (Quality::Med, "h264") => 23,
        (Quality::High, "h264") => 18,
        _ => 23,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrate_for_h264_in_research_range() {
        // Research §12 guide: 1080p Medium H.264 should be 8M-12M-ish.
        let b = bitrate_for(Resolution::R1080p, Quality::Med, "h264");
        assert!(b == "8M" || b == "10M" || b == "12M", "unexpected: {b}");
        // 4K High sits well above 1080p Low.
        assert_eq!(bitrate_for(Resolution::R4k, Quality::High, "h264"), "50M");
    }

    #[test]
    fn crf_for_vp9_high_range() {
        let c = crf_for(Resolution::R1080p, Quality::High, "vp9");
        assert!((28..=32).contains(&c), "vp9 high CRF out of range: {c}");
    }

    #[test]
    fn crf_monotonic_in_quality() {
        // Lower CRF = higher quality (H.264 family).
        let low = crf_for(Resolution::R1080p, Quality::Low, "h264");
        let med = crf_for(Resolution::R1080p, Quality::Med, "h264");
        let high = crf_for(Resolution::R1080p, Quality::High, "h264");
        assert!(high < med && med < low);
    }
}
