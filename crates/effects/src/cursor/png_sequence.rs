//! Render trajectory + ripples to a PNG sequence on disk consumed by FFmpeg's
//! `overlay` filter (via `image2` input with `-framerate <fps> -i frame_%05d.png`).
//!
//! DoS note: 30 min × 60 fps = 108,000 frames. Caller must clean up the
//! output directory after encode and should cap trajectory length before
//! invoking this function.

use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::Deserialize;
use tracing::warn;

use crate::ast::types::Vec2;
use crate::ast::video::{CursorMotionPreset, RippleEvent};
use crate::error::EffectsError;
use crate::math::vec2::Vec2Ops;
use crate::math::{Waypoint, WaypointKind};
use crate::zoom::waypoint_source::parse_waypoint_kind;

use super::compositor::compose_frame;
use super::ripple::{ripple_alpha, ripple_radius};
use super::skins::{load_skin_from_path, SkinBitmap};
use super::trajectory::{sample_trajectory, CursorSample, TrajectoryOptions};

const MAX_CURSOR_PNG_FRAMES: usize = 108_000;
#[derive(Debug, Clone, Copy)]
struct CursorMotionProfile {
    min_travel_ms: u64,
    max_travel_ms: u64,
    travel_px_per_ms: f32,
}

impl CursorMotionPreset {
    fn profile(self) -> CursorMotionProfile {
        match self {
            Self::Natural => CursorMotionProfile {
                min_travel_ms: 320,
                max_travel_ms: 980,
                travel_px_per_ms: 2.4,
            },
            Self::Snappy => CursorMotionProfile {
                min_travel_ms: 220,
                max_travel_ms: 720,
                travel_px_per_ms: 3.2,
            },
            Self::Cinematic => CursorMotionProfile {
                min_travel_ms: 420,
                max_travel_ms: 1250,
                travel_px_per_ms: 1.8,
            },
        }
    }

    fn trajectory_options(self, fps: u32) -> TrajectoryOptions {
        match self {
            Self::Natural => TrajectoryOptions {
                fps,
                jitter_amplitude_px: 0.5,
                ..TrajectoryOptions::default()
            },
            Self::Snappy => TrajectoryOptions {
                fps,
                jitter_amplitude_px: 0.35,
                reversal_pause_ms: 60,
                peak_velocity_cap_px_per_s: 3200.0,
                post_click_dwell_ms: 140,
                ..TrajectoryOptions::default()
            },
            Self::Cinematic => TrajectoryOptions {
                fps,
                jitter_amplitude_px: 0.25,
                reversal_pause_ms: 140,
                post_click_dwell_ms: 260,
                peak_velocity_cap_px_per_s: 1900.0,
                ..TrajectoryOptions::default()
            },
        }
    }
}

/// Result metadata from a successful render.
#[derive(Debug, Clone)]
pub struct PngSequenceResult {
    pub dir: PathBuf,
    pub frame_count: u32,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
}

