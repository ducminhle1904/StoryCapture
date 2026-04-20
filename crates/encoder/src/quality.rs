//! Per-encoder quality preset → FFmpeg argv resolver (Phase 12 / D-12-04).
//!
//! `resolve(preset, encoder, output_w, output_h)` returns the rate-control +
//! speed-preset flags specific to each encoder. Caller concatenates these
//! with `-c:v`, `-pix_fmt`, `-vf`, and audio flags.
//!
//! Bitrate math uses integer `u64` saturating arithmetic; float factors in
//! the D-12-04 table (0.75, 1.25, 1.5, 1.75, 2.0) are expressed as
//! `numer/denom` pairs via `kbps_scaled`.

use crate::filters::QualityPreset;
use crate::probe::HardwareEncoder;

/// Per-encoder bitrate ceiling (D-12-08). Moved from the old global 40 Mbps
/// cap — still enforced here inside the resolver.
const MAX_KBPS: u32 = 40_000;

/// Pixel-based target bitrate in kbps, clamped to `MAX_KBPS`.
pub fn pixel_based_kbps(output_w: u32, output_h: u32) -> u32 {
    let raw = (output_w as u64)
        .saturating_mul(output_h as u64)
        .saturating_mul(3)
        / 1000;
    raw.min(MAX_KBPS as u64) as u32
}

fn kbps_scaled(base: u32, numer: u32, denom: u32) -> u32 {
    let scaled = (base as u64)
        .saturating_mul(numer as u64)
        / (denom as u64);
    scaled.min(MAX_KBPS as u64) as u32
}

macro_rules! vec_of {
    ($($s:literal),* $(,)?) => { vec![$($s.to_string()),*] };
}

