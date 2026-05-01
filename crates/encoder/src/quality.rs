//! Per-encoder quality preset → FFmpeg argv resolver.
//!
//! `resolve(preset, encoder, output_w, output_h)` returns the rate-control +
//! speed-preset flags specific to each encoder. Caller concatenates these
//! with `-c:v`, `-pix_fmt`, `-vf`, and audio flags.
//!
//! Bitrate math uses integer `u64` saturating arithmetic; float factors
//! (0.75, 1.25, 1.5, 1.75, 2.0) are expressed as `numer/denom` pairs via
//! `kbps_scaled`.

use crate::filters::QualityPreset;
use crate::probe::HardwareEncoder;

/// Per-encoder bitrate ceiling. Native Retina 60fps screen recordings need a
/// larger budget than natural video because text and UI edges are expensive to
/// preserve under H.264/HEVC hardware encoders.
const MAX_KBPS: u32 = 160_000;

/// Pixel-based target bitrate in kbps, clamped to `MAX_KBPS`.
/// Screen content (sharp edges, text, high-contrast UI) needs denser bitrate
/// than natural video; 5 bits/pixel @ 30fps is the empirical floor for crisp
/// text at H.264 High profile. Bitrate scales linearly with fps so 60fps
/// content gets 2× the budget.
pub fn pixel_based_kbps(output_w: u32, output_h: u32, fps: u32) -> u32 {
    let fps = fps.max(1) as u64;
    let raw = (output_w as u64)
        .saturating_mul(output_h as u64)
        .saturating_mul(5)
        .saturating_mul(fps)
        / 30_000;
    raw.min(MAX_KBPS as u64) as u32
}

/// Target video bitrate for diagnostics. This mirrors the primary target
/// emitted by `resolve` before encoder-specific maxrate/bufsize expansion.
pub fn target_kbps(
    preset: QualityPreset,
    encoder: HardwareEncoder,
    output_w: u32,
    output_h: u32,
    fps: u32,
) -> u32 {
    match encoder {
        HardwareEncoder::Libx264Software
        | HardwareEncoder::Openh264Software
        | HardwareEncoder::QsvH264
        | HardwareEncoder::AmfH264 => 0,
        HardwareEncoder::VideoToolboxH264
        | HardwareEncoder::VideoToolboxHevc
        | HardwareEncoder::NvencH264 => {
            let b = pixel_based_kbps(output_w, output_h, fps);
            match preset {
                QualityPreset::Low => kbps_scaled(b, 3, 4),
                QualityPreset::Med => b,
                QualityPreset::High => kbps_scaled(b, 5, 4),
                QualityPreset::Lossless => kbps_scaled(b, 3, 2),
            }
        }
    }
}

fn kbps_scaled(base: u32, numer: u32, denom: u32) -> u32 {
    let scaled = (base as u64).saturating_mul(numer as u64) / (denom as u64);
    scaled.min(MAX_KBPS as u64) as u32
}

macro_rules! vec_of {
    ($($s:literal),* $(,)?) => { vec![$($s.to_string()),*] };
}

/// Resolve `(preset, encoder, output_w, output_h, fps)` into FFmpeg argv flags.
pub fn resolve(
    preset: QualityPreset,
    encoder: HardwareEncoder,
    output_w: u32,
    output_h: u32,
    fps: u32,
) -> Vec<String> {
    resolve_with_realtime(preset, encoder, output_w, output_h, fps, false)
}