/// Result metadata from rendering a `.trajectory.json` sidecar into a cursor
/// PNG sequence.
#[derive(Debug, Clone)]
pub struct RenderedCursorPng {
    pub png_dir: PathBuf,
    pub fps: u32,
    pub frame_count: u32,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

#[derive(Debug, Deserialize)]
struct TrajectoryDto {
    capture_rect: CaptureRectDto,
    fps: u32,
    frame_count: u32,
    frames: Vec<TrajectoryFrameDto>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct CaptureRectDto {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct TrajectoryFrameDto {
    t_ms: u32,
    x: f32,
    y: f32,
    click: bool,
}

#[derive(Debug, Deserialize)]
struct ActionTimelineDto {
    viewport: ActionViewportDto,
    capture_rect: CaptureRectDto,
    fps: u32,
    frame_count: u32,
    events: Vec<ActionEventDto>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct ActionViewportDto {
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
struct ActionEventDto {
    verb: String,
    t_start_ms: u64,
    t_action_ms: u64,
    t_end_ms: u64,
    target: Option<ActionTargetDto>,
    pointer: Option<ActionPointerDto>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct ActionTargetDto {
    center: ActionPointDto,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct ActionPointDto {
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
struct ActionPointerDto {
    effect: String,
}

/// Render a Phase 19 `.trajectory.json` sidecar into a PNG sequence directory
/// that the FFmpeg emitter can consume through the existing cursor-overlay
/// AST field.
pub fn render_cursor_pngs(
    trajectory_json: &Path,
    skin_png: &Path,
    output_dir: &Path,
) -> Result<RenderedCursorPng, EffectsError> {
    let bytes = std::fs::read(trajectory_json)?;
    let dto: TrajectoryDto = serde_json::from_slice(&bytes)?;
    let skin = load_skin_from_path(skin_png)?;
    render_cursor_pngs_from_dto(&dto, &skin, output_dir)
}

/// Render a semantic `<recording>.actions.json` sidecar into a cursor PNG
/// sequence. This is the synthetic cursor path used for polished exports.
pub fn render_cursor_pngs_from_actions(
    actions_json: &Path,
    skin_png: &Path,
    output_dir: &Path,
) -> Result<RenderedCursorPng, EffectsError> {
    render_cursor_pngs_from_actions_with_motion(
        actions_json,
        skin_png,
        output_dir,
        0,
        CursorMotionPreset::Natural,
    )
}

/// Render a semantic action sidecar, extending the held final cursor sample
/// when the caller's clip duration is longer than the sidecar's own event span.
pub fn render_cursor_pngs_from_actions_with_min_frame_count(
    actions_json: &Path,
    skin_png: &Path,
    output_dir: &Path,
    min_frame_count: u32,
) -> Result<RenderedCursorPng, EffectsError> {
    render_cursor_pngs_from_actions_with_motion(
        actions_json,
        skin_png,
        output_dir,
        min_frame_count,
        CursorMotionPreset::Natural,
    )
}

/// Render a semantic action sidecar using an explicit cursor motion preset.
pub fn render_cursor_pngs_from_actions_with_motion(
    actions_json: &Path,
    skin_png: &Path,
    output_dir: &Path,
    min_frame_count: u32,
    motion_preset: CursorMotionPreset,
) -> Result<RenderedCursorPng, EffectsError> {
    let bytes = std::fs::read(actions_json)?;
    let mut dto: ActionTimelineDto = serde_json::from_slice(&bytes)?;
    dto.frame_count = dto.frame_count.max(min_frame_count);
    let skin = load_skin_from_path(skin_png)?;
    render_cursor_pngs_from_actions_dto(&dto, &skin, output_dir, motion_preset)
}

fn render_cursor_pngs_from_dto(
    dto: &TrajectoryDto,
    skin: &SkinBitmap,
    output_dir: &Path,
) -> Result<RenderedCursorPng, EffectsError> {
    std::fs::create_dir_all(output_dir)?;
    let canvas_width = dto.capture_rect.width.round().max(1.0) as u32;
    let canvas_height = dto.capture_rect.height.round().max(1.0) as u32;
    let fps = dto.fps.max(1);
    if dto.frames.len() > MAX_CURSOR_PNG_FRAMES {
        return Err(EffectsError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "trajectory has {} frames, max supported is {}",
                dto.frames.len(),
                MAX_CURSOR_PNG_FRAMES
            ),
        )));
    }

    if dto.frame_count != dto.frames.len() as u32 {
        warn!(
            declared = dto.frame_count,
            actual = dto.frames.len(),
            "trajectory sidecar frame_count mismatch"
        );
    }

    let trajectory: Vec<CursorSample> = dto
        .frames
        .iter()
        .map(|frame| frame_to_sample(frame, dto.capture_rect, skin, canvas_width, canvas_height))
        .collect();
    let ripples: Vec<RippleEvent> = dto
        .frames
        .iter()
        .filter(|frame| frame.click)
        .filter_map(|frame| {
            let sample =
                frame_to_sample(frame, dto.capture_rect, skin, canvas_width, canvas_height);
            if sample.pos.x < 0.0 || sample.pos.y < 0.0 {
                None
            } else {
                Some(RippleEvent::at_impact(frame.t_ms as u64, sample.pos))
            }
        })
        .collect();
    let rendered = render_png_sequence(
        &trajectory,
        &ripples,
        skin,
        output_dir,
        canvas_width,
        canvas_height,
        fps,
    )?;

    Ok(RenderedCursorPng {
        png_dir: output_dir.to_path_buf(),
        fps: rendered.fps,
        frame_count: rendered.frame_count,
        canvas_width: rendered.width,
        canvas_height: rendered.height,
    })
}

fn render_cursor_pngs_from_actions_dto(
    dto: &ActionTimelineDto,
    skin: &SkinBitmap,
    output_dir: &Path,
    motion_preset: CursorMotionPreset,
) -> Result<RenderedCursorPng, EffectsError> {
    std::fs::create_dir_all(output_dir)?;
    let canvas_width = dto
        .capture_rect
        .width
        .round()
        .max(dto.viewport.width as f32)
        .max(1.0) as u32;
    let canvas_height = dto
        .capture_rect
        .height
        .round()
        .max(dto.viewport.height as f32)
        .max(1.0) as u32;
    let fps = dto.fps.max(1);
    let frame_count = dto.frame_count.max(1);
    let profile = motion_preset.profile();
    if frame_count as usize > MAX_CURSOR_PNG_FRAMES {
        return Err(EffectsError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "actions timeline needs {} frames, max supported is {}",
                frame_count, MAX_CURSOR_PNG_FRAMES
            ),
        )));
    }

    let mut waypoints = vec![Waypoint {
        t_ms: 0,
        pos: Vec2::new(canvas_width as f32 / 2.0, canvas_height as f32 / 2.0),
        kind: WaypointKind::Hover,
    }];
    let mut ripples = Vec::new();

    for event in &dto.events {
        let previous = *waypoints.last().expect("actions cursor path is seeded");
        let pos = event
            .target
            .map(|target| clamp_point(target.center, canvas_width, canvas_height))
            .unwrap_or(previous.pos);
        let kind = waypoint_kind(event);
        let start_ms = action_movement_start_ms(previous.t_ms, event, previous.pos, pos, profile);
        let action_ms = event.t_action_ms.max(start_ms);
        push_waypoint(&mut waypoints, start_ms, previous.pos, WaypointKind::Hover);
        push_waypoint(&mut waypoints, action_ms, pos, kind);
        push_waypoint(&mut waypoints, event.t_end_ms, pos, WaypointKind::Hover);
        if is_click_event(event) {
            ripples.push(RippleEvent::at_impact(event.t_action_ms, pos));
        }
    }

    let mut trajectory = sample_trajectory(&waypoints, motion_preset.trajectory_options(fps));
    normalize_sample_count(
        &mut trajectory,
        frame_count,
        fps,
        *waypoints.last().unwrap(),
    );

    let rendered = render_png_sequence(
        &trajectory,
        &ripples,
        skin,
        output_dir,
        canvas_width,
        canvas_height,
        fps,
    )?;

    Ok(RenderedCursorPng {
        png_dir: output_dir.to_path_buf(),
        fps: rendered.fps,
        frame_count: rendered.frame_count,
        canvas_width: rendered.width,
        canvas_height: rendered.height,
    })
}

fn push_waypoint(waypoints: &mut Vec<Waypoint>, t_ms: u64, pos: Vec2, kind: WaypointKind) {
    match waypoints.last().copied() {
        Some(last) if t_ms < last.t_ms => {}
        Some(last) if t_ms == last.t_ms => {
            if let Some(slot) = waypoints.last_mut() {
                *slot = Waypoint { t_ms, pos, kind };
            }
        }
        _ => waypoints.push(Waypoint { t_ms, pos, kind }),
    }
}

fn action_travel_duration_ms(from: Vec2, to: Vec2, profile: CursorMotionProfile) -> u64 {
    let distance_px = to.sub(from).length();
    (distance_px / profile.travel_px_per_ms)
        .round()
        .clamp(profile.min_travel_ms as f32, profile.max_travel_ms as f32) as u64
}

fn action_movement_start_ms(
    previous_t: u64,
    event: &ActionEventDto,
    from: Vec2,
    to: Vec2,
    profile: CursorMotionProfile,
) -> u64 {
    let declared_window = event.t_action_ms.saturating_sub(event.t_start_ms);
    if declared_window >= profile.min_travel_ms / 2 {
        return previous_t.max(event.t_start_ms).min(event.t_action_ms);
    }
    if event.t_action_ms == 0 {
        return 0;
    }
    previous_t
        .max(
            event
                .t_action_ms
                .saturating_sub(action_travel_duration_ms(from, to, profile)),
        )
        .min(event.t_action_ms)
}

fn clamp_point(point: ActionPointDto, canvas_width: u32, canvas_height: u32) -> Vec2 {
    let x = if point.x.is_finite() {
        point.x as f32
    } else {
        canvas_width as f32 / 2.0
    };
    let y = if point.y.is_finite() {
        point.y as f32
    } else {
        canvas_height as f32 / 2.0
    };
    Vec2::new(
        x.clamp(0.0, canvas_width as f32),
        y.clamp(0.0, canvas_height as f32),
    )
}

fn waypoint_kind(event: &ActionEventDto) -> WaypointKind {
    if is_click_event(event) {
        WaypointKind::Click
    } else {
        parse_waypoint_kind(event.verb.as_str()).unwrap_or(match event.verb.as_str() {
            "select" | "upload" => WaypointKind::Type,
            _ => WaypointKind::Hover,
        })
    }
}

fn is_click_event(event: &ActionEventDto) -> bool {
    event
        .pointer
        .as_ref()
        .is_some_and(|pointer| pointer.effect == "click")
        || event.verb == "click"
}

fn normalize_sample_count(
    trajectory: &mut Vec<CursorSample>,
    frame_count: u32,
    fps: u32,
    fallback: Waypoint,
) {
    let target_len = frame_count as usize;
    if trajectory.is_empty() {
        trajectory.push(CursorSample {
            t_ms: 0,
            pos: fallback.pos,
        });
    }
    if trajectory.len() > target_len {
        trajectory.truncate(target_len);
        return;
    }
    let frame_ms = (1000.0 / fps as f32).round() as u64;
    while trajectory.len() < target_len {
        let pos = trajectory
            .last()
            .map(|sample| sample.pos)
            .unwrap_or(fallback.pos);
        let t_ms = trajectory.len() as u64 * frame_ms;
        trajectory.push(CursorSample { t_ms, pos });
    }
}

fn frame_to_sample(
    frame: &TrajectoryFrameDto,
    capture_rect: CaptureRectDto,
    skin: &SkinBitmap,
    canvas_width: u32,
    canvas_height: u32,
) -> CursorSample {
    let _click = frame.click;
    let local_x = frame.x - capture_rect.x;
    let local_y = frame.y - capture_rect.y;
    if !local_x.is_finite()
        || !local_y.is_finite()
        || local_x < 0.0
        || local_y < 0.0
        || local_x > canvas_width as f32
        || local_y > canvas_height as f32
    {
        return CursorSample {
            t_ms: frame.t_ms as u64,
            pos: Vec2::new(
                -(skin.pixels.width() as f32) - 1.0,
                -(skin.pixels.height() as f32) - 1.0,
            ),
        };
    }

    CursorSample {
        t_ms: frame.t_ms as u64,
        pos: Vec2::new(local_x, local_y),
    }
}

/// Render `trajectory` + `ripples` into `out_dir` as `frame_00000.png`,
/// `frame_00001.png`, … (zero-padded to 5 digits).
///
/// Frames are rendered in parallel via rayon. The caller must clean up the
/// output directory when the render job completes (T-02-16).
pub fn render_png_sequence(
    trajectory: &[CursorSample],
    ripples: &[RippleEvent],
    skin: &SkinBitmap,
    out_dir: &Path,
    canvas_w: u32,
    canvas_h: u32,
    fps: u32,
) -> Result<PngSequenceResult, EffectsError> {
    std::fs::create_dir_all(out_dir)?;
    let frame_count = trajectory.len() as u32;

    trajectory
        .par_iter()
        .enumerate()
        .try_for_each(|(i, sample)| -> Result<(), EffectsError> {
            let t_ms = sample.t_ms;
            let ripple_state: Vec<(RippleEvent, f32, f32)> = ripples
                .iter()
                .filter_map(|r| {
                    let a = ripple_alpha(r, t_ms);
                    if a <= 0.0 {
                        return None;
                    }
                    Some((*r, a, ripple_radius(r, t_ms)))
                })
                .collect();
            let img = compose_frame(canvas_w, canvas_h, sample, skin, &ripple_state);
            let path = out_dir.join(format!("frame_{:05}.png", i));
            img.save(&path)
                .map_err(|e| EffectsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })?;

    Ok(PngSequenceResult {
        dir: out_dir.to_path_buf(),
        frame_count,
        fps,
        width: canvas_w,
        height: canvas_h,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action_event(start: u64, action: u64, end: u64) -> ActionEventDto {
        ActionEventDto {
            verb: "click".to_string(),
            t_start_ms: start,
            t_action_ms: action,
            t_end_ms: end,
            target: None,
            pointer: None,
        }
    }

    fn natural_profile() -> CursorMotionProfile {
        CursorMotionPreset::Natural.profile()
    }

    #[test]
    fn action_movement_start_synthesizes_zero_window_travel() {
        let event = action_event(2_000, 2_000, 2_100);
        let start = action_movement_start_ms(
            0,
            &event,
            Vec2::new(500.0, 250.0),
            Vec2::new(800.0, 300.0),
            natural_profile(),
        );

        assert_eq!(start, 1_680);
    }

    #[test]
    fn action_movement_start_bounds_long_distance_travel() {
        let event = action_event(2_000, 2_000, 2_100);
        let start = action_movement_start_ms(
            0,
            &event,
            Vec2::new(0.0, 0.0),
            Vec2::new(3_000.0, 2_000.0),
            natural_profile(),
        );

        assert_eq!(start, 1_020);
    }

    #[test]
    fn action_movement_start_keeps_minimum_short_distance_travel() {
        let event = action_event(2_000, 2_000, 2_100);
        let start = action_movement_start_ms(
            0,
            &event,
            Vec2::new(500.0, 250.0),
            Vec2::new(510.0, 250.0),
            natural_profile(),
        );

        assert_eq!(start, 1_680);
    }

    #[test]
    fn action_movement_start_respects_declared_window() {
        let event = action_event(1_000, 2_000, 2_100);

        assert_eq!(
            action_movement_start_ms(
                0,
                &event,
                Vec2::new(500.0, 250.0),
                Vec2::new(800.0, 300.0),
                natural_profile(),
            ),
            1_000,
        );
    }

    #[test]
    fn action_movement_start_clamps_to_previous_time_for_tight_events() {
        let event = action_event(1_300, 1_300, 1_400);

        assert_eq!(
            action_movement_start_ms(
                1_200,
                &event,
                Vec2::new(800.0, 300.0),
                Vec2::new(200.0, 100.0),
                natural_profile(),
            ),
            1_200,
        );
    }

    #[test]
    fn action_movement_start_uses_motion_profile_timing() {
        let event = action_event(2_000, 2_000, 2_100);

        let snappy = action_movement_start_ms(
            0,
            &event,
            Vec2::new(0.0, 0.0),
            Vec2::new(3_000.0, 2_000.0),
            CursorMotionPreset::Snappy.profile(),
        );
        let cinematic = action_movement_start_ms(
            0,
            &event,
            Vec2::new(0.0, 0.0),
            Vec2::new(3_000.0, 2_000.0),
            CursorMotionPreset::Cinematic.profile(),
        );

        assert_eq!(snappy, 1_280);
        assert_eq!(cinematic, 750);
    }
}
