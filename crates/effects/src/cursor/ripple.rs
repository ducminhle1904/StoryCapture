//! Click ripple factory.
//!
//! Given a waypoint list, produce one [`RippleEvent`] per Click with the
//! canonical 60 ms anticipation, 300 ms radial expand, and decaying alpha.

use crate::ast::types::Rgba;
use crate::ast::video::RippleEvent;
use crate::math::min_jerk::{Waypoint, WaypointKind};

/// Defaults for click ripple rendering.
#[derive(Debug, Clone, Copy)]
pub struct RippleOptions {
    /// Milliseconds before impact to start the "anticipate" pulse.
    pub anticipate_ms: u64,
    /// Total duration of the radial expand (post-impact).
    pub duration_ms: u32,
    /// Maximum ring radius at full expansion.
    pub max_radius_px: f32,
    /// Ring colour at full alpha.
    pub color: Rgba,
}

impl Default for RippleOptions {
    fn default() -> Self {
        // Anticipate 60ms before impact, expand 300ms, white @ 0.9 alpha.
        Self {
            anticipate_ms: 60,
            duration_ms: 300,
            max_radius_px: 60.0,
            color: Rgba {
                r: 255,
                g: 255,
                b: 255,
                a: 229,
            },
        }
    }
}

/// Build a [`RippleEvent`] per Click waypoint. Non-click kinds are skipped.
pub fn build_ripples(waypoints: &[Waypoint], opts: &RippleOptions) -> Vec<RippleEvent> {
    waypoints
        .iter()
        .filter(|w| matches!(w.kind, WaypointKind::Click))
        .map(|w| RippleEvent {
            t_anticipate_ms: w.t_ms.saturating_sub(opts.anticipate_ms),
            t_impact_ms: w.t_ms,
            duration_ms: opts.duration_ms,
            center: w.pos,
            max_radius_px: opts.max_radius_px,
            color: opts.color,
        })
        .collect()
}

/// Alpha for a ripple at time `t_ms`. Zero outside
/// `[t_anticipate_ms, t_impact_ms + duration_ms]`.
///
/// - Anticipate window: linear ramp from 0 → 0.4 × base alpha.
/// - Post-impact: `(1 - t_rel).powi(2)` decay scaled by the event's base alpha.
pub fn ripple_alpha(event: &RippleEvent, t_ms: u64) -> f32 {
    if t_ms < event.t_anticipate_ms || t_ms > event.t_impact_ms + event.duration_ms as u64 {
        return 0.0;
    }
    let base = event.color.a as f32 / 255.0;
    if t_ms < event.t_impact_ms {
        let anti_span = (event.t_impact_ms - event.t_anticipate_ms) as f32;
        if anti_span <= 0.0 {
            return 0.0;
        }
        return 0.4 * base * ((t_ms - event.t_anticipate_ms) as f32 / anti_span);
    }
    let t_rel = (t_ms - event.t_impact_ms) as f32 / event.duration_ms as f32;
    (1.0 - t_rel).powi(2) * base
}

/// Radius of a ripple at time `t_ms`. Zero before impact and after
/// `duration_ms` elapses; linear expand in between.
pub fn ripple_radius(event: &RippleEvent, t_ms: u64) -> f32 {
    if t_ms < event.t_impact_ms || t_ms > event.t_impact_ms + event.duration_ms as u64 {
        return 0.0;
    }
    let t_rel = (t_ms - event.t_impact_ms) as f32 / event.duration_ms as f32;
    event.max_radius_px * t_rel
}
