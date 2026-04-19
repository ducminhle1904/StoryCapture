//! Cursor trajectory sampler — the humanised motion engine for POST-03.
//!
//! Equivalent to [`crate::math::min_jerk::sample_path`] but with added
//! per-frame timestamping, post-click dwell insertion, velocity-cap
//! stretching, reversal pauses, and Perlin jitter. We call `min_jerk_sample`
//! per-frame instead of reusing `sample_path` wholesale because we need
//! fine-grained control over `t_ms` emission between segments.
//!
//! Pipeline (Research §3 + D-08/D-10/D-11):
//! 1. Pre-process: insert a post-click dwell waypoint after each Click so
//!    min-jerk naturally holds at the click point for `post_click_dwell_ms`.
//! 2. Velocity cap: if any segment's peak velocity exceeds
//!    `peak_velocity_cap_px_per_s`, extend that segment's duration
//!    (and shift all later waypoints) until the cap is satisfied.
//! 3. Sample the path using [`crate::math::min_jerk::min_jerk_sample`]
//!    per-segment at `fps`.
//! 4. Reversal pauses: at every reversal index (>`reversal_threshold_deg`),
//!    repeat the pivot position for `reversal_pause_ms`.
//! 5. Perlin jitter: add sub-pixel `PerlinNoise2D` noise (~2 Hz) scaled by
//!    `jitter_amplitude_px` to every sample.
//!
//! All outputs are deterministic given `jitter_seed`.

use crate::ast::types::Vec2;
use crate::math::min_jerk::{
    detect_reversals, min_jerk_sample, peak_velocity, Waypoint, WaypointKind,
};
use crate::math::perlin::PerlinNoise2D;
use crate::math::vec2::Vec2Ops;

/// One sampled cursor frame: `(t_ms, pos)` with `pos` being the final
/// post-jitter position to draw.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorSample {
    pub t_ms: u64,
    pub pos: Vec2,
}

/// Options controlling the trajectory sampler. Defaults match D-08/D-10/D-11
/// and Research §3 — `peak_velocity_cap_px_per_s: 2500` at 1080p,
/// `post_click_dwell_ms: 200`, `reversal_threshold_deg: 135`.
#[derive(Debug, Clone, Copy)]
pub struct TrajectoryOptions {
    pub fps: u32,
    pub jitter_amplitude_px: f32,
    pub jitter_seed: u64,
    pub reversal_threshold_deg: f32,
    pub reversal_pause_ms: u32,
    pub peak_velocity_cap_px_per_s: f32,
    pub post_click_dwell_ms: u32,
}

impl Default for TrajectoryOptions {
    fn default() -> Self {
        Self {
            fps: 60,
            jitter_amplitude_px: 1.0,
            jitter_seed: 0xC0FFEE,
            reversal_threshold_deg: 135.0,
            reversal_pause_ms: 100,
            peak_velocity_cap_px_per_s: 2500.0,
            post_click_dwell_ms: 200,
        }
    }
}

/// Insert a post-click dwell waypoint after each Click so min-jerk naturally
/// holds the cursor at the click point. The dwell is clipped by the time to
/// the next waypoint (Research §3: `min(200 ms, time_to_next_waypoint)`).
fn insert_post_click_dwell(raw: &[Waypoint], post_click_dwell_ms: u32) -> Vec<Waypoint> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(raw.len() * 2);
    for (i, w) in raw.iter().enumerate() {
        out.push(*w);
        if matches!(w.kind, WaypointKind::Click) {
            let next_t = raw.get(i + 1).map(|n| n.t_ms);
            let dwell_cap = match next_t {
                Some(t) if t > w.t_ms => (t - w.t_ms).min(post_click_dwell_ms as u64),
                Some(_) => 0,
                None => post_click_dwell_ms as u64,
            };
            if dwell_cap > 0 {
                out.push(Waypoint {
                    t_ms: w.t_ms + dwell_cap,
                    pos: w.pos,
                    kind: WaypointKind::Hover,
                });
            }
        }
    }
    out
}

