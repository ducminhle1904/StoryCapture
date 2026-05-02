//! Video AST nodes. Every variant corresponds to one canonical stage.
//!
//! No algorithm-specific logic lives here — downstream code fills in
//! zoompan math, cursor trajectories, ripple timing, etc. This module only
//! fixes the AST shape so those plans can emit without reshaping.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::types::{EasingKind, NodeId, Rgba, Vec2};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Keyframe for the ZoomPan stage. The runtime resolves interpolation;
/// the AST stores endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct ZoomKeyframe {
    pub t_ms: u64,
    pub center: Vec2,
    pub scale: f32,
    pub easing: EasingKind,
}

/// What the ZoomPan stage is tracking. Used to pick cursor vs
/// fixed-region tracking logic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ZoomTarget {
    Cursor,
    FixedRegion { top_left: Vec2, size: Vec2 },
    Element { selector: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BackgroundKind {
    Gradient { preset_id: String },
    Image { path: PathBuf },
    Solid { color: Rgba },
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
pub struct Shadow {
    pub blur_px: f32,
    pub offset: Vec2,
    pub color: Rgba,
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
#[serde(rename_all = "kebab-case")]
pub enum CursorSkin {
    MacDefault,
    WinDefault,
    Dark,
    Light,
    BigArrow,
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
#[serde(rename_all = "kebab-case")]
pub enum CursorMotionPreset {
    Natural,
    Snappy,
    Cinematic,
}

impl Default for CursorMotionPreset {
    fn default() -> Self {
        Self::Natural
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct TrajectoryRef {
    pub png_sequence_dir: PathBuf,
    pub fps: u32,
    pub frame_count: u32,
}

/// A ripple pulse emitted on click. Defaults:
/// `t_anticipate = t_impact - 60`, `duration = 300`, `max_radius_px = 60.0`,
/// `color = white @ 0.9 alpha`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct RippleEvent {
    pub t_anticipate_ms: u64,
    pub t_impact_ms: u64,
    pub duration_ms: u32,
    pub center: Vec2,
    pub max_radius_px: f32,
    #[serde(default)]
    pub bounds: Option<HighlightBounds>,
    pub color: Rgba,
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
pub struct HighlightBounds {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
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
#[serde(rename_all = "kebab-case")]
pub enum HighlightShape {
    Ring,
    Spotlight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct HighlightOverlaySpec {
    pub t_start_ms: u64,
    pub duration_ms: u32,
    pub shape: HighlightShape,
    pub center: Vec2,
    pub max_radius_px: f32,
    #[serde(default)]
    pub bounds: Option<HighlightBounds>,
    pub padding_px: f32,
    pub radius_px: f32,
    pub stroke_px: f32,
    pub glow_px: f32,
    pub color: Rgba,
    pub opacity: f32,
    #[serde(default)]
    pub png_path: Option<PathBuf>,
    #[serde(default)]
    pub overlay_pos: Option<Vec2>,
}

impl RippleEvent {
    /// Construct a ripple with defaults from Research §3.
    pub fn at_impact(t_impact_ms: u64, center: Vec2) -> Self {
        Self {
            t_anticipate_ms: t_impact_ms.saturating_sub(60),
            t_impact_ms,
            duration_ms: 300,
            center,
            max_radius_px: 60.0,
            bounds: None,
            color: Rgba::new(255, 255, 255, 229), // 0.9 alpha
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FontChoice {
    Bundled { family: String, weight: u16 },
    SystemDefault,
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
#[serde(rename_all = "kebab-case")]
pub enum TextAnim {
    None,
    Fade,
    SlideUp,
    ScaleIn,
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
pub struct BoxStyle {
    pub padding_px: f32,
    pub radius_px: f32,
    pub bg_color: Rgba,
    pub border_color: Option<Rgba>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct TextBox {
    pub t_start_ms: u64,
    pub t_end_ms: u64,
    pub text: String,
    pub pos: Vec2,
    pub font: FontChoice,
    pub size_pt: f32,
    pub color: Rgba,
    pub box_style: Option<BoxStyle>,
    pub anim_in: TextAnim,
    pub anim_out: TextAnim,
}

/// The 14-value xfade subset exposed to the user (Research §5).
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
pub enum XfadeKind {
    Fade,
    FadeBlack,
    FadeWhite,
    Dissolve,
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,
    CircleOpen,
    CircleClose,
}

impl XfadeKind {
    /// Returns the FFmpeg `xfade` `transition=` token.
    pub fn ffmpeg_token(self) -> &'static str {
        match self {
            XfadeKind::Fade => "fade",
            XfadeKind::FadeBlack => "fadeblack",
            XfadeKind::FadeWhite => "fadewhite",
            XfadeKind::Dissolve => "dissolve",
            XfadeKind::WipeLeft => "wipeleft",
            XfadeKind::WipeRight => "wiperight",
            XfadeKind::WipeUp => "wipeup",
            XfadeKind::WipeDown => "wipedown",
            XfadeKind::SlideLeft => "slideleft",
            XfadeKind::SlideRight => "slideright",
            XfadeKind::SlideUp => "slideup",
            XfadeKind::SlideDown => "slidedown",
            XfadeKind::CircleOpen => "circleopen",
            XfadeKind::CircleClose => "circleclose",
        }
    }
}

/// Video AST node. One variant per canonical stage. Ordering is enforced
/// at build-time by [`crate::builder::order::validate_order`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum VideoNode {
    Source {
        id: NodeId,
        path: PathBuf,
        pts_offset_ms: u64,
    },
    ZoomPan {
        id: NodeId,
        target: ZoomTarget,
        keyframes: Vec<ZoomKeyframe>,
    },
    Background {
        id: NodeId,
        kind: BackgroundKind,
        radius_px: f32,
        shadow: Option<Shadow>,
        /// Inner padding around the foreground video after compositing onto the
        /// background layer. Range: 0..=128 px.
        #[serde(default)]
        padding_px: u32,
    },
    CursorOverlay {
        id: NodeId,
        skin: CursorSkin,
        size_scale: f32,
        #[serde(default)]
        motion_preset: CursorMotionPreset,
        color_tint: Option<Rgba>,
        trajectory: TrajectoryRef,
    },
    RippleOverlay {
        id: NodeId,
        events: Vec<RippleEvent>,
    },
    HighlightOverlay {
        id: NodeId,
        highlights: Vec<HighlightOverlaySpec>,
    },
    TextOverlay {
        id: NodeId,
        boxes: Vec<TextBox>,
    },
    Transition {
        id: NodeId,
        kind: XfadeKind,
        duration_ms: u32,
        offset_ms: u32,
    },
}

impl VideoNode {
    pub fn id(&self) -> NodeId {
        match self {
            VideoNode::Source { id, .. }
            | VideoNode::ZoomPan { id, .. }
            | VideoNode::Background { id, .. }
            | VideoNode::CursorOverlay { id, .. }
            | VideoNode::RippleOverlay { id, .. }
            | VideoNode::HighlightOverlay { id, .. }
            | VideoNode::TextOverlay { id, .. }
            | VideoNode::Transition { id, .. } => *id,
        }
    }
}
