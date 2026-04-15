//! Auto-zoom presets — exact parameter values from Research §4 table + D-05.
//!
//! The three presets are const; consumers pass `&DYNAMIC` etc. to
//! [`super::plan_zoom`]. [`ZoomPresetKind`] is serde+ts-rs-exported so presets
//! can be embedded in `.scpreset` files without leaking the param struct shape.

use serde::{Deserialize, Serialize};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Parameters controlling auto-zoom behaviour for one preset.
///
/// **DO NOT CHANGE FIELD VALUES** without updating Research §4 and the
/// snapshot fixtures. These numbers are tuned to minimise motion sickness
/// (Pitfall #2) — random tweaks WILL regress perceived quality.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomPreset {
    /// Upper bound on scale multiplier. Dynamic=3.0, Calm=2.2, Subtle=1.0.
    pub max_zoom: f32,
    /// Minimum gap between consecutive zoom moves (ms). Prevents `<500 ms`
    /// jitter in Dynamic, `<800 ms` in Calm/Subtle.
    pub dwell_ms: u64,
    /// Minimum cluster duration (ms). Clusters shorter than this are merged
    /// with the predecessor.
    pub min_shot_ms: u64,
    /// Upper bound on zoom changes per 60 seconds. Lowest-weight clusters are
    /// dropped if budget is exceeded.
    pub max_changes_per_min: u32,
    /// Pan phase duration (ms). Applied between previous_center and next_center
    /// with scale held constant.
    pub pan_duration_ms: u32,
    /// Scale phase duration (ms). Applied after the pan, with center held
    /// constant. Zero for pan-only presets.
    pub scale_duration_ms: u32,
    /// Spring low-pass `omega` (rad/s). See
    /// [`crate::math::spring::Spring`] docs; ω=6 ≈ 1 s settle.
    pub low_pass_omega: f32,
    /// If true, scale is held at 1.0 for the entire clip; only panning occurs.
    pub pan_only: bool,
}

pub const DYNAMIC: ZoomPreset = ZoomPreset {
    max_zoom: 3.0,
    dwell_ms: 500,
    min_shot_ms: 1200,
    max_changes_per_min: 10,
    pan_duration_ms: 400,
    scale_duration_ms: 600,
    low_pass_omega: 6.0,
    pan_only: false,
};

pub const CALM: ZoomPreset = ZoomPreset {
    max_zoom: 2.2,
    dwell_ms: 800,
    min_shot_ms: 2000,
    max_changes_per_min: 6,
    pan_duration_ms: 600,
    scale_duration_ms: 800,
    low_pass_omega: 5.0,
    pan_only: false,
};

pub const SUBTLE: ZoomPreset = ZoomPreset {
    max_zoom: 1.0,
    dwell_ms: 800,
    min_shot_ms: 2000,
    max_changes_per_min: 6,
    pan_duration_ms: 600,
    scale_duration_ms: 0,
    low_pass_omega: 4.0,
    pan_only: true,
};

/// Serialised preset selector — stored in `.scpreset` files. Calling
/// [`ZoomPresetKind::params`] dereferences to the const preset struct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum ZoomPresetKind {
    Dynamic,
    Calm,
    Subtle,
}

impl ZoomPresetKind {
    /// Resolve to the const [`ZoomPreset`] parameters.
    pub fn params(self) -> &'static ZoomPreset {
        match self {
            ZoomPresetKind::Dynamic => &DYNAMIC,
            ZoomPresetKind::Calm => &CALM,
            ZoomPresetKind::Subtle => &SUBTLE,
        }
    }
}

impl Default for ZoomPresetKind {
    fn default() -> Self {
        ZoomPresetKind::Dynamic
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_preset_values() {
        assert_eq!(DYNAMIC.max_zoom, 3.0);
        assert_eq!(DYNAMIC.dwell_ms, 500);
        assert_eq!(DYNAMIC.min_shot_ms, 1200);
        assert_eq!(DYNAMIC.max_changes_per_min, 10);
        assert_eq!(DYNAMIC.pan_duration_ms, 400);
        assert_eq!(DYNAMIC.scale_duration_ms, 600);
        assert!(!DYNAMIC.pan_only);
    }

    #[test]
    fn calm_preset_values() {
        assert_eq!(CALM.max_zoom, 2.2);
        assert_eq!(CALM.dwell_ms, 800);
        assert_eq!(CALM.min_shot_ms, 2000);
        assert_eq!(CALM.max_changes_per_min, 6);
        assert!(!CALM.pan_only);
    }

    #[test]
    fn subtle_is_pan_only() {
        assert!(SUBTLE.pan_only);
        assert_eq!(SUBTLE.max_zoom, 1.0);
        assert_eq!(SUBTLE.scale_duration_ms, 0);
    }

    #[test]
    fn preset_kind_params_round_trip() {
        assert_eq!(ZoomPresetKind::Dynamic.params().max_zoom, 3.0);
        assert_eq!(ZoomPresetKind::Calm.params().max_zoom, 2.2);
        assert_eq!(ZoomPresetKind::Subtle.params().max_zoom, 1.0);
    }
}
