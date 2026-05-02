//! Integration tests for ripple factory + skin loader + PNG sequence renderer.

use std::path::Path;

use effects::ast::types::{EasingKind, Rgba, Vec2};
use effects::ast::video::{CursorMotionPreset, CursorSkin, ZoomKeyframe};
use effects::cursor::{
    apply_tint, build_ripples, load_skin, render_cursor_pngs, render_cursor_pngs_from_actions,
    render_cursor_pngs_from_actions_with_options, render_png_sequence, ripple_alpha, ripple_radius,
    sample_trajectory, CursorActionRenderOptions, CursorSample, RippleOptions, TrajectoryOptions,
};
use effects::math::min_jerk::{Waypoint, WaypointKind};
use image::{ImageBuffer, Rgba as ImageRgba, RgbaImage};

fn wp(t_ms: u64, x: f32, y: f32, kind: WaypointKind) -> Waypoint {
    Waypoint {
        t_ms,
        pos: Vec2::new(x, y),
        kind,
    }
}

#[test]
fn build_ripples_defaults() {
    let wps = [
        wp(1000, 100.0, 100.0, WaypointKind::Click),
        wp(2000, 200.0, 200.0, WaypointKind::Click),
        wp(3000, 300.0, 300.0, WaypointKind::Click),
    ];
    let out = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(out.len(), 3);
    for (r, expected_t) in out.iter().zip([1000u64, 2000, 3000]) {
        assert_eq!(r.t_impact_ms, expected_t);
        assert_eq!(r.t_anticipate_ms, expected_t - 60);
        assert_eq!(r.duration_ms, 300);
        assert!((r.max_radius_px - 60.0).abs() < 1e-5);
        assert_eq!(
            r.color,
            Rgba {
                r: 255,
                g: 255,
                b: 255,
                a: 229
            }
        );
    }
}

#[test]
fn build_ripples_skips_non_clicks() {
    let wps = [
        wp(100, 0.0, 0.0, WaypointKind::Click),
        wp(200, 0.0, 0.0, WaypointKind::Hover),
        wp(300, 0.0, 0.0, WaypointKind::Hover),
        wp(400, 0.0, 0.0, WaypointKind::Hover),
        wp(500, 0.0, 0.0, WaypointKind::Scroll),
        wp(600, 0.0, 0.0, WaypointKind::Click),
    ];
    let out = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(out.len(), 2);
}

#[test]
fn load_skin_all_five() {
    for kind in [
        CursorSkin::MacDefault,
        CursorSkin::WinDefault,
        CursorSkin::Dark,
        CursorSkin::Light,
        CursorSkin::BigArrow,
    ] {
        let skin = load_skin(kind).unwrap_or_else(|e| panic!("load_skin({:?}) failed: {e}", kind));
        assert!(skin.width > 0);
        assert!(skin.height > 0);
    }
}

#[test]
fn apply_tint_preserves_alpha() {
    let skin = load_skin(CursorSkin::MacDefault).expect("mac-default must load");
    let tinted = apply_tint(
        &skin,
        Rgba {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        },
    );
    assert_eq!(tinted.width, skin.width);
    assert_eq!(tinted.height, skin.height);
    for (src, dst) in skin.pixels.pixels().zip(tinted.pixels.pixels()) {
        assert_eq!(src.0[3], dst.0[3], "alpha must be preserved");
    }
}

#[test]
fn render_png_sequence_creates_n_frames() {
    // 1 second trajectory at 60fps + 2 ripples → expect 60 PNGs.
    let wps = [
        wp(0, 50.0, 50.0, WaypointKind::Click),
        wp(500, 150.0, 100.0, WaypointKind::Hover),
        wp(1000, 250.0, 150.0, WaypointKind::Click),
    ];
    let traj = sample_trajectory(&wps, TrajectoryOptions::default());
    let ripples = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(ripples.len(), 2);
    assert!(
        traj.len() >= 60,
        "trajectory should be ≥60 samples, got {}",
        traj.len()
    );

    let skin = load_skin(CursorSkin::MacDefault).expect("skin");
    let tmp = tempfile::tempdir().expect("tmp");
    let result =
        render_png_sequence(&traj, &ripples, &skin, tmp.path(), 320, 240, 60).expect("render");

    assert_eq!(result.frame_count as usize, traj.len());
    assert_eq!(result.fps, 60);
    // First and last PNGs exist with expected names.
    assert!(tmp.path().join("frame_00000.png").exists());
    let last = format!("frame_{:05}.png", traj.len() - 1);
    assert!(
        tmp.path().join(&last).exists(),
        "{last} should exist in {}",
        tmp.path().display()
    );
    // File count check: one PNG per sample.
    let png_count = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .map(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                .unwrap_or(false)
        })
        .count();
    assert_eq!(png_count, traj.len());
}

