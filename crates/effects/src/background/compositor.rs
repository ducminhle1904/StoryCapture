//! Background compositor.
//!
//! Emits the extra FFmpeg inputs and filter fragment for a background node.

use std::path::PathBuf;

use crate::ast::types::NodeId;
use crate::ast::video::{BackgroundKind, Shadow, VideoNode};
use crate::ast::Graph;
use crate::background::gradients::{lookup, resolve_asset_path};
use crate::background::rounded_frame::{emit_rounded_mask, RoundedFrameParams};
use crate::background::shadow::{emit_drop_shadow, ShadowParams};
use crate::error::EffectsError;

/// Extra `-i` inputs needed by the compositor.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtraInput {
    /// Absolute or repo-relative path, or lavfi expression.
    pub uri: String,
    /// Wrap the input with `-loop 1`.
    pub loop_single_frame: bool,
    /// Input is a lavfi synthetic source.
    pub lavfi: bool,
}

/// Result of emitting a background node.
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundEmit {
    /// Filter-complex fragment.
    pub filter_chain: String,
    /// Additional inputs for FFmpeg.
    pub extra_inputs: Vec<ExtraInput>,
}

/// Emit a background node.
pub fn emit_background(
    node: &VideoNode,
    in_label: &str,
    out_label: &str,
    graph: &Graph,
    bg_input_index: usize,
) -> Result<BackgroundEmit, EffectsError> {
    let (kind, radius_px, shadow, padding_px, id) = match node {
        VideoNode::Background { kind, radius_px, shadow, padding_px, id } => {
            (kind, *radius_px, shadow.clone(), *padding_px, *id)
        }
        _ => {
            return Err(EffectsError::UnknownInputLabel(
                "emit_background called on non-Background node".into(),
            ))
        }
    };

    let w = graph.output_width;
    let h = graph.output_height;

    // Extra input for the background plate.
    let (extra_inputs, bg_raw_label) = match kind {
        BackgroundKind::Gradient { preset_id } => {
            let preset = lookup(preset_id.as_str())
                .ok_or_else(|| EffectsError::UnknownGradient(preset_id.clone()))?;
            let abs: PathBuf = resolve_asset_path(preset);
            (
                vec![ExtraInput {
                    uri: abs.to_string_lossy().into_owned(),
                    loop_single_frame: true,
                    lavfi: false,
                }],
                format!("[{}:v]", bg_input_index),
            )
        }
        BackgroundKind::Image { path } => (
            vec![ExtraInput {
                uri: path.to_string_lossy().into_owned(),
                loop_single_frame: true,
                lavfi: false,
            }],
            format!("[{}:v]", bg_input_index),
        ),
        BackgroundKind::Solid { color } => (
            vec![ExtraInput {
                uri: format!(
                    "color=c=0x{r:02X}{g:02X}{b:02X}@{a:.3}:s={w}x{h}",
                    r = color.r,
                    g = color.g,
                    b = color.b,
                    a = (color.a as f32) / 255.0,
                    w = w,
                    h = h,
                ),
                loop_single_frame: false,
                lavfi: true,
            }],
            format!("[{}:v]", bg_input_index),
        ),
    };

    // Stable label core for this node.
    let core = stable_core(id);

    // Scale the background plate to output size.
    let bg_scaled = format!("[{}_bg_scaled]", core);
    let mut chain = String::new();
    chain.push_str(&format!(
        "{bg_raw}scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}{bg_scaled}",
        bg_raw = bg_raw_label,
        w = w,
        h = h,
        bg_scaled = bg_scaled,
    ));

    // Scale the foreground inside the padding box.
    let fg_w = w.saturating_sub(2 * padding_px);
    let fg_h = h.saturating_sub(2 * padding_px);
    let fg_scaled = format!("[{}_fg_scaled]", core);
    chain.push(';');
    chain.push_str(&format!(
        "{in_label}scale={fg_w}:{fg_h}{fg_scaled}",
        in_label = in_label,
        fg_w = fg_w,
        fg_h = fg_h,
        fg_scaled = fg_scaled,
    ));

    // Apply the rounded mask.
    let fg_rounded = format!("[{}_fg_rounded]", core);
    chain.push(';');
    chain.push_str(&emit_rounded_mask(
        &RoundedFrameParams { width: fg_w, height: fg_h, radius_px },
        &fg_scaled,
        &fg_rounded,
    ));

    // Optional drop shadow from the rounded foreground.
    let (pre_overlay_label, shadow_overlay) = if let Some(sh) = shadow {
        let sp = ShadowParams {
            blur_px: sh.blur_px,
            offset: sh.offset,
            color: sh.color,
        };
        let split_a = format!("[{}_fg_a]", core);
        let split_b = format!("[{}_fg_b]", core);
        let shadow_label = format!("[{}_shadow]", core);
        chain.push(';');
        chain.push_str(&format!(
            "{fg_rounded}split=2{split_a}{split_b}",
            fg_rounded = fg_rounded,
            split_a = split_a,
            split_b = split_b,
        ));
        chain.push(';');
        chain.push_str(&emit_drop_shadow(&sp, &split_b, &shadow_label));
        // Overlay the shadow onto the background.
        let ox = padding_px as f32 + sp.offset.x;
        let oy = padding_px as f32 + sp.offset.y;
        let bg_plus_shadow = format!("[{}_bg_sh]", core);
        chain.push(';');
        chain.push_str(&format!(
            "{bg_scaled}{shadow_label}overlay=x={ox:.0}:y={oy:.0}{bg_plus_shadow}",
            bg_scaled = bg_scaled,
            shadow_label = shadow_label,
            ox = ox,
            oy = oy,
            bg_plus_shadow = bg_plus_shadow,
        ));
        (split_a, bg_plus_shadow)
    } else {
        (fg_rounded, bg_scaled)
    };

    // Final overlay of the rounded video.
    chain.push(';');
    chain.push_str(&format!(
        "{bg}{fg}overlay=x={px}:y={py}{out_label}",
        bg = shadow_overlay,
        fg = pre_overlay_label,
        px = padding_px,
        py = padding_px,
        out_label = out_label,
    ));

    let _ = (kind, id);

    Ok(BackgroundEmit { filter_chain: chain, extra_inputs })
}

fn stable_core(id: NodeId) -> String {
    id.stable_label("n")
}

/// Build `ShadowParams` from the AST `Shadow` type.
pub fn shadow_params_from(s: &Shadow) -> ShadowParams {
    ShadowParams {
        blur_px: s.blur_px,
        offset: s.offset,
        color: s.color,
    }
}
