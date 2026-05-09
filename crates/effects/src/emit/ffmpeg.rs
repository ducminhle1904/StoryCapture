//! AST to FFmpeg `filter_complex` string.
//!
//! Stable labels keep the export graph deterministic.

use std::fmt::Write;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::ast::audio::{AudioNode, SidechainParams};
use crate::ast::types::{EasingKind, NodeId, Vec2};
use crate::ast::video::{TextBox, VideoNode, XfadeKind, ZoomKeyframe};
use crate::ast::Graph;
use crate::background::compositor::emit_background;
use crate::text::{
    bundled_filename_for, escape_drawtext_text, path_to_ffmpeg_arg,
    resolve_bundled_font_path_by_name,
};

/// Axis selector for [`zoompan_expr`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExprAxis {
    /// Scale.
    Z,
    /// X axis.
    X,
    /// Y axis.
    Y,
}

/// Build a zoompan expression from keyframes.
pub fn zoompan_expr(keyframes: &[ZoomKeyframe], axis: ExprAxis) -> String {
    if keyframes.is_empty() {
        return match axis {
            ExprAxis::Z => "1.0".to_string(),
            ExprAxis::X | ExprAxis::Y => "0".to_string(),
        };
    }

    if keyframes.len() == 1 {
        let k = keyframes[0];
        return format_axis_value(k, axis);
    }

    // Build the nested-if ladder from last to first.
    let mut expr = format_axis_value(*keyframes.last().unwrap(), axis);

    // Walk pairs in reverse.
    for i in (0..keyframes.len() - 1).rev() {
        let k0 = keyframes[i];
        let k1 = keyframes[i + 1];
        let t_hi = (k1.t_ms as f64) / 1000.0;
        let v0 = format_axis_value(k0, axis);
        let v1 = format_axis_value(k1, axis);
        let t_lo = (k0.t_ms as f64) / 1000.0;
        let dt = (t_hi - t_lo).max(1e-6);
        let progress = easing_progress_expr(k1.easing, t_lo, dt);
        let segment = format!(
            "({v0})+(({v1})-({v0}))*({progress})",
            v0 = v0,
            v1 = v1,
            progress = progress,
        );
        expr = format!("if(lt(in_time,{t_hi:.6}),{segment},{expr})");
    }

    // Hold the first value before the initial keyframe.
    let first = format_axis_value(keyframes[0], axis);
    let t0 = (keyframes[0].t_ms as f64) / 1000.0;
    format!("if(lt(in_time,{t0:.6}),{first},{expr})")
}

fn easing_progress_expr(kind: EasingKind, t_lo: f64, dt: f64) -> String {
    let u = format!("((in_time-{t_lo:.6})/{dt:.6})");
    match kind {
        EasingKind::Linear => u,
        EasingKind::EaseIn => format!("pow({u},2)"),
        EasingKind::EaseOut | EasingKind::EaseOutQuad => format!("1-pow(1-{u},2)"),
        EasingKind::EaseInOut | EasingKind::EaseInOutCubic => {
            format!("if(lt({u},0.5),4*pow({u},3),1-pow(-2*{u}+2,3)/2)")
        }
    }
}

fn format_axis_value(k: ZoomKeyframe, axis: ExprAxis) -> String {
    match axis {
        ExprAxis::Z => format!("{:.4}", k.scale),
        // Convert scene-space center to zoompan offset: offset = center - iw/(2*z)
        ExprAxis::X => format!("({:.2}-iw/(2*zoom))", k.center.x),
        ExprAxis::Y => format!("({:.2}-ih/(2*zoom))", k.center.y),
    }
}

/// Namespace for the FFmpeg emitter.
pub struct FfmpegEmit;

impl FfmpegEmit {
    pub fn emit(g: &Graph) -> String {
        emit_filter_complex(g)
    }
}