/// Resolve `(preset, encoder, output_w, output_h)` into FFmpeg argv flags.
pub fn resolve(
    preset: QualityPreset,
    encoder: HardwareEncoder,
    output_w: u32,
    output_h: u32,
) -> Vec<String> {
    match encoder {
        HardwareEncoder::Openh264Software => match preset {
            QualityPreset::Low => vec_of!["-crf", "28", "-preset", "veryfast", "-tune", "stillimage"],
            QualityPreset::Med => vec_of!["-crf", "23", "-preset", "medium", "-tune", "stillimage"],
            QualityPreset::High => vec_of!["-crf", "20", "-preset", "slow", "-tune", "stillimage"],
            QualityPreset::Lossless => vec_of!["-crf", "18", "-preset", "slow", "-tune", "stillimage"],
        },
        HardwareEncoder::VideoToolboxH264 | HardwareEncoder::VideoToolboxHevc => {
            let b = pixel_based_kbps(output_w, output_h);
            match preset {
                QualityPreset::Low => vec![
                    "-q:v".into(),
                    "50".into(),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 3, 4)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                ],
                QualityPreset::Med => vec![
                    "-q:v".into(),
                    "65".into(),
                    "-maxrate".into(),
                    format!("{}k", b),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
                QualityPreset::High => vec![
                    "-q:v".into(),
                    "75".into(),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
                QualityPreset::Lossless => vec![
                    "-q:v".into(),
                    "85".into(),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
            }
        }
        HardwareEncoder::NvencH264 => {
            let b = pixel_based_kbps(output_w, output_h);
            match preset {
                QualityPreset::Low => vec![
                    "-preset".into(),
                    "p5".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "28".into(),
                    "-b:v".into(),
                    format!("{}k", kbps_scaled(b, 3, 4)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                ],
                QualityPreset::Med => vec![
                    "-preset".into(),
                    "p4".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "23".into(),
                    "-b:v".into(),
                    format!("{}k", b),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                ],
                QualityPreset::High => vec![
                    "-preset".into(),
                    "p3".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "20".into(),
                    "-b:v".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 7, 4)),
                ],
                QualityPreset::Lossless => vec![
                    "-preset".into(),
                    "p2".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "18".into(),
                    "-b:v".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
            }
        }
        HardwareEncoder::QsvH264 => match preset {
            QualityPreset::Low => vec_of!["-preset", "medium", "-global_quality", "28", "-look_ahead", "0"],
            QualityPreset::Med => vec_of!["-preset", "medium", "-global_quality", "23"],
            QualityPreset::High => vec_of!["-preset", "slow", "-global_quality", "20"],
            QualityPreset::Lossless => vec_of!["-preset", "veryslow", "-global_quality", "18"],
        },
        HardwareEncoder::AmfH264 => match preset {
            QualityPreset::Low => vec_of!["-quality", "balanced", "-rc", "cqp", "-qp_i", "28", "-qp_p", "30"],
            QualityPreset::Med => vec_of!["-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24"],
            QualityPreset::High => vec_of!["-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
            QualityPreset::Lossless => vec_of!["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_based_1920x1080_is_6220() {
        assert_eq!(pixel_based_kbps(1920, 1080), 6220);
    }

    #[test]
    fn pixel_based_3840x2160_is_24883() {
        assert_eq!(pixel_based_kbps(3840, 2160), 24883);
    }

    #[test]
    fn pixel_based_7680x4320_clamps_to_40000() {
        assert_eq!(pixel_based_kbps(7680, 4320), 40_000);
    }

    #[test]
    fn openh264_med_args() {
        let got = resolve(QualityPreset::Med, HardwareEncoder::Openh264Software, 1920, 1080);
        assert_eq!(got, vec!["-crf", "23", "-preset", "medium", "-tune", "stillimage"]);
    }

    #[test]
    fn openh264_low_args() {
        let got = resolve(QualityPreset::Low, HardwareEncoder::Openh264Software, 1920, 1080);
        assert!(got.iter().any(|a| a == "-tune"));
        assert_eq!(got, vec!["-crf", "28", "-preset", "veryfast", "-tune", "stillimage"]);
    }

    #[test]
    fn openh264_high_args() {
        let got = resolve(QualityPreset::High, HardwareEncoder::Openh264Software, 1920, 1080);
        assert_eq!(got, vec!["-crf", "20", "-preset", "slow", "-tune", "stillimage"]);
    }

    #[test]
    fn openh264_lossless_args() {
        let got = resolve(QualityPreset::Lossless, HardwareEncoder::Openh264Software, 1920, 1080);
        assert_eq!(got, vec!["-crf", "18", "-preset", "slow", "-tune", "stillimage"]);
    }

    #[test]
    fn videotoolbox_med_1080p_parity_with_current_config() {
        let got = resolve(QualityPreset::Med, HardwareEncoder::VideoToolboxH264, 1920, 1080);
        assert_eq!(got, vec!["-q:v", "65", "-maxrate", "6220k", "-bufsize", "12440k"]);
    }

    #[test]
    fn videotoolbox_hevc_shares_h264_arms() {
        let h264 = resolve(QualityPreset::Med, HardwareEncoder::VideoToolboxH264, 1920, 1080);
        let hevc = resolve(QualityPreset::Med, HardwareEncoder::VideoToolboxHevc, 1920, 1080);
        assert_eq!(h264, hevc);
    }

    #[test]
    fn videotoolbox_does_not_emit_dash_b_v() {
        for preset in [QualityPreset::Low, QualityPreset::Med, QualityPreset::High, QualityPreset::Lossless] {
            let args = resolve(preset, HardwareEncoder::VideoToolboxH264, 1920, 1080);
            assert!(!args.iter().any(|a| a == "-b:v"), "VT must not emit -b:v for {:?}", preset);
            let args = resolve(preset, HardwareEncoder::VideoToolboxHevc, 1920, 1080);
            assert!(!args.iter().any(|a| a == "-b:v"), "VT HEVC must not emit -b:v for {:?}", preset);
        }
    }

    #[test]
    fn nvenc_low_1080p_args() {
        let got = resolve(QualityPreset::Low, HardwareEncoder::NvencH264, 1920, 1080);
        assert_eq!(
            got,
            vec!["-preset", "p5", "-rc", "vbr", "-cq", "28", "-b:v", "4665k", "-maxrate", "7775k"]
        );
    }

    #[test]
    fn qsv_med_args() {
        let got = resolve(QualityPreset::Med, HardwareEncoder::QsvH264, 1920, 1080);
        assert_eq!(got, vec!["-preset", "medium", "-global_quality", "23"]);
    }

    #[test]
    fn amf_lossless_args() {
        let got = resolve(QualityPreset::Lossless, HardwareEncoder::AmfH264, 1920, 1080);
        assert_eq!(
            got,
            vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"]
        );
    }

    #[test]
    fn exhaustive_match_holds() {
        let presets = [QualityPreset::Low, QualityPreset::Med, QualityPreset::High, QualityPreset::Lossless];
        let encoders = [
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::VideoToolboxHevc,
            HardwareEncoder::NvencH264,
            HardwareEncoder::QsvH264,
            HardwareEncoder::AmfH264,
            HardwareEncoder::Openh264Software,
        ];
        for p in presets {
            for e in encoders {
                let got = resolve(p, e, 1920, 1080);
                assert!(!got.is_empty(), "empty argv for {:?} + {:?}", p, e);
            }
        }
    }
}
