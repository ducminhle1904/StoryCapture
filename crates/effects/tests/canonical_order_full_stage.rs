//! Canonical full-stage connectivity test.
//!
//! Builds a Graph covering every VideoNode variant + the AudioNode chain,
//! calls `FfmpegEmit::emit()`, parses the resulting filter_complex for
//! `[label]` tokens, and asserts:
//!   - every consumer label has exactly one matching producer;
//!   - every producer label has ≥ 1 matching consumer (except `[out_v]` and
//!     `[out_a]`, which terminate the chains).
//!
//! This guards against silent chain breaks as future emitters evolve
//! (e.g. RippleOverlay's no-op passthrough is validated by the connectivity
//! check — either `[inX]null[outX]` or elision must preserve continuity).

use std::collections::HashMap;
use std::path::PathBuf;

use effects::ast::audio::SidechainParams;
use effects::ast::types::NodeId;
use effects::ast::video::{
    BackgroundKind, CursorSkin, FontChoice, RippleEvent, TextAnim, TextBox, TrajectoryRef,
    XfadeKind, ZoomKeyframe, ZoomTarget,
};
use effects::ast::{EasingKind, Rgba, Vec2};
use effects::{FfmpegEmit, GraphBuilder};

fn fid(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

fn full_stage_graph() -> effects::Graph {
    GraphBuilder::new(1920, 1080, 60)
        .source(fid(0x11), PathBuf::from("a.mp4"), 0)
        .zoom_pan(
            fid(0x22),
            ZoomTarget::Cursor,
            vec![
                ZoomKeyframe {
                    t_ms: 0,
                    center: Vec2::new(960.0, 540.0),
                    scale: 1.0,
                    easing: EasingKind::Linear,
                },
                ZoomKeyframe {
                    t_ms: 500,
                    center: Vec2::new(1000.0, 560.0),
                    scale: 1.2,
                    easing: EasingKind::EaseInOut,
                },
            ],
        )
        .background(
            fid(0x33),
            BackgroundKind::Solid {
                color: Rgba::new(5, 10, 20, 255),
            },
            16.0,
            None,
        )
        .cursor(
            fid(0x44),
            CursorSkin::MacDefault,
            1.0,
            None,
            TrajectoryRef {
                png_sequence_dir: PathBuf::from("/tmp/c/frame_%05d.png"),
                fps: 60,
                frame_count: 60,
            },
        )
        .ripple(
            fid(0x55),
            // Non-empty events — no-op emitter must still preserve chain.
            vec![RippleEvent::at_impact(400, Vec2::new(500.0, 500.0))],
        )
        .text(
            fid(0x66),
            vec![TextBox {
                t_start_ms: 100,
                t_end_ms: 900,
                text: "hello".into(),
                pos: Vec2::new(40.0, 40.0),
                font: FontChoice::SystemDefault,
                size_pt: 24.0,
                color: Rgba::WHITE,
                box_style: None,
                anim_in: TextAnim::None,
                anim_out: TextAnim::None,
            }],
        )
        .transition(fid(0x77), XfadeKind::Fade, 400, 800)
        .audio_source(fid(0x81), PathBuf::from("a.mp3"), 0)
        .audio_source(fid(0x82), PathBuf::from("b.wav"), 100)
        .audio_sidechain(fid(0x83), "a_8181", "a_8282", SidechainParams::default())
        .audio_mix(fid(0x84), vec!["a_8383".into(), "a_8282".into()], false)
        .audio_limiter(fid(0x85), "a_8484", 0.95)
        .build()
        .expect("full-stage graph must build")
}

/// Parse one segment (between `;`s) for its producers (labels appearing after
/// a filter expression) and consumers (labels at the start of the segment).
///
/// A segment has the shape:
///   `[in1][in2]filter=args[out1][out2]`
/// so labels before the first non-label character are consumers, and labels
/// after the last non-label character are producers. Labels may also appear
/// interleaved with filter args (e.g. `movie=...[x];[x][y]overlay=...[z]`);
/// for simplicity we split on `;` first, then per-segment.
fn parse_segment_labels(seg: &str) -> (Vec<String>, Vec<String>) {
    let bytes = seg.as_bytes();
    let mut consumers = Vec::new();
    let mut producers = Vec::new();

    // Leading `[...]` groups are consumers.
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'[' {
        if let Some(end) = seg[i..].find(']') {
            consumers.push(seg[i + 1..i + end].to_string());
            i += end + 1;
        } else {
            break;
        }
    }

    // Trailing `[...]` groups are producers — walk from the end.
    let mut j = bytes.len();
    while j > 0 && bytes[j - 1] == b']' {
        // find matching '['.
        if let Some(start) = seg[..j].rfind('[') {
            producers.push(seg[start + 1..j - 1].to_string());
            j = start;
        } else {
            break;
        }
    }
    producers.reverse();

    (consumers, producers)
}

#[test]
fn full_stage_filter_graph_connectivity() {
    let g = full_stage_graph();
    let out = FfmpegEmit::emit(&g);

    // Collect producers and consumers across every segment.
    let mut producer_counts: HashMap<String, usize> = HashMap::new();
    let mut consumer_counts: HashMap<String, usize> = HashMap::new();
    for seg in out.split(';') {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        let (cs, ps) = parse_segment_labels(seg);
        for c in cs {
            *consumer_counts.entry(c).or_insert(0) += 1;
        }
        for p in ps {
            *producer_counts.entry(p).or_insert(0) += 1;
        }
    }

    // Rule 1: every consumer label must have exactly one matching producer
    // (with the exception of external inputs `N:v` / `N:a` — those come
    // from container streams, not from the filter graph).
    for (c, _count) in &consumer_counts {
        let is_external = c.contains(':') || c == "next";
        if is_external {
            continue;
        }
        let producer_n = producer_counts.get(c).copied().unwrap_or(0);
        assert_eq!(
            producer_n, 1,
            "consumer [{c}] has {producer_n} producers, expected 1.\nemit: {out}"
        );
    }

    // Rule 2: every producer label must have ≥ 1 consumer, *except* the two
    // terminal outputs (`out_v`, `out_a`) which are read by the sink.
    for (p, _count) in &producer_counts {
        if p == "out_v" || p == "out_a" {
            continue;
        }
        let consumer_n = consumer_counts.get(p).copied().unwrap_or(0);
        assert!(
            consumer_n >= 1,
            "producer [{p}] has zero consumers.\nemit: {out}"
        );
    }

    // Rule 3: terminals must exist.
    assert!(
        producer_counts.contains_key("out_v"),
        "missing [out_v] terminal. emit: {out}"
    );
    assert!(
        producer_counts.contains_key("out_a"),
        "missing [out_a] terminal. emit: {out}"
    );
}
