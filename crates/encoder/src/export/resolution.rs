//! Resolution catalogue for EXPORT-03.
//!
//! Three presets mapped to (width, height). FPS is independent — the plan
//! requires 24 / 30 / 60 fps at any resolution.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resolution {
    MatchSource { width: u32, height: u32 },
    R720p,
    R1080p,
    R4k,
    Custom { width: u32, height: u32 },
}

/// (width, height) in pixels.
pub fn dimensions_for(r: Resolution) -> (u32, u32) {
    match r {
        Resolution::MatchSource { width, height } => (width, height),
        Resolution::R720p => (1280, 720),
        Resolution::R1080p => (1920, 1080),
        Resolution::R4k => (3840, 2160),
        Resolution::Custom { width, height } => (width, height),
    }
}

/// Short human-readable label used in filenames + render_jobs.resolution
/// column. Must match the values the `render_jobs` schema accepts.
pub fn res_label(r: Resolution) -> String {
    match r {
        Resolution::MatchSource { .. } => "match-source".into(),
        Resolution::R720p => "720p".into(),
        Resolution::R1080p => "1080p".into(),
        Resolution::R4k => "4k".into(),
        Resolution::Custom { width, height } => format!("custom:{width}x{height}"),
    }
}

impl Resolution {
    pub fn all() -> &'static [Resolution] {
        &[
            Self::MatchSource {
                width: 1920,
                height: 1080,
            },
            Self::R720p,
            Self::R1080p,
            Self::R4k,
        ]
    }
}

pub fn validate_dimensions(width: u32, height: u32) -> bool {
    (16..=7680).contains(&width)
        && (16..=4320).contains(&height)
        && width % 2 == 0
        && height % 2 == 0
}

pub fn resolve_label(
    label: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> std::result::Result<Resolution, String> {
    let label = label.to_ascii_lowercase();
    if label == "custom" || label.starts_with("custom:") {
        let (width, height) = width
            .zip(height)
            .ok_or_else(|| "custom resolution requires output_width/output_height".to_string())?;
        if !validate_dimensions(width, height) {
            return Err(format!(
                "custom dimensions must be even and within 16..=7680 x 16..=4320, got {width}x{height}"
            ));
        }
        return Ok(Resolution::Custom { width, height });
    }
    if label == "match-source" {
        let (width, height) = width.zip(height).ok_or_else(|| {
            "match-source resolution requires measured output_width/output_height".to_string()
        })?;
        if !validate_dimensions(width, height) {
            return Err(format!(
                "match-source dimensions must be even and within encoder limits, got {width}x{height}"
            ));
        }
        return Ok(Resolution::MatchSource { width, height });
    }
    match label.as_str() {
        "720p" => Ok(Resolution::R720p),
        "1080p" => Ok(Resolution::R1080p),
        "4k" => Ok(Resolution::R4k),
        other => Err(format!("unknown resolution: {other}")),
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
        assert_eq!(
            dimensions_for(Resolution::Custom {
                width: 2560,
                height: 1600
            }),
            (2560, 1600)
        );
    }

    #[test]
    fn valid_fps_set() {
        assert_eq!(VALID_FPS, &[24, 30, 60]);
    }

    #[test]
    fn res_labels_canonical() {
        assert_eq!(
            res_label(Resolution::MatchSource {
                width: 1920,
                height: 1080
            }),
            "match-source"
        );
        assert_eq!(res_label(Resolution::R720p), "720p");
        assert_eq!(res_label(Resolution::R1080p), "1080p");
        assert_eq!(res_label(Resolution::R4k), "4k");
        assert_eq!(
            res_label(Resolution::Custom {
                width: 2560,
                height: 1600
            }),
            "custom:2560x1600"
        );
    }
}
