//! Resolution catalogue for EXPORT-03.
//!
//! Three presets mapped to (width, height). FPS is independent — the plan
//! requires 24 / 30 / 60 fps at any resolution.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resolution {
    R720p,
    R1080p,
    R4k,
}

/// (width, height) in pixels.
pub fn dimensions_for(r: Resolution) -> (u32, u32) {
    match r {
        Resolution::R720p => (1280, 720),
        Resolution::R1080p => (1920, 1080),
        Resolution::R4k => (3840, 2160),
    }
}

/// Short human-readable label used in filenames + render_jobs.resolution
/// column. Must match the values the Phase-1 `render_jobs` schema accepts.
pub fn res_label(r: Resolution) -> &'static str {
    match r {
        Resolution::R720p => "720p",
        Resolution::R1080p => "1080p",
        Resolution::R4k => "4k",
    }
}

impl Resolution {
    pub fn all() -> &'static [Resolution] {
        &[Self::R720p, Self::R1080p, Self::R4k]
    }
}

/// Allowed framerates across all resolutions. The UI picker is bound to this.
pub const VALID_FPS: &[u32] = &[24, 30, 60];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_dimensions() {
        assert_eq!(dimensions_for(Resolution::R720p), (1280, 720));
        assert_eq!(dimensions_for(Resolution::R1080p), (1920, 1080));
        assert_eq!(dimensions_for(Resolution::R4k), (3840, 2160));
    }

    #[test]
    fn valid_fps_set() {
        assert_eq!(VALID_FPS, &[24, 30, 60]);
    }

    #[test]
    fn res_labels_canonical() {
        assert_eq!(res_label(Resolution::R720p), "720p");
        assert_eq!(res_label(Resolution::R1080p), "1080p");
        assert_eq!(res_label(Resolution::R4k), "4k");
    }
}