/// Resolve quality flags, optionally biasing platform hardware encoders toward
/// realtime capture throughput. Offline exports keep the default quality bias.
pub fn resolve_with_realtime(
    preset: QualityPreset,
    encoder: HardwareEncoder,
    output_w: u32,
    output_h: u32,
    fps: u32,
    realtime: bool,
) -> Vec<String> {
    match encoder {
        HardwareEncoder::Libx264Software => match preset {
            QualityPreset::Low => vec_of![
                "-crf",
                "26",
                "-preset",
                "veryfast",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ],
            QualityPreset::Med => vec_of![
                "-crf",
                "20",
                "-preset",
                "medium",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ],
            QualityPreset::High => vec_of![
                "-crf",
                "18",
                "-preset",
                "slow",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ],
            QualityPreset::Lossless => {
                vec_of!["-crf", "0", "-preset", "ultrafast", "-tune", "zerolatency"]
            }
        },
        HardwareEncoder::Openh264Software => {
            let b = pixel_based_kbps(output_w, output_h, fps);
            match preset {
                QualityPreset::Low => vec![
                    "-b:v".into(),
                    format!("{}k", kbps_scaled(b, 3, 4)),
                    "-profile:v".into(),
                    "main".into(),
                    "-rc_mode".into(),
                    "bitrate".into(),
                ],
                QualityPreset::Med => vec![
                    "-b:v".into(),
                    format!("{b}k"),
                    "-profile:v".into(),
                    "high".into(),
                    "-rc_mode".into(),
                    "bitrate".into(),
                ],
                QualityPreset::High | QualityPreset::Lossless => vec![
                    "-b:v".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                    "-profile:v".into(),
                    "high".into(),
                    "-rc_mode".into(),
                    "quality".into(),
                    "-coder".into(),
                    "cabac".into(),
                ],
            }
        }
        HardwareEncoder::VideoToolboxH264 | HardwareEncoder::VideoToolboxHevc => {
            // `-q:v` on h264_videotoolbox is a quality *ceiling*, and plain
            // `-b:v` VBR still undershoots badly on dark/static screen UI
            // (observed 3 Mbps against a 78 Mbps target). Force CBR so
            // VideoToolbox preserves sharp text and edges in recorder output.
            let b = pixel_based_kbps(output_w, output_h, fps);
            let mut args = match preset {
                QualityPreset::Low => vec![
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", b),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                ],
                QualityPreset::Med => vec![
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
                QualityPreset::High => vec![
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
                QualityPreset::Lossless => vec![
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 7, 4)),
                    "-bufsize".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
            };
            args.extend([
                "-constant_bit_rate".into(),
                "true".into(),
                "-realtime".into(),
                if realtime { "true" } else { "false" }.into(),
                "-prio_speed".into(),
                if realtime { "true" } else { "false" }.into(),
                "-power_efficient".into(),
                "0".into(),
            ]);
            if matches!(encoder, HardwareEncoder::VideoToolboxH264) {
                args.extend([
                    "-profile".into(),
                    "high".into(),
                    "-coder".into(),
                    "cabac".into(),
                ]);
            }
            args
        }
        HardwareEncoder::NvencH264 => {
            let b = pixel_based_kbps(output_w, output_h, fps);
            match preset {
                QualityPreset::Low => vec![
                    "-preset".into(),
                    "p5".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "26".into(),
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 5, 4)),
                ],
                QualityPreset::Med => vec![
                    "-preset".into(),
                    "p4".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "20".into(),
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 3, 2)),
                ],
                QualityPreset::High => vec![
                    "-preset".into(),
                    "p3".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "18".into(),
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 7, 4)),
                ],
                QualityPreset::Lossless => vec![
                    "-preset".into(),
                    "p2".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    "15".into(),
                    "-b:v".into(),
                    format!("{}k", target_kbps(preset, encoder, output_w, output_h, fps)),
                    "-maxrate".into(),
                    format!("{}k", kbps_scaled(b, 2, 1)),
                ],
            }
        }
        HardwareEncoder::QsvH264 => match preset {
            QualityPreset::Low => vec_of![
                "-preset",
                "medium",
                "-global_quality",
                "26",
                "-look_ahead",
                "0"
            ],
            QualityPreset::Med => vec_of!["-preset", "medium", "-global_quality", "20"],
            QualityPreset::High => vec_of!["-preset", "slow", "-global_quality", "18"],
            QualityPreset::Lossless => vec_of!["-preset", "veryslow", "-global_quality", "15"],
        },
        HardwareEncoder::AmfH264 => match preset {
            QualityPreset::Low => {
                vec_of!["-quality", "balanced", "-rc", "cqp", "-qp_i", "26", "-qp_p", "28"]
            }
            QualityPreset::Med => {
                vec_of!["-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"]
            }
            QualityPreset::High => {
                vec_of!["-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"]
            }
            QualityPreset::Lossless => {
                vec_of!["-quality", "quality", "-rc", "cqp", "-qp_i", "15", "-qp_p", "17"]
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_based_1920x1080_30fps_is_10368() {
        // 1920*1080*5*30/30000 = 10368
        assert_eq!(pixel_based_kbps(1920, 1080, 30), 10368);
    }

    #[test]
    fn pixel_based_1920x1080_60fps_is_20736() {
        // 60fps doubles the budget.
        assert_eq!(pixel_based_kbps(1920, 1080, 60), 20736);
    }

    #[test]
    fn pixel_based_3840x2160_30fps_is_uncapped_screen_budget() {
        assert_eq!(pixel_based_kbps(3840, 2160, 30), 41_472);
    }

    #[test]
    fn pixel_based_7680x4320_clamps_to_160000() {
        assert_eq!(pixel_based_kbps(7680, 4320, 30), 160_000);
    }

    #[test]
    fn target_kbps_high_retina_60fps_keeps_screen_budget() {
        assert_eq!(
            target_kbps(
                QualityPreset::High,
                HardwareEncoder::VideoToolboxH264,
                2880,
                1800,
                60,
            ),
            64_800
        );
    }

    #[test]
    fn target_kbps_lossless_2x_browser_60fps_exceeds_old_80mbps_cap() {
        assert_eq!(
            target_kbps(
                QualityPreset::Lossless,
                HardwareEncoder::VideoToolboxH264,
                3600,
                2024,
                60,
            ),
            109_296
        );
    }

    #[test]
    fn software_med_args() {
        let got = resolve(
            QualityPreset::Med,
            HardwareEncoder::Libx264Software,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec![
                "-crf",
                "20",
                "-preset",
                "medium",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ]
        );
    }

    #[test]
    fn software_low_args() {
        let got = resolve(
            QualityPreset::Low,
            HardwareEncoder::Libx264Software,
            1920,
            1080,
            30,
        );
        assert!(got.iter().any(|a| a == "-tune"));
        assert_eq!(
            got,
            vec![
                "-crf",
                "26",
                "-preset",
                "veryfast",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ]
        );
    }

    #[test]
    fn software_high_args() {
        let got = resolve(
            QualityPreset::High,
            HardwareEncoder::Libx264Software,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec![
                "-crf",
                "18",
                "-preset",
                "slow",
                "-tune",
                "stillimage",
                "-profile:v",
                "high"
            ]
        );
    }

    #[test]
    fn software_lossless_args() {
        let got = resolve(
            QualityPreset::Lossless,
            HardwareEncoder::Libx264Software,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec!["-crf", "0", "-preset", "ultrafast", "-tune", "zerolatency"]
        );
    }

    #[test]
    fn videotoolbox_med_1080p_30fps_emits_cbr_budget() {
        let got = resolve(
            QualityPreset::Med,
            HardwareEncoder::VideoToolboxH264,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec![
                "-b:v",
                "10368k",
                "-maxrate",
                "12960k",
                "-bufsize",
                "20736k",
                "-constant_bit_rate",
                "true",
                "-realtime",
                "false",
                "-prio_speed",
                "false",
                "-power_efficient",
                "0",
                "-profile",
                "high",
                "-coder",
                "cabac",
            ]
        );
    }

    #[test]
    fn videotoolbox_realtime_mode_prioritizes_capture_speed() {
        let got = resolve_with_realtime(
            QualityPreset::High,
            HardwareEncoder::VideoToolboxH264,
            2880,
            1800,
            60,
            true,
        );
        assert!(got
            .windows(2)
            .any(|w| w[0] == "-realtime" && w[1] == "true"));
        assert!(got
            .windows(2)
            .any(|w| w[0] == "-prio_speed" && w[1] == "true"));
        assert!(
            !got.iter().any(|a| a == "-spatial_aq"),
            "VideoToolbox sidecar does not expose -spatial_aq"
        );
    }

    #[test]
    fn videotoolbox_hevc_omits_h264_only_profile_flags() {
        let h264 = resolve(
            QualityPreset::Med,
            HardwareEncoder::VideoToolboxH264,
            1920,
            1080,
            30,
        );
        let hevc = resolve(
            QualityPreset::Med,
            HardwareEncoder::VideoToolboxHevc,
            1920,
            1080,
            30,
        );
        assert!(h264.iter().any(|a| a == "-coder"));
        assert!(!hevc.iter().any(|a| a == "-coder"));
        assert!(hevc
            .windows(2)
            .any(|w| w[0] == "-constant_bit_rate" && w[1] == "true"));
    }

    #[test]
    fn videotoolbox_emits_b_v_and_no_q_v() {
        for preset in [
            QualityPreset::Low,
            QualityPreset::Med,
            QualityPreset::High,
            QualityPreset::Lossless,
        ] {
            for enc in [
                HardwareEncoder::VideoToolboxH264,
                HardwareEncoder::VideoToolboxHevc,
            ] {
                let args = resolve(preset, enc, 1920, 1080, 30);
                assert!(
                    args.iter().any(|a| a == "-b:v"),
                    "VT must emit -b:v for {:?}/{:?}",
                    preset,
                    enc
                );
                assert!(
                    !args.iter().any(|a| a == "-q:v"),
                    "VT must not emit -q:v for {:?}/{:?}",
                    preset,
                    enc
                );
            }
        }
    }

    #[test]
    fn videotoolbox_60fps_doubles_bitrate() {
        let args30 = resolve(
            QualityPreset::Med,
            HardwareEncoder::VideoToolboxH264,
            1920,
            1080,
            30,
        );
        let args60 = resolve(
            QualityPreset::Med,
            HardwareEncoder::VideoToolboxH264,
            1920,
            1080,
            60,
        );
        // -b:v at idx 1.
        assert_eq!(args30[0], "-b:v");
        assert_eq!(args60[0], "-b:v");
        assert_eq!(args30[1], "10368k");
        assert_eq!(args60[1], "20736k");
    }

    #[test]
    fn openh264_high_uses_bitrate_quality_mode() {
        let got = resolve(
            QualityPreset::High,
            HardwareEncoder::Openh264Software,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec![
                "-b:v",
                "12960k",
                "-profile:v",
                "high",
                "-rc_mode",
                "quality",
                "-coder",
                "cabac",
            ]
        );
    }

    #[test]
    fn nvenc_low_1080p_30fps_args() {
        let got = resolve(
            QualityPreset::Low,
            HardwareEncoder::NvencH264,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec!["-preset", "p5", "-rc", "vbr", "-cq", "26", "-b:v", "7776k", "-maxrate", "12960k"]
        );
    }

    #[test]
    fn qsv_med_args() {
        let got = resolve(QualityPreset::Med, HardwareEncoder::QsvH264, 1920, 1080, 30);
        assert_eq!(got, vec!["-preset", "medium", "-global_quality", "20"]);
    }

    #[test]
    fn amf_lossless_args() {
        let got = resolve(
            QualityPreset::Lossless,
            HardwareEncoder::AmfH264,
            1920,
            1080,
            30,
        );
        assert_eq!(
            got,
            vec!["-quality", "quality", "-rc", "cqp", "-qp_i", "15", "-qp_p", "17"]
        );
    }

    #[test]
    fn exhaustive_match_holds() {
        let presets = [
            QualityPreset::Low,
            QualityPreset::Med,
            QualityPreset::High,
            QualityPreset::Lossless,
        ];
        let encoders = [
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::VideoToolboxHevc,
            HardwareEncoder::NvencH264,
            HardwareEncoder::QsvH264,
            HardwareEncoder::AmfH264,
            HardwareEncoder::Libx264Software,
            HardwareEncoder::Openh264Software,
        ];
        for p in presets {
            for e in encoders {
                let got = resolve(p, e, 1920, 1080, 30);
                assert!(!got.is_empty(), "empty argv for {:?} + {:?}", p, e);
            }
        }
    }
}