/// Emit a deterministic FFmpeg `filter_complex` string from the AST.
pub fn emit_filter_complex(g: &Graph) -> String {
    let mut out = String::with_capacity(512);
    emit_video_chain(&mut out, g);
    if !g.audio.is_empty() {
        if !out.is_empty() {
            out.push(';');
        }
        emit_audio_chain(&mut out, g, audio_input_start_index(g));
    }
    out
}

// ---------- video ----------

fn emit_video_chain(out: &mut String, g: &Graph) {
    let w = g.output_width;
    let h = g.output_height;

    // Start with the container's first video stream.
    let mut cur: String = "[0:v]".to_string();
    let mut source_count: usize = 0;
    let mut first_node = true;
    let mut i = 0;

    while i < g.video.len() {
        let node = &g.video[i];
        if !first_node {
            out.push(';');
        }
        first_node = false;

        let out_label = format!("[{}]", node.id().stable_label("v"));

        match node {
            VideoNode::Source {
                id, pts_offset_ms, ..
            } => {
                // Retarget to the underlying input stream.
                let in_label = format!("[{}:v]", source_count);
                source_count += 1;
                // Rename the stream and apply an optional PTS shift.
                let pts = (*pts_offset_ms as f64) / 1000.0;
                write!(
                    out,
                    "{in_label}setpts=PTS-STARTPTS+{pts:.6}/TB{out_label}",
                    in_label = in_label,
                    pts = pts,
                    out_label = out_label,
                )
                .unwrap();
                let _ = id;
                cur = out_label;
            }
            VideoNode::ZoomPan { .. } => {
                let (keyframes, last_id, next_i) = collect_consecutive_zoompan_nodes(&g.video, i);
                let out_label = format!("[{}]", last_id.stable_label("v"));
                let z_expr = zoompan_expr(&keyframes, ExprAxis::Z);
                let x_expr = zoompan_expr(&keyframes, ExprAxis::X);
                let y_expr = zoompan_expr(&keyframes, ExprAxis::Y);
                let fps = g.output_fps;
                write!(
                    out,
                    "{cur}zoompan=z='{z}':x='{x}':y='{y}':d=1:s={w}x{h}:fps={fps}{out_label}",
                    cur = cur,
                    z = z_expr,
                    x = x_expr,
                    y = y_expr,
                    w = w,
                    h = h,
                    fps = fps,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
                i = next_i;
                continue;
            }
            VideoNode::Background { .. } => {
                // Delegate to the background compositor.
                let bge = emit_background(node, &cur, &out_label, g, source_count)
                    .expect("emit_background failed");
                // Advance the input index for any extra source streams.
                source_count += bge.extra_inputs.len();
                out.push_str(&bge.filter_chain);
                cur = out_label;
            }
            VideoNode::CursorOverlay {
                trajectory,
                size_scale,
                ..
            } => {
                // Cursor frames come from a PNG sequence input.
                let cursor_src_label = format!("[{}_cursor]", node_label_core(node.id()));
                let cursor_pattern = cursor_sequence_pattern(&trajectory.png_sequence_dir);
                write!(
                    out,
                    "movie='{path}':loop=0,setpts=N/{fps}/TB,scale=iw*{s:.3}:ih*{s:.3}{cursor_src_label};{cur}{cursor_src_label}overlay=eof_action=pass:x=0:y=0{out_label}",
                    path = path_to_ffmpeg_arg(&cursor_pattern),
                    fps = trajectory.fps,
                    s = size_scale,
                    cursor_src_label = cursor_src_label,
                    cur = cur,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            VideoNode::RippleOverlay { events, .. } => {
                let _ = events;
                write!(
                    out,
                    "{cur}null{out_label}",
                    cur = cur,
                    out_label = out_label
                )
                .unwrap();
                cur = out_label;
            }
            VideoNode::HighlightOverlay { highlights, .. } => {
                let renderable: Vec<_> = highlights
                    .iter()
                    .enumerate()
                    .filter_map(|(i, highlight)| {
                        highlight.png_path.as_ref().map(|path| (i, highlight, path))
                    })
                    .collect();
                if renderable.is_empty() {
                    write!(
                        out,
                        "{cur}null{out_label}",
                        cur = cur,
                        out_label = out_label
                    )
                    .unwrap();
                    cur = out_label;
                    continue;
                }
                let mut highlight_cur = cur.clone();
                for (step_idx, (highlight_idx, highlight, path)) in renderable.iter().enumerate() {
                    if step_idx > 0 {
                        out.push(';');
                    }
                    let step_label = if step_idx + 1 == renderable.len() {
                        out_label.clone()
                    } else {
                        format!("[{}_h{}]", node_label_core(node.id()), highlight_idx)
                    };
                    let overlay_label =
                        format!("[{}_hsrc{}]", node_label_core(node.id()), highlight_idx);
                    let pos = highlight.overlay_pos.unwrap_or(Vec2::ZERO);
                    let from = highlight.t_start_ms as f64 / 1000.0;
                    let to = (highlight.t_start_ms + highlight.duration_ms as u64) as f64 / 1000.0;
                    write!(
                        out,
                        "movie='{path}',format=rgba{overlay_label};{highlight_cur}{overlay_label}overlay=x={x:.1}:y={y:.1}:enable='between(t,{from:.3},{to:.3})'{step_label}",
                        path = path_to_ffmpeg_arg(path),
                        overlay_label = overlay_label,
                        highlight_cur = highlight_cur,
                        x = pos.x,
                        y = pos.y,
                        from = from,
                        to = to,
                        step_label = step_label,
                    )
                    .unwrap();
                    highlight_cur = step_label;
                }
                cur = out_label;
            }
            VideoNode::TextOverlay { boxes, .. } => {
                // One drawtext per TextBox.
                if boxes.is_empty() {
                    write!(
                        out,
                        "{cur}null{out_label}",
                        cur = cur,
                        out_label = out_label
                    )
                    .unwrap();
                } else {
                    let mut text_cur = cur.clone();
                    for (i, tb) in boxes.iter().enumerate() {
                        if i > 0 {
                            out.push(';');
                        }
                        let step_label = if i + 1 == boxes.len() {
                            out_label.clone()
                        } else {
                            format!("[{}_t{}]", node_label_core(node.id()), i)
                        };
                        write!(
                            out,
                            "{cur}drawtext={args}{step}",
                            cur = text_cur,
                            args = drawtext_args(tb),
                            step = step_label,
                        )
                        .unwrap();
                        text_cur = step_label;
                    }
                }
                cur = out_label;
            }
            VideoNode::Transition {
                kind,
                duration_ms,
                offset_ms,
                ..
            } => {
                // xfade requires two inputs; we lift the previous chain as
                // `prev` and assume a `[next]` label is declared upstream in a
                // multi-scene graph. Here we emit the canonical token so
                // snapshots pin the form.
                let tok = XfadeKind::ffmpeg_token(*kind);
                let dur = (*duration_ms as f64) / 1000.0;
                let off = (*offset_ms as f64) / 1000.0;
                write!(
                    out,
                    "{cur}[next]xfade=transition={tok}:duration={dur:.3}:offset={off:.3}{out_label}",
                    cur = cur,
                    tok = tok,
                    dur = dur,
                    off = off,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
        }
        i += 1;
    }

    // Alias final label to [out_v] if we emitted anything.
    if !g.video.is_empty() {
        if !out.is_empty() {
            out.push(';');
        }
        write!(out, "{cur}null[out_v]", cur = cur).unwrap();
    }
}

fn collect_consecutive_zoompan_nodes(
    nodes: &[VideoNode],
    start: usize,
) -> (Vec<ZoomKeyframe>, NodeId, usize) {
    let mut keyframes = Vec::new();
    let mut last_id = nodes[start].id();
    let mut i = start;
    let mut node_count = 0;

    while let Some(VideoNode::ZoomPan {
        id, keyframes: kfs, ..
    }) = nodes.get(i)
    {
        node_count += 1;
        last_id = *id;
        keyframes.extend_from_slice(kfs);
        i += 1;
    }

    if node_count > 1 {
        keyframes.sort_by_key(|k| k.t_ms);
    }
    (keyframes, last_id, i)
}

fn drawtext_args(tb: &TextBox) -> String {
    let enable_from = (tb.t_start_ms as f64) / 1000.0;
    let enable_to = (tb.t_end_ms as f64) / 1000.0;
    let x = drawtext_pos_expr(tb.pos.x, 'x');
    let y = drawtext_pos_expr(tb.pos.y, 'y');
    let box_args = drawtext_box_args(tb);
    format!(
        "fontfile='{font}':text='{t}':x='{x}':y='{y}':fontsize={fs:.1}:fontcolor=0x{R:02X}{G:02X}{B:02X}@{A:.3}{box_args}:enable='between(t,{f:.3},{to:.3})'",
        font = path_to_ffmpeg_arg(&drawtext_font_path(tb)),
        t = escape_drawtext_text(&tb.text),
        x = x,
        y = y,
        fs = tb.size_pt,
        R = tb.color.r, G = tb.color.g, B = tb.color.b,
        A = (tb.color.a as f32) / 255.0,
        box_args = box_args,
        f = enable_from, to = enable_to,
    )
}

fn drawtext_pos_expr(value: f32, axis: char) -> String {
    let value = value.clamp(0.0, 1.0);
    match axis {
        'x' => format!("(W-text_w)*{value:.6}"),
        'y' => format!("(H-text_h)*{value:.6}"),
        _ => unreachable!("drawtext position axis must be x or y"),
    }
}

fn drawtext_box_args(tb: &TextBox) -> String {
    let Some(style) = &tb.box_style else {
        return String::new();
    };
    let alpha = (style.bg_color.a as f32) / 255.0;
    format!(
        ":box=1:boxcolor=0x{R:02X}{G:02X}{B:02X}@{A:.3}:boxborderw={padding:.0}",
        R = style.bg_color.r,
        G = style.bg_color.g,
        B = style.bg_color.b,
        A = alpha,
        padding = style.padding_px.max(0.0),
    )
}

fn drawtext_font_path(tb: &TextBox) -> PathBuf {
    let bundled_name = bundled_filename_for(&tb.font);
    for candidate in [
        PathBuf::from("assets").join("fonts").join(bundled_name),
        PathBuf::from("..")
            .join("..")
            .join("assets")
            .join("fonts")
            .join(bundled_name),
    ] {
        if is_usable_drawtext_font(&candidate) {
            return candidate;
        }
    }
    match resolve_bundled_font_path_by_name(bundled_name) {
        Ok(path) if is_usable_drawtext_font(&path) => path,
        _ => default_system_font_path(),
    }
}

fn is_usable_drawtext_font(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if !meta.is_file() || meta.len() < 1024 {
        return false;
    }

    let mut header = [0_u8; 4];
    if file.read_exact(&mut header).is_err() {
        return false;
    }

    matches!(&header, b"OTTO" | b"ttcf") || header == [0x00, 0x01, 0x00, 0x00]
}

fn default_system_font_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/System/Library/Fonts/Helvetica.ttc")
    }
    #[cfg(target_os = "windows")]
    {
        PathBuf::from("C:/Windows/Fonts/arial.ttf")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    }
}

fn node_label_core(id: NodeId) -> String {
    id.stable_label("n")
}

fn cursor_sequence_pattern(path: &std::path::Path) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    if s.contains('%') || path.extension().and_then(|ext| ext.to_str()) == Some("png") {
        path.to_path_buf()
    } else {
        path.join("frame_%05d.png")
    }
}

// ---------- audio ----------

fn emit_audio_chain(out: &mut String, g: &Graph, first_audio_input_index: usize) {
    let mut cur: String = format!("[{}:a]", first_audio_input_index);
    let mut source_count = first_audio_input_index;
    let mut first = true;

    for node in &g.audio {
        if !first {
            out.push(';');
        }
        first = false;

        let out_label = format!("[{}]", node.id().stable_label("a"));

        match node {
            AudioNode::AudioSource { pts_offset_ms, .. } => {
                let in_label = format!("[{}:a]", source_count);
                source_count += 1;
                let pts = (*pts_offset_ms as f64) / 1000.0;
                write!(
                    out,
                    "{in_label}asetpts=PTS-STARTPTS+{pts:.6}/TB{out_label}",
                    in_label = in_label,
                    pts = pts,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            AudioNode::Volume {
                input_label,
                volume,
                ..
            } => {
                write!(
                    out,
                    "[{inp}]volume={v:.3}{out_label}",
                    inp = input_label,
                    v = volume,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            AudioNode::Delay {
                input_label, ms, ..
            } => {
                write!(
                    out,
                    "[{inp}]adelay={ms}|{ms}{out_label}",
                    inp = input_label,
                    ms = ms,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            AudioNode::Sidechain {
                carrier,
                sidechain,
                params,
                ..
            } => {
                write!(
                    out,
                    "[{c}][{sc}]sidechaincompress={args}{out_label}",
                    c = carrier,
                    sc = sidechain,
                    args = sidechain_args(params),
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            AudioNode::Amix {
                inputs, normalize, ..
            } => {
                let joined: String = inputs
                    .iter()
                    .map(|s| format!("[{}]", s))
                    .collect::<Vec<_>>()
                    .join("");
                write!(
                    out,
                    "{joined}amix=inputs={n}:normalize={norm}{out_label}",
                    joined = joined,
                    n = inputs.len(),
                    norm = if *normalize { 1 } else { 0 },
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
            AudioNode::Alimiter { input, limit, .. } => {
                write!(
                    out,
                    "[{inp}]alimiter=limit={l:.3}{out_label}",
                    inp = input,
                    l = limit,
                    out_label = out_label,
                )
                .unwrap();
                cur = out_label;
            }
        }
    }
    if !g.audio.is_empty() {
        out.push(';');
        write!(out, "{cur}anull[out_a]", cur = cur).unwrap();
    }
}

fn audio_input_start_index(g: &Graph) -> usize {
    let mut source_count = 0;
    for node in &g.video {
        match node {
            VideoNode::Source { .. } => source_count += 1,
            VideoNode::Background { .. } => {
                let bge = emit_background(node, "[ignored]", "[ignored]", g, source_count)
                    .expect("emit_background failed");
                source_count += bge.extra_inputs.len();
            }
            _ => {}
        }
    }
    source_count
}

fn sidechain_args(p: &SidechainParams) -> String {
    format!(
        "threshold={t:.3}:ratio={r:.2}:attack={a}:release={rel}",
        t = p.threshold,
        r = p.ratio,
        a = p.attack_ms,
        rel = p.release_ms,
    )
}

/// Collect the extra `-i` inputs needed by every Background node in the
/// graph, in traversal order. The renderer integration consumes this to
/// build the FFmpeg CLI. The source-stream index of the Nth extra input is
/// `source_count_when_background_seen + N` — matching the allocation done by
/// [`emit_filter_complex`].
pub fn collect_extra_inputs(g: &Graph) -> Vec<crate::background::compositor::ExtraInput> {
    let mut out = Vec::new();
    let mut src_idx: usize = 0;
    for node in &g.video {
        match node {
            VideoNode::Source { .. } => src_idx += 1,
            VideoNode::Background { .. } => {
                if let Ok(bge) = emit_background(node, "[ignored]", "[ignored]", g, src_idx) {
                    src_idx += bge.extra_inputs.len();
                    out.extend(bge.extra_inputs);
                }
            }
            _ => {}
        }
    }
    out
}