#[test]
fn render_cursor_pngs_from_trajectory_json_creates_frames() {
    let tmp = tempfile::tempdir().unwrap();
    let trajectory = tmp.path().join("sample.trajectory.json");
    let skin = tmp.path().join("skin.png");
    let out = tmp.path().join("cursor-out");

    let skin_img: RgbaImage = ImageBuffer::from_pixel(4, 4, ImageRgba([255, 0, 0, 255]));
    skin_img.save(&skin).unwrap();
    std::fs::write(
        &trajectory,
        r#"{
          "recording_path": "/tmp/sample.mp4",
          "capture_rect": { "x": 10.0, "y": 20.0, "width": 40.0, "height": 30.0 },
          "fps": 60,
          "frame_count": 3,
          "frames": [
            { "t_ms": 0, "x": 12.0, "y": 23.0, "click": false },
            { "t_ms": 16, "x": 13.0, "y": 24.0, "click": true },
            { "t_ms": 32, "x": 14.0, "y": 25.0, "click": false }
          ]
        }"#,
    )
    .unwrap();

    let result = render_cursor_pngs(&trajectory, &skin, &out).unwrap();
    assert_eq!(result.png_dir, out);
    assert_eq!(result.fps, 60);
    assert_eq!(result.frame_count, 3);
    assert_eq!(result.canvas_width, 40);
    assert_eq!(result.canvas_height, 30);
    assert!(tmp.path().join("cursor-out/frame_00000.png").exists());
    assert!(tmp.path().join("cursor-out/frame_00002.png").exists());

    let first = image::open(tmp.path().join("cursor-out/frame_00000.png"))
        .unwrap()
        .to_rgba8();
    assert_eq!(first.width(), 40);
    assert_eq!(first.height(), 30);
    assert_eq!(first.get_pixel(2, 3).0, [255, 0, 0, 255]);
}

#[test]
fn render_cursor_pngs_from_actions_json_starts_center_and_draws_ripple() {
    let tmp = tempfile::tempdir().unwrap();
    let actions = tmp.path().join("sample.actions.json");
    let skin = tmp.path().join("skin.png");
    let out = tmp.path().join("cursor-out");

    let skin_img: RgbaImage = ImageBuffer::from_pixel(4, 4, ImageRgba([255, 0, 0, 255]));
    skin_img.save(&skin).unwrap();
    std::fs::write(
        &actions,
        r#"{
          "version": 1,
          "recording_path": "/tmp/sample.mp4",
          "viewport": { "width": 40, "height": 30 },
          "capture_rect": { "x": 0.0, "y": 0.0, "width": 40.0, "height": 30.0 },
          "fps": 10,
          "frame_count": 8,
          "events": [
            {
              "step_id": "step-1",
              "ordinal": 1,
              "verb": "click",
              "t_start_ms": 300,
              "t_action_ms": 500,
              "t_end_ms": 600,
              "target": {
                "kind": "element",
                "label": "Save",
                "center": { "x": 30.0, "y": 20.0 },
                "bounds": { "x": 25.0, "y": 18.0, "w": 10.0, "h": 4.0 }
              },
              "pointer": { "button": "left", "effect": "click" }
            }
          ]
        }"#,
    )
    .unwrap();

    let result = render_cursor_pngs_from_actions(&actions, &skin, &out).unwrap();
    assert_eq!(result.fps, 10);
    assert_eq!(result.frame_count, 8);
    assert_eq!(result.canvas_width, 40);
    assert_eq!(result.canvas_height, 30);
    assert!(out.join("frame_00000.png").exists());
    assert!(out.join("frame_00007.png").exists());

    let first = image::open(out.join("frame_00000.png")).unwrap().to_rgba8();
    assert_eq!(first.get_pixel(20, 15).0, [255, 0, 0, 255]);

    let impact = image::open(out.join("frame_00005.png")).unwrap().to_rgba8();
    assert!(
        impact.pixels().any(|pixel| pixel.0[3] > 0),
        "impact frame should contain cursor or ripple pixels"
    );
}

#[test]
fn render_cursor_pngs_from_actions_applies_zoom_to_output_space() {
    let tmp = tempfile::tempdir().unwrap();
    let actions = tmp.path().join("sample.actions.json");
    let skin = tmp.path().join("skin.png");
    let out = tmp.path().join("cursor-out");

    let skin_img: RgbaImage = ImageBuffer::from_pixel(4, 4, ImageRgba([255, 0, 0, 255]));
    skin_img.save(&skin).unwrap();
    std::fs::write(
        &actions,
        r#"{
          "version": 1,
          "recording_path": "/tmp/sample.mp4",
          "viewport": { "width": 40, "height": 30 },
          "capture_rect": { "x": 0.0, "y": 0.0, "width": 40.0, "height": 30.0 },
          "fps": 10,
          "frame_count": 8,
          "events": [
            {
              "step_id": "step-1",
              "ordinal": 1,
              "verb": "click",
              "t_start_ms": 300,
              "t_action_ms": 500,
              "t_end_ms": 600,
              "target": {
                "kind": "element",
                "label": "Save",
                "center": { "x": 30.0, "y": 20.0 },
                "bounds": { "x": 25.0, "y": 18.0, "w": 10.0, "h": 4.0 }
              },
              "pointer": { "button": "left", "effect": "click" }
            }
          ]
        }"#,
    )
    .unwrap();

    let zoom_keyframes = [ZoomKeyframe {
        t_ms: 0,
        center: Vec2::new(60.0, 40.0),
        scale: 2.0,
        easing: EasingKind::Linear,
    }];
    let result = render_cursor_pngs_from_actions_with_options(
        &actions,
        &skin,
        &out,
        CursorActionRenderOptions {
            min_frame_count: 8,
            motion_preset: CursorMotionPreset::Natural,
            output_size: Some((80, 60)),
            zoom_keyframes: &zoom_keyframes,
        },
    )
    .unwrap();

    assert_eq!(result.canvas_width, 80);
    assert_eq!(result.canvas_height, 60);
    let impact = image::open(out.join("frame_00005.png")).unwrap().to_rgba8();
    assert_eq!(impact.get_pixel(40, 30).0, [255, 0, 0, 255]);
}

