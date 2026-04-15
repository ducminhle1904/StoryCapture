//! Rounded-corner frame mask emitter (POST-04).
//!
//! Generates a single FFmpeg filter segment that takes an RGBA input labelled
//! `input_label` and produces an output label where pixels inside the four
//! corner-radius arcs are transparent. Implemented via `geq` with a per-pixel
//! test against the nearest corner centre.

/// Parameters for the rounded-corner mask.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedFrameParams {
    pub width: u32,
    pub height: u32,
    pub radius_px: f32,
}

/// Emit a single `format=rgba,geq=...` chain that masks the four corners of
/// an input stream. `input_label` includes its brackets (e.g. `"[v_a]"`) and
/// `output_label` likewise. If `radius_px == 0`, emits a no-op `null` segment.
pub fn emit_rounded_mask(p: &RoundedFrameParams, input_label: &str, output_label: &str) -> String {
    let r = p.radius_px.round() as u32;
    if r == 0 {
        return format!("{input_label}null{output_label}");
    }
    // Per-pixel alpha test: if the pixel is inside one of the four corner
    // "outside the arc" regions, alpha = 0; otherwise preserve alpha(X,Y).
    //
    // For the top-left corner, the corner-centre is at (r, r). The pixel is
    // "outside the arc" when X<r && Y<r && (r-X)^2 + (r-Y)^2 > r^2.
    //
    // FFmpeg's `geq` evaluates boolean ops as 0/1; the nested `if` ladder
    // returns 0 for transparent, alpha(X,Y) for opaque.
    format!(
        "{input_label}format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,{r})*lt(Y,{r})*gt(pow({r}-X,2)+pow({r}-Y,2),pow({r},2)),0,if(gt(X,W-{r})*lt(Y,{r})*gt(pow(X-(W-{r}),2)+pow({r}-Y,2),pow({r},2)),0,if(lt(X,{r})*gt(Y,H-{r})*gt(pow({r}-X,2)+pow(Y-(H-{r}),2),pow({r},2)),0,if(gt(X,W-{r})*gt(Y,H-{r})*gt(pow(X-(W-{r}),2)+pow(Y-(H-{r}),2),pow({r},2)),0,alpha(X,Y)))))'{output_label}",
        input_label = input_label,
        output_label = output_label,
        r = r,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_geq_for_nonzero_radius() {
        let out = emit_rounded_mask(
            &RoundedFrameParams { width: 1920, height: 1080, radius_px: 24.0 },
            "[in]",
            "[out]",
        );
        assert!(out.starts_with("[in]format=rgba,geq=r="));
        assert!(out.ends_with("[out]"));
        assert!(out.contains("pow(24-X,2)"));
    }

    #[test]
    fn zero_radius_emits_null() {
        let out = emit_rounded_mask(
            &RoundedFrameParams { width: 800, height: 600, radius_px: 0.0 },
            "[in]",
            "[out]",
        );
        assert_eq!(out, "[in]null[out]");
    }
}
