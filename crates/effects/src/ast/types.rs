//! Primitive AST types shared across video and audio nodes.
//!
//! `NodeId::stable_label(prefix)` produces a deterministic short string derived
//! from the node's UUID, used by the FFmpeg emitter to create collision-free
//! filter-graph labels (prevents Pitfall #1 — label collisions).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Schema version for the Graph AST (matches project.sqlite v2). Bumped
/// on breaking AST changes; older presets are migrated by the `.scpreset`
/// loader.
pub const SCHEMA_VERSION: u32 = 2;

/// A stable, globally-unique identifier for an AST node.
///
/// The UUID determines:
///   - the node's identity across preset save/load
///   - the short hex label used by the FFmpeg emitter (`stable_label`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct NodeId(#[cfg_attr(feature = "ts-export", ts(type = "string"))] pub Uuid);

impl NodeId {
    /// Fresh random v4 UUID.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Construct a NodeId from raw bytes. Used by snapshot tests for
    /// reproducible label output.
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(Uuid::from_bytes(bytes))
    }

    /// Deterministic short label (`"{prefix}_{:04x}"`) derived from the low 16
    /// bits of the UUID. Same UUID ⇒ same label on every host.
    pub fn stable_label(&self, prefix: &str) -> String {
        let low = (self.0.as_u128() as u32) & 0xFFFF;
        format!("{}_{:04x}", prefix, low)
    }
}

impl Default for NodeId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const WHITE: Rgba = Rgba {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    };
    pub const BLACK: Rgba = Rgba {
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    };
    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct Duration {
    pub ms: u64,
}

impl Duration {
    pub const fn from_ms(ms: u64) -> Self {
        Self { ms }
    }
}

/// Easing functions for keyframe interpolation. We only need the variants
/// reachable from the AST here.
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
pub enum EasingKind {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    /// Cinematic cubic ease-in-out used by the zoom planner's pan/scale
    /// samplers. Previously lived in `math::ease::EasingKind`; consolidated
    /// here so presets, runtime samplers, and the TypeScript export all
    /// reference a single enum.
    EaseInOutCubic,
    /// Quadratic ease-out used for cursor-final-position nudges.
    EaseOutQuad,
}