#[test]
fn render_cursor_pngs_rejects_malformed_json() {
    let tmp = tempfile::tempdir().unwrap();
    let trajectory = tmp.path().join("bad.trajectory.json");
    let skin = tmp.path().join("skin.png");
    let out = tmp.path().join("cursor-out");
    ImageBuffer::<ImageRgba<u8>, Vec<u8>>::from_pixel(1, 1, ImageRgba([255, 255, 255, 255]))
        .save(&skin)
        .unwrap();
    std::fs::write(&trajectory, b"{not-json").unwrap();

    let err = render_cursor_pngs(&trajectory, &skin, &out).unwrap_err();
    assert!(
        matches!(err, effects::EffectsError::Serde(_)),
        "unexpected error: {err}"
    );
}

#[test]
fn render_cursor_pngs_rejects_missing_skin_file() {
    let tmp = tempfile::tempdir().unwrap();
    let trajectory = tmp.path().join("sample.trajectory.json");
    std::fs::write(
        &trajectory,
        r#"{
          "recording_path": "/tmp/sample.mp4",
          "capture_rect": { "x": 0.0, "y": 0.0, "width": 4.0, "height": 4.0 },
          "fps": 60,
          "frame_count": 1,
          "frames": [{ "t_ms": 0, "x": 1.0, "y": 1.0, "click": false }]
        }"#,
    )
    .unwrap();

    let err = render_cursor_pngs(
        &trajectory,
        &tmp.path().join("missing.png"),
        &tmp.path().join("cursor-out"),
    )
    .unwrap_err();
    assert!(
        matches!(
            err,
            effects::EffectsError::Io(_) | effects::EffectsError::ImageDecode(_)
        ),
        "unexpected error: {err}"
    );
}

#[test]
fn ripple_alpha_decay() {
    // At t = impact + 0.5 * duration, alpha ≈ 0.25 × base.
    let wps = [wp(1000, 100.0, 100.0, WaypointKind::Click)];
    let ripples = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(ripples.len(), 1);
    let ev = ripples[0];
    let base = ev.color.a as f32 / 255.0;
    let half_t = ev.t_impact_ms + (ev.duration_ms as u64 / 2);
    let a = ripple_alpha(&ev, half_t);
    let expected = 0.25 * base;
    assert!((a - expected).abs() < 1e-3, "expected {expected}, got {a}");
    // Radius at half duration ≈ 0.5 * max_radius.
    let r = ripple_radius(&ev, half_t);
    assert!(
        (r - ev.max_radius_px * 0.5).abs() < 1e-3,
        "expected {}, got {r}",
        ev.max_radius_px * 0.5
    );
}

#[test]
fn png_sequence_is_deterministic() {
    // Same seed + same inputs → byte-identical PNG frames across two
    // independent renders (success criterion: PNG sequence output
    // deterministic).
    let wps = [
        wp(0, 40.0, 40.0, WaypointKind::Click),
        wp(500, 180.0, 120.0, WaypointKind::Hover),
    ];
    let traj = sample_trajectory(
        &wps,
        TrajectoryOptions {
            jitter_seed: 777,
            ..Default::default()
        },
    );
    let ripples = build_ripples(&wps, &RippleOptions::default());
    let skin = load_skin(CursorSkin::MacDefault).expect("skin");

    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    render_png_sequence(&traj, &ripples, &skin, a.path(), 256, 200, 60).unwrap();
    render_png_sequence(&traj, &ripples, &skin, b.path(), 256, 200, 60).unwrap();

    // Compare every frame byte-for-byte.
    for i in 0..traj.len() {
        let name = format!("frame_{:05}.png", i);
        let ba = std::fs::read(a.path().join(&name)).unwrap();
        let bb = std::fs::read(b.path().join(&name)).unwrap();
        assert_eq!(ba, bb, "frame {i} differs between runs");
    }
}

// Silence an unused-import warning when tests above don't reference
// `CursorSample` / `Path` directly in all compilation paths.
#[allow(dead_code)]
fn _unused(_: CursorSample, _: &Path) {}
