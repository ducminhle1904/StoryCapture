//! Integration tests for `GraphBuilder` — canonical order + duplicate-id
//! validation.

use std::path::PathBuf;

use effects::ast::audio::SidechainParams;
use effects::ast::types::NodeId;
use effects::ast::video::{
    BackgroundKind, CursorSkin, RippleEvent, TrajectoryRef, XfadeKind, ZoomKeyframe, ZoomTarget,
};
use effects::ast::{Rgba, Vec2};
use effects::builder::order::{validate_order, CanonicalStage};
use effects::{BuilderError, GraphBuilder};

fn fresh_traj() -> TrajectoryRef {
    TrajectoryRef {
        png_sequence_dir: PathBuf::from("/tmp/cursor"),
        fps: 60,
        frame_count: 1,
    }
}

#[test]
fn full_pipeline_in_canonical_order_builds_ok() {
    let g = GraphBuilder::new(1920, 1080, 60)
        .source(NodeId::new(), "in.mp4", 0)
        .zoom_pan(
            NodeId::new(),
            ZoomTarget::Cursor,
            vec![ZoomKeyframe {
                t_ms: 0,
                center: Vec2::new(960.0, 540.0),
                scale: 1.0,
                easing: effects::ast::EasingKind::Linear,
            }],
        )
        .background(
            NodeId::new(),
            BackgroundKind::Solid { color: Rgba::BLACK },
            0.0,
            None,
        )
        .cursor(
            NodeId::new(),
            CursorSkin::MacDefault,
            1.0,
            None,
            fresh_traj(),
        )
        .ripple(
            NodeId::new(),
            vec![RippleEvent::at_impact(500, Vec2::new(100.0, 100.0))],
        )
        .text(NodeId::new(), vec![])
        .transition(NodeId::new(), XfadeKind::Fade, 500, 1500)
        .audio_mix(NodeId::new(), vec!["a".into(), "b".into()], false)
        .build()
        .expect("canonical order should build ok");

    assert_eq!(g.video.len(), 7, "expected 7 video stages");
    assert_eq!(g.audio.len(), 1, "expected 1 audio stage");
}

#[test]
fn background_before_source_rejects_with_canonical_order_violation() {
    let err = GraphBuilder::new(1920, 1080, 60)
        .background(
            NodeId::new(),
            BackgroundKind::Solid { color: Rgba::BLACK },
            0.0,
            None,
        )
        .source(NodeId::new(), "in.mp4", 0)
        .build()
        .expect_err("should fail canonical order");
    match err {
        BuilderError::CanonicalOrderViolation(found, prev) => {
            assert_eq!(found, CanonicalStage::Source);
            assert_eq!(prev, CanonicalStage::Background);
        }
        other => panic!("expected CanonicalOrderViolation, got {other:?}"),
    }
}

#[test]
fn cursor_before_background_rejects() {
    let err = GraphBuilder::new(1920, 1080, 60)
        .source(NodeId::new(), "in.mp4", 0)
        .cursor(
            NodeId::new(),
            CursorSkin::MacDefault,
            1.0,
            None,
            fresh_traj(),
        )
        .background(
            NodeId::new(),
            BackgroundKind::Solid { color: Rgba::BLACK },
            0.0,
            None,
        )
        .build()
        .expect_err("cursor then background violates D-19");
    match err {
        BuilderError::CanonicalOrderViolation(found, prev) => {
            assert_eq!(found, CanonicalStage::Background);
            assert_eq!(prev, CanonicalStage::Cursor);
        }
        other => panic!("expected CanonicalOrderViolation, got {other:?}"),
    }
}

#[test]
fn skipping_optional_stages_is_allowed() {
    // Source -> Cursor directly (skipping Zoom + Background): gaps allowed.
    let g = GraphBuilder::new(1920, 1080, 60)
        .source(NodeId::new(), "in.mp4", 0)
        .cursor(NodeId::new(), CursorSkin::Light, 1.0, None, fresh_traj())
        .build()
        .expect("gaps must be allowed");
    assert_eq!(g.video.len(), 2);
}

#[test]
fn duplicate_node_id_rejects() {
    let shared = NodeId::new();
    let err = GraphBuilder::new(1920, 1080, 60)
        .source(shared, "in.mp4", 0)
        .background(
            shared,
            BackgroundKind::Solid { color: Rgba::WHITE },
            0.0,
            None,
        )
        .build()
        .expect_err("duplicate id must fail");
    assert!(
        matches!(err, BuilderError::DuplicateNodeId),
        "expected DuplicateNodeId, got {err:?}"
    );
}

#[test]
fn validate_order_direct_api_accepts_empty() {
    // Exercising the pub API directly (acceptance-criterion grep).
    assert!(validate_order(&[]).is_ok());
}

#[test]
fn sidechain_defaults_match_research_values() {
    let p = SidechainParams::default();
    assert!((p.threshold - 0.08).abs() < 1e-6);
    assert!((p.ratio - 8.0).abs() < 1e-6);
    assert_eq!(p.attack_ms, 80);
    assert_eq!(p.release_ms, 400);
}
