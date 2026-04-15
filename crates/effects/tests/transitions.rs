//! Scene-transition (xfade) integration tests (POST-05 / Plan 07 Task 3).
//!
//! Exercises:
//!   - XfadeTimeline::compute_offsets (single, chained three, varying durations, empty)
//!   - emit_xfade CPU + opencl-supported + opencl-unsupported fall-through
//!   - probe_from_stdout for xfade_opencl availability
//!   - insta snapshot for a 3-clip chained filter_complex

use effects::ast::video::XfadeKind;
use effects::transitions::{
    compute_offsets, emit_xfade, kind_supports_opencl, probe_from_stdout, XfadeTimeline,
};

#[test]
fn offsets_single_transition() {
    let tl = XfadeTimeline {
        clip_durations_ms: vec![10_000, 10_000],
        transitions: vec![(0, XfadeKind::Fade, 1000)],
    };
    assert_eq!(compute_offsets(&tl), vec![9_000]);
}

#[test]
fn offsets_chained_three() {
    let tl = XfadeTimeline {
        clip_durations_ms: vec![10_000, 10_000, 10_000],
        transitions: vec![
            (0, XfadeKind::Fade, 1000),
            (1, XfadeKind::Dissolve, 1000),
        ],
    };
    assert_eq!(compute_offsets(&tl), vec![9_000, 18_000]);
}

#[test]
fn offsets_varying_durations() {
    let tl = XfadeTimeline {
        clip_durations_ms: vec![5_000, 8_000, 12_000],
        transitions: vec![
            (0, XfadeKind::Fade, 500),
            (1, XfadeKind::WipeLeft, 300),
        ],
    };
    assert_eq!(compute_offsets(&tl), vec![4_500, 12_200]);
}

#[test]
fn default_is_none() {
    let tl = XfadeTimeline {
        clip_durations_ms: vec![5_000, 5_000, 5_000],
        transitions: vec![],
    };
    assert!(compute_offsets(&tl).is_empty());
}

#[test]
fn opencl_probe_detects_filter() {
    let stdout = "Filters:\n V->V xfade Cross fade.\n V->V xfade_opencl Cross fade (OpenCL).\n";
    let r = probe_from_stdout(stdout);
    assert!(r.xfade_opencl);
}

#[test]
fn opencl_probe_absent() {
    let stdout = "Filters:\n V->V xfade Cross fade.\n";
    let r = probe_from_stdout(stdout);
    assert!(!r.xfade_opencl);
}

#[test]
fn emit_xfade_cpu_shape() {
    let s = emit_xfade(XfadeKind::Fade, 1000, 9000, "[a]", "[b]", "[o]", false);
    assert_eq!(
        s,
        "[a][b]xfade=transition=fade:duration=1.000:offset=9.000[o]"
    );
}

#[test]
fn emit_xfade_opencl_for_supported_kind() {
    assert!(kind_supports_opencl(XfadeKind::Dissolve));
    let s = emit_xfade(XfadeKind::Dissolve, 500, 4500, "[a]", "[b]", "[o]", true);
    assert!(s.starts_with("[a][b]xfade_opencl=transition=dissolve"));
}

#[test]
fn emit_xfade_opencl_falls_back_for_unsupported() {
    assert!(!kind_supports_opencl(XfadeKind::CircleOpen));
    let s = emit_xfade(XfadeKind::CircleOpen, 500, 4500, "[a]", "[b]", "[o]", true);
    assert!(s.starts_with("[a][b]xfade=transition=circleopen"));
    assert!(!s.contains("xfade_opencl"));
}

#[test]
fn transitions_chained_filter_complex_snapshot() {
    // 3-clip timeline with Fade + Dissolve, offsets from compute_offsets.
    let tl = XfadeTimeline {
        clip_durations_ms: vec![10_000, 10_000, 10_000],
        transitions: vec![
            (0, XfadeKind::Fade, 1000),
            (1, XfadeKind::Dissolve, 1000),
        ],
    };
    let offsets = compute_offsets(&tl);
    let mut out = String::new();
    // First xfade: [v0][v1] -> [v01]
    out.push_str(&emit_xfade(
        tl.transitions[0].1,
        tl.transitions[0].2,
        offsets[0],
        "[v0]",
        "[v1]",
        "[v01]",
        false,
    ));
    out.push(';');
    // Second xfade: [v01][v2] -> [out]
    out.push_str(&emit_xfade(
        tl.transitions[1].1,
        tl.transitions[1].2,
        offsets[1],
        "[v01]",
        "[v2]",
        "[out]",
        false,
    ));
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("transitions_chained.filter_complex", out);
    });
}
