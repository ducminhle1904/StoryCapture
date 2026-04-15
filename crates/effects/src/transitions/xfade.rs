//! xfade filter emission for one pair of clips.
//!
//! Chooses `xfade_opencl` when the caller provides `use_opencl=true` AND the
//! requested kind is supported by the OpenCL variant. Otherwise falls back to
//! CPU `xfade`.

use crate::ast::video::XfadeKind;

/// Emit a single xfade filter segment. `in_a`, `in_b`, `out_label` must
/// include their brackets (e.g. `"[v_a]"`).
pub fn emit_xfade(
    kind: XfadeKind,
    duration_ms: u32,
    offset_ms: u32,
    in_a: &str,
    in_b: &str,
    out_label: &str,
    use_opencl: bool,
) -> String {
    let filter_name = if use_opencl && kind_supports_opencl(kind) {
        "xfade_opencl"
    } else {
        "xfade"
    };
    let dur = (duration_ms as f64) / 1000.0;
    let off = (offset_ms as f64) / 1000.0;
    format!(
        "{in_a}{in_b}{name}=transition={tok}:duration={dur:.3}:offset={off:.3}{out}",
        in_a = in_a,
        in_b = in_b,
        name = filter_name,
        tok = kind.ffmpeg_token(),
        dur = dur,
        off = off,
        out = out_label,
    )
}

/// Returns true if `xfade_opencl` implements the given transition kind.
/// FFmpeg's OpenCL variant supports the geometric transitions (fade, dissolve,
/// wipes, slides) but NOT the color-washes (fadeblack, fadewhite) or the
/// circle* transitions, which remain CPU-only.
pub fn kind_supports_opencl(kind: XfadeKind) -> bool {
    matches!(
        kind,
        XfadeKind::Fade
            | XfadeKind::Dissolve
            | XfadeKind::WipeLeft
            | XfadeKind::WipeRight
            | XfadeKind::WipeUp
            | XfadeKind::WipeDown
            | XfadeKind::SlideLeft
            | XfadeKind::SlideRight
            | XfadeKind::SlideUp
            | XfadeKind::SlideDown
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_cpu_xfade_by_default() {
        let out = emit_xfade(XfadeKind::Fade, 500, 9000, "[a]", "[b]", "[o]", false);
        assert_eq!(
            out,
            "[a][b]xfade=transition=fade:duration=0.500:offset=9.000[o]"
        );
    }

    #[test]
    fn emits_opencl_when_available_and_supported() {
        let out = emit_xfade(XfadeKind::WipeLeft, 500, 9000, "[a]", "[b]", "[o]", true);
        assert!(out.contains("xfade_opencl="));
        assert!(out.contains("transition=wipeleft"));
    }

    #[test]
    fn opencl_falls_back_for_unsupported_kinds() {
        // circleopen / fadeblack are CPU-only.
        let out = emit_xfade(XfadeKind::CircleOpen, 500, 9000, "[a]", "[b]", "[o]", true);
        assert!(out.contains("xfade="), "got {out}");
        assert!(!out.contains("xfade_opencl="));
    }
}
