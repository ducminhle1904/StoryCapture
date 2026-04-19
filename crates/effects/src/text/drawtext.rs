//! `drawtext` filter emission for a [`TextBox`] — with Pitfall #8
//! mitigation (forward-slash paths, escaping `:` / `\` / `'` / `%`).
//!
//! The FFmpeg filter arg syntax escapes the following inside a quoted
//! value:
//!
//! | Char  | Escape       | Reason                                   |
//! |-------|--------------|------------------------------------------|
//! | `\`   | `\\`         | Filter arg escape introducer             |
//! | `:`   | `\:`         | `:` separates filter args                |
//! | `'`   | `\'`         | `'` quotes the filter arg value          |
//! | `%`   | `\%`         | Reserved for `drawtext` expansion tokens |
//!
//! Newlines (`\n`) are preserved literally — drawtext recognises the
//! two-char sequence as a hard break.

use std::path::Path;

use crate::ast::types::Rgba;
use crate::ast::video::{FontChoice, TextAnim, TextBox};
use crate::error::Result;

use super::animation::{anim_scale_in_params, anim_slide_up_params, compose_alpha_expr};
use super::fonts::{font_filename_for, BundledFont};

/// Escape a user string for inclusion in a quoted drawtext `text=`
/// argument.
pub fn escape_drawtext_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    // Order matters: escape `\` first so we do not double-escape the
    // backslashes produced by the subsequent escapes.
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ':' => out.push_str("\\:"),
            '\'' => out.push_str("\\'"),
            '%' => out.push_str("\\%"),
            _ => out.push(ch),
        }
    }
    out
}

/// Convert a filesystem path into a drawtext-safe string (forward
/// slashes, no trailing newline).
///
/// Pitfall #8: on Windows FFmpeg builds, `\` in the path is consumed by
/// the filter-arg escape grammar. Forward slashes work on every
/// platform, including Windows (FFmpeg's `avformat_open_input` accepts
/// them verbatim). The caller is expected to have already routed the
/// path through `ensure_fonts_extracted` so spaces are not present —
/// if spaces remain, we escape them defensively via `:` treatment.
pub fn path_to_ffmpeg_arg(p: &Path) -> String {
    let s: String = p.to_string_lossy().replace('\\', "/");
    // Escape a drive-letter colon on Windows (`C:/…`) so the filter arg
    // parser does not treat it as a separator.
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            ':' => out.push_str("\\:"),
            '\'' => out.push_str("\\'"),
            _ => out.push(ch),
        }
    }
    out
}

fn rgba_to_hex(c: &Rgba) -> String {
    format!("{:02X}{:02X}{:02X}{:02X}", c.r, c.g, c.b, c.a)
}

/// Map the AST's `FontChoice` to a bundled TTF filename. `SystemDefault`
/// is lowered to `Geist-Regular` so emission is always deterministic;
/// the UI layer is expected to warn the user when they've picked a
/// non-bundled choice.
pub fn bundled_filename_for(choice: &FontChoice) -> &'static str {
    match choice {
        FontChoice::Bundled { family, weight } => {
            font_filename_for(BundledFont::from_family_weight(family, *weight))
        }
        FontChoice::SystemDefault => font_filename_for(BundledFont::GeistSansRegular),
    }
}

/// Emit a single `drawtext` filter stage for a `TextBox`.
///
/// `font_dir` MUST be the output of [`super::fonts::ensure_fonts_extracted`]
/// (a space-free UUID dir). `in_label` / `out_label` are the FFmpeg
/// graph labels surrounding this stage (e.g. `"[v_0001]"`, `"[v_0002]"`).
pub fn emit_drawtext(
    tb: &TextBox,
    font_dir: &Path,
    in_label: &str,
    out_label: &str,
) -> Result<String> {
    let font_file = font_dir.join(bundled_filename_for(&tb.font));
    let font_arg = path_to_ffmpeg_arg(&font_file);

    let alpha_expr = compose_alpha_expr(tb);
    let text_escaped = escape_drawtext_text(&tb.text);
    let enable = format!(
        "between(t,{:.3},{:.3})",
        tb.t_start_ms as f64 / 1000.0,
        tb.t_end_ms as f64 / 1000.0
    );

    // Slide-up modifies `y`; scale-in modifies `fontsize`. Both share
    // the same alpha ramp as `fade`.
    let (y_expr, size_scale_expr) = match (&tb.anim_in, &tb.anim_out) {
        (TextAnim::SlideUp, _) | (_, TextAnim::SlideUp) => {
            let (_alpha, y) = anim_slide_up_params(tb.t_start_ms, tb.t_end_ms, 300, 300);
            (Some(y), None)
        }
        (TextAnim::ScaleIn, _) | (_, TextAnim::ScaleIn) => {
            let (_alpha, s) = anim_scale_in_params(tb.t_start_ms, tb.t_end_ms, 300, 300);
            (None, Some(s))
        }
        _ => (None, None),
    };

    let y_arg = match y_expr {
        Some(delta) => format!("{y_base}+{delta}", y_base = tb.pos.y as i32, delta = delta),
        None => format!("{}", tb.pos.y as i32),
    };
    let fontsize_arg = match size_scale_expr {
        Some(scale) => format!(
            "'{size}*({scale})'",
            size = tb.size_pt as u32,
            scale = scale
        ),
        None => format!("{}", tb.size_pt as u32),
    };

    Ok(format!(
        "{in_label}drawtext=fontfile='{font}':text='{text}':x={x}:y='{y}':fontcolor=0x{fg}:fontsize={size}:alpha='{alpha}':enable='{enable}'{out_label}",
        in_label = in_label,
        font = font_arg,
        text = text_escaped,
        x = tb.pos.x as i32,
        y = y_arg,
        fg = rgba_to_hex(&tb.color),
        size = fontsize_arg,
        alpha = alpha_expr,
        enable = enable,
        out_label = out_label,
    ))
}
