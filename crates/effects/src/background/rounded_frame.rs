//! Rounded-corner frame mask emitter.
//!
//! Generates the FFmpeg filter segment for the foreground frame mask.
//!
//! The previous implementation used `geq` to evaluate a rounded-corner alpha
//! expression for every pixel of every frame. On 1080p60 exports that made a
//! 38-second clip take about 5 minutes to render, because the final hardware
//! encoder was waiting on CPU-bound filter work. Until export has a precomputed
//! mask asset or GPU compositor path, FFmpeg export keeps this as a no-op.

/// Parameters for the rounded-corner mask.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedFrameParams {
    pub width: u32,
    pub height: u32,
    pub radius_px: f32,
}

/// Emit the foreground mask chain. `input_label` includes its brackets (e.g.
/// `"[v_a]"`) and `output_label` likewise.
pub fn emit_rounded_mask(_p: &RoundedFrameParams, input_label: &str, output_label: &str) -> String {
    format!("{input_label}null{output_label}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonzero_radius_uses_fast_noop_mask() {
        let out = emit_rounded_mask(
            &RoundedFrameParams {
                width: 1920,
                height: 1080,
                radius_px: 24.0,
            },
            "[in]",
            "[out]",
        );
        assert_eq!(out, "[in]null[out]");
    }

    #[test]
    fn zero_radius_emits_null() {
        let out = emit_rounded_mask(
            &RoundedFrameParams {
                width: 800,
                height: 600,
                radius_px: 0.0,
            },
            "[in]",
            "[out]",
        );
        assert_eq!(out, "[in]null[out]");
    }
}