/// Extend per-segment durations so peak velocity never exceeds `cap_px_per_s`.
/// When a segment needs stretching, every later waypoint's `t_ms` is shifted
/// by the same delta (cumulative).
fn apply_velocity_cap(raw: &[Waypoint], cap_px_per_s: f32) -> Vec<Waypoint> {
    if raw.len() < 2 || cap_px_per_s <= 0.0 {
        return raw.to_vec();
    }
    let mut out: Vec<Waypoint> = Vec::with_capacity(raw.len());
    out.push(raw[0]);
    for i in 1..raw.len() {
        let prev_orig = raw[i - 1];
        let cur_orig = raw[i];
        let last_adj = *out.last().unwrap();
        let orig_dur_ms = cur_orig.t_ms.saturating_sub(prev_orig.t_ms);
        let seg_sec = orig_dur_ms as f32 / 1000.0;
        let mut new_t = last_adj.t_ms + orig_dur_ms;
        if orig_dur_ms > 0 {
            let peak = peak_velocity(prev_orig.pos, cur_orig.pos, seg_sec);
            if peak.is_finite() && peak > cap_px_per_s {
                let extended_sec = seg_sec * peak / cap_px_per_s;
                let extended_ms = (extended_sec * 1000.0).ceil() as u64;
                new_t = last_adj.t_ms + extended_ms;
            }
        }
        out.push(Waypoint {
            t_ms: new_t,
            pos: cur_orig.pos,
            kind: cur_orig.kind,
        });
    }
    out
}

/// Sample the full trajectory: min-jerk + velocity cap + post-click dwell +
/// reversal pauses + Perlin jitter. Result is deterministic given
/// `opts.jitter_seed` and identical inputs.
pub fn sample_trajectory(raw: &[Waypoint], opts: TrajectoryOptions) -> Vec<CursorSample> {
    if raw.len() < 2 || opts.fps == 0 {
        return Vec::new();
    }

    // Step 1+2: post-click dwell + velocity cap.
    let dwelled = insert_post_click_dwell(raw, opts.post_click_dwell_ms);
    let waypoints = apply_velocity_cap(&dwelled, opts.peak_velocity_cap_px_per_s);

    if waypoints.len() < 2 {
        return Vec::new();
    }

    // Step 3: per-segment min-jerk sampling.
    let frame_ms = 1000.0 / opts.fps as f32;
    let dt = 1.0 / opts.fps as f32;
    let reversal_indices: std::collections::HashSet<usize> =
        detect_reversals(&waypoints, opts.reversal_threshold_deg)
            .into_iter()
            .collect();
    let reversal_pause_frames = ((opts.reversal_pause_ms as f32) / frame_ms).ceil() as u32;

    let mut samples: Vec<CursorSample> = Vec::new();
    let mut t_ms_cursor: u64 = waypoints[0].t_ms;

    for i in 0..waypoints.len() - 1 {
        let w0 = waypoints[i];
        let w1 = waypoints[i + 1];
        if w1.t_ms <= w0.t_ms {
            continue;
        }
        let seg_sec = (w1.t_ms - w0.t_ms) as f32 / 1000.0;
        let n = (seg_sec * opts.fps as f32).round().max(1.0) as u32;
        for k in 0..n {
            let t_sec = k as f32 * dt;
            let p = min_jerk_sample(w0.pos, w1.pos, t_sec, seg_sec);
            samples.push(CursorSample {
                t_ms: t_ms_cursor + (k as u64 * frame_ms.round() as u64),
                pos: p,
            });
        }
        // Step 4: reversal pause at w1 (the pivot).
        if reversal_indices.contains(&(i + 1)) && i + 1 < waypoints.len() - 1 {
            let pause_start_t = t_ms_cursor + (n as u64 * frame_ms.round() as u64);
            for k in 0..reversal_pause_frames {
                samples.push(CursorSample {
                    t_ms: pause_start_t + (k as u64 * frame_ms.round() as u64),
                    pos: w1.pos,
                });
            }
            t_ms_cursor = pause_start_t + (reversal_pause_frames as u64 * frame_ms.round() as u64);
        } else {
            t_ms_cursor += n as u64 * frame_ms.round() as u64;
        }
    }
    // Ensure final waypoint lands exactly.
    samples.push(CursorSample {
        t_ms: t_ms_cursor,
        pos: waypoints.last().unwrap().pos,
    });

    // Step 5: Perlin jitter (~2 Hz). Amplitude 0 → skip (useful for determinism
    // spot checks without jitter).
    if opts.jitter_amplitude_px > 0.0 {
        let perlin = PerlinNoise2D::new(opts.jitter_seed);
        // jitter_freq cycles per frame: 2 Hz / fps.
        let jitter_freq = 2.0 / opts.fps as f32;
        for (i, s) in samples.iter_mut().enumerate() {
            let fi = i as f32;
            let dx = perlin.sample(fi * jitter_freq, 0.0) * opts.jitter_amplitude_px;
            let dy = perlin.sample(0.0, fi * jitter_freq) * opts.jitter_amplitude_px;
            s.pos = s.pos.add(Vec2::new(dx, dy));
        }
    }

    samples
}
