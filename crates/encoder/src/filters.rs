//! FFmpeg filter-graph emitter. Pure module — no Tauri or IPC dependencies.
//! Emits canonical letterbox / fill-crop / stretch chains with validated,
//! injection-resistant inputs.

use crate::error::{EncoderError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FitMode {
    Letterbox,
    FillCrop,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ScaleAlgo {
    Lanczos,
    Bicubic,
    Bilinear,
    Area,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadColor {
    Black,
    White,
    Custom { r: u8, g: u8, b: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputResolution {
    P720,
    P1080,
    P1440,
    P2160,
    MatchSource,
    Custom { w: u32, h: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityPreset {
    Low,
    Med,
    High,
    Lossless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorAdjustment {
    None,
    ScreenVivid,
}

#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub capture_w: u32,
    pub capture_h: u32,
    pub output_w: u32,
    pub output_h: u32,
    pub fit: FitMode,
    pub pad_color: PadColor,
    pub scale_algo: ScaleAlgo,
    pub color_adjustment: ColorAdjustment,
}

impl ScaleAlgo {
    pub fn ffmpeg_flag(&self) -> &'static str {
        match self {
            ScaleAlgo::Lanczos => "lanczos",
            ScaleAlgo::Bicubic => "bicubic",
            ScaleAlgo::Bilinear => "bilinear",
            ScaleAlgo::Area => "area",
        }
    }
}

impl PadColor {
    pub fn to_ffmpeg_color(&self) -> String {
        match self {
            PadColor::Black => "black".to_string(),
            PadColor::White => "white".to_string(),
            PadColor::Custom { r, g, b } => format!("0x{:02x}{:02x}{:02x}", r, g, b),
        }
    }
}

impl ColorAdjustment {
    fn ffmpeg_filter(self) -> Option<&'static str> {
        match self {
            ColorAdjustment::None => None,
            // A deliberately mild screen-recording grade. This restores a bit
            // of perceived P3/Retina vividness after SDR/yuv420p conversion
            // without turning neutral UI grays visibly colored.
            ColorAdjustment::ScreenVivid => Some("eq=contrast=1.02:saturation=1.10"),
        }
    }
}

impl OutputResolution {
    pub fn resolve_even(&self, capture_w: u32, capture_h: u32) -> Result<(u32, u32)> {
        match self {
            OutputResolution::P720 => Ok((1280, 720)),
            OutputResolution::P1080 => Ok((1920, 1080)),
            OutputResolution::P1440 => Ok((2560, 1440)),
            OutputResolution::P2160 => Ok((3840, 2160)),
            OutputResolution::MatchSource => {
                let w = capture_w & !1;
                let h = capture_h & !1;
                if w == 0 || h == 0 {
                    return Err(EncoderError::InvalidFilterSpec(format!(
                        "MatchSource rounded capture ({}x{}) to zero dim",
                        capture_w, capture_h
                    )));
                }
                Ok((w, h))
            }
            OutputResolution::Custom { w, h } => {
                if w % 2 != 0 || h % 2 != 0 {
                    return Err(EncoderError::InvalidFilterSpec(format!(
                        "Custom output dims must be even, got {}x{}",
                        w, h
                    )));
                }
                if !(16..=7680).contains(w) || !(16..=4320).contains(h) {
                    return Err(EncoderError::InvalidFilterSpec(format!(
                        "Custom output dims out of range (w 16..=7680, h 16..=4320), got {}x{}",
                        w, h
                    )));
                }
                Ok((*w, *h))
            }
        }
    }
}

pub fn build_vf(spec: &FilterSpec) -> Result<String> {
    if spec.capture_w == 0 || spec.capture_h == 0 {
        return Err(EncoderError::InvalidFilterSpec(format!(
            "capture dims must be non-zero, got {}x{}",
            spec.capture_w, spec.capture_h
        )));
    }
    if spec.output_w == 0 || spec.output_h == 0 {
        return Err(EncoderError::InvalidFilterSpec(format!(
            "output dims must be non-zero, got {}x{}",
            spec.output_w, spec.output_h
        )));
    }
    if spec.output_w % 2 != 0 || spec.output_h % 2 != 0 {
        return Err(EncoderError::InvalidFilterSpec(format!(
            "output dims must be even, got {}x{}",
            spec.output_w, spec.output_h
        )));
    }

    let scale_filter = |prefix: String| -> String {
        format!("{prefix}:in_range=pc:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709")
    };
    let color_tag_filter =
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
    let finish_chain = |chain: String| -> String {
        if let Some(adjustment) = spec.color_adjustment.ffmpeg_filter() {
            format!("{chain},{adjustment},setsar=1,{color_tag_filter},format=yuv420p")
        } else {
            format!("{chain},setsar=1,{color_tag_filter},format=yuv420p")
        }
    };

    // Equal-size Letterbox still needs an explicit RGB full-range to BT.709
    // limited-range conversion. Relying on metadata-only tags leaves swscale
    // defaults/player interpretation to decide the range.
    if spec.capture_w == spec.output_w
        && spec.capture_h == spec.output_h
        && matches!(spec.fit, FitMode::Letterbox)
    {
        return Ok(finish_chain(scale_filter(format!(
            "scale=iw:ih:flags={}",
            spec.scale_algo.ffmpeg_flag()
        ))));
    }

    let w = spec.output_w;
    let h = spec.output_h;
    let algo = spec.scale_algo.ffmpeg_flag();

    let chain = match spec.fit {
        FitMode::Letterbox => {
            let color = spec.pad_color.to_ffmpeg_color();
            finish_chain(format!(
                "{},pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={color}",
                scale_filter(format!(
                    "scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags={algo}"
                ))
            ))
        }
        FitMode::FillCrop => finish_chain(format!(
            "{},crop={w}:{h}",
            scale_filter(format!(
                "scale={w}:{h}:force_original_aspect_ratio=increase:flags={algo}"
            ))
        )),
        FitMode::Stretch => finish_chain(scale_filter(format!("scale={w}:{h}:flags={algo}"))),
    };

    Ok(chain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        cap: (u32, u32),
        out: (u32, u32),
        fit: FitMode,
        pad: PadColor,
        algo: ScaleAlgo,
    ) -> FilterSpec {
        FilterSpec {
            capture_w: cap.0,
            capture_h: cap.1,
            output_w: out.0,
            output_h: out.1,
            fit,
            pad_color: pad,
            scale_algo: algo,
            color_adjustment: ColorAdjustment::None,
        }
    }

    #[test]
    fn snapshot_letterbox_1920x1130_to_p1080_black_lanczos() {
        let s = spec(
            (1920, 1130),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_800x600_to_p1080_black_lanczos() {
        let s = spec(
            (800, 600),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_3840x2160_to_p1080_white_bicubic() {
        let s = spec(
            (3840, 2160),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::White,
            ScaleAlgo::Bicubic,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_2560x1440_to_p2160_black_lanczos() {
        let s = spec(
            (2560, 1440),
            (3840, 2160),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_1920x1080_to_p1080_passthrough() {
        let s = spec(
            (1920, 1080),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_matchsource_1920x1080_passthrough() {
        let (w, h) = OutputResolution::MatchSource
            .resolve_even(1920, 1080)
            .unwrap();
        let s = spec(
            (1920, 1080),
            (w, h),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_letterbox_matchsource_1923x1081_rounds_to_1922x1080() {
        let (w, h) = OutputResolution::MatchSource
            .resolve_even(1923, 1081)
            .unwrap();
        assert_eq!((w, h), (1922, 1080));
        let s = spec(
            (1923, 1081),
            (w, h),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_fillcrop_1920x1080_to_p720_black_lanczos() {
        let s = spec(
            (1920, 1080),
            (1280, 720),
            FitMode::FillCrop,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_stretch_1920x1080_to_p720_black_bilinear() {
        let s = spec(
            (1920, 1080),
            (1280, 720),
            FitMode::Stretch,
            PadColor::Black,
            ScaleAlgo::Bilinear,
        );
        insta::assert_snapshot!(build_vf(&s).unwrap());
    }

    #[test]
    fn snapshot_padcolor_custom_lowercase_hex() {
        let s = spec(
            (1920, 1130),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::Custom {
                r: 255,
                g: 0,
                b: 128,
            },
            ScaleAlgo::Lanczos,
        );
        let out = build_vf(&s).unwrap();
        assert!(out.contains("color=0xff0080"), "got: {}", out);
        insta::assert_snapshot!(out);
    }

    #[test]
    fn reject_zero_capture_dim() {
        let s = spec(
            (0, 1080),
            (1920, 1080),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        assert!(matches!(
            build_vf(&s),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
    }

    #[test]
    fn reject_zero_output_dim() {
        let s = spec(
            (1920, 1080),
            (1920, 0),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        assert!(matches!(
            build_vf(&s),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
    }

    #[test]
    fn reject_odd_output_dim() {
        let s = spec(
            (1920, 1080),
            (1921, 1080),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        assert!(matches!(
            build_vf(&s),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
    }

    #[test]
    fn reject_custom_out_of_range() {
        assert!(matches!(
            OutputResolution::Custom { w: 10, h: 10 }.resolve_even(0, 0),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
        assert!(matches!(
            OutputResolution::Custom { w: 8000, h: 2160 }.resolve_even(0, 0),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
        assert!(matches!(
            OutputResolution::Custom { w: 1921, h: 1080 }.resolve_even(0, 0),
            Err(EncoderError::InvalidFilterSpec(_))
        ));
    }

    #[test]
    fn matchsource_rounds_odd_dims_to_even() {
        let (w, h) = OutputResolution::MatchSource
            .resolve_even(1923, 1081)
            .unwrap();
        assert_eq!((w, h), (1922, 1080));
    }

    #[test]
    fn padcolor_custom_hex_is_always_ascii_lowercase_hex() {
        let re_hex = |s: &str| -> bool {
            if !s.starts_with("0x") || s.len() != 8 {
                return false;
            }
            s[2..]
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        };
        for r in (0u16..=255).step_by(17) {
            for g in (0u16..=255).step_by(17) {
                for b in (0u16..=255).step_by(17) {
                    let c = PadColor::Custom {
                        r: r as u8,
                        g: g as u8,
                        b: b as u8,
                    }
                    .to_ffmpeg_color();
                    assert!(re_hex(&c), "non-ascii-lowercase-hex: {}", c);
                }
            }
        }
    }

    #[test]
    fn scale_algo_flags() {
        assert_eq!(ScaleAlgo::Lanczos.ffmpeg_flag(), "lanczos");
        assert_eq!(ScaleAlgo::Bicubic.ffmpeg_flag(), "bicubic");
        assert_eq!(ScaleAlgo::Bilinear.ffmpeg_flag(), "bilinear");
        assert_eq!(ScaleAlgo::Area.ffmpeg_flag(), "area");
    }

    #[test]
    fn screen_vivid_adjustment_is_inserted_before_color_tags() {
        let mut s = spec(
            (2880, 1800),
            (2880, 1800),
            FitMode::Letterbox,
            PadColor::Black,
            ScaleAlgo::Lanczos,
        );
        s.color_adjustment = ColorAdjustment::ScreenVivid;

        let vf = build_vf(&s).unwrap();
        assert!(vf.contains("eq=contrast=1.02:saturation=1.10,setsar=1,setparams"));
        assert!(vf.ends_with("format=yuv420p"));
    }
}
