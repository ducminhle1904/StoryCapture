//! Canonical filter-graph order (D-19, POST-08).
//!
//! Every [`VideoNode`] is assigned a [`CanonicalStage`]; the validator
//! rejects any graph whose nodes are not in non-decreasing stage order.
//! Gaps are allowed — only backwards ordering fails.
//!
//! Pattern choice: runtime validator rather than typestate builder
//! (Research §1). A typestate builder would add ~N type parameters for
//! cleanliness we don't need yet; the validator is one function.

use serde::{Deserialize, Serialize};

use crate::ast::video::VideoNode;
use crate::error::EffectsError;

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Canonical stage assigned to each node variant. Defines the D-19 order:
/// Source → ZoomPan → Background → Cursor → Ripple → Text → Transition → AudioMix.
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[repr(u8)]
pub enum CanonicalStage {
    Source = 0,
    ZoomPan = 1,
    Background = 2,
    Cursor = 3,
    Ripple = 4,
    Text = 5,
    Transition = 6,
    AudioMix = 7,
}

/// Map a video node variant to its canonical stage.
pub fn node_stage(n: &VideoNode) -> CanonicalStage {
    match n {
        VideoNode::Source { .. } => CanonicalStage::Source,
        VideoNode::ZoomPan { .. } => CanonicalStage::ZoomPan,
        VideoNode::Background { .. } => CanonicalStage::Background,
        VideoNode::CursorOverlay { .. } => CanonicalStage::Cursor,
        VideoNode::RippleOverlay { .. } => CanonicalStage::Ripple,
        VideoNode::TextOverlay { .. } => CanonicalStage::Text,
        VideoNode::Transition { .. } => CanonicalStage::Transition,
    }
}

/// All audio nodes belong to the AudioMix stage.
pub fn audio_stage() -> CanonicalStage {
    CanonicalStage::AudioMix
}

/// Enforce D-19 canonical order. Returns the first violation encountered.
pub fn validate_order(video: &[VideoNode]) -> Result<(), EffectsError> {
    let mut max_seen: Option<CanonicalStage> = None;
    for n in video {
        let s = node_stage(n);
        if let Some(prev) = max_seen {
            if s < prev {
                return Err(EffectsError::CanonicalOrderViolation(s, prev));
            }
        }
        max_seen = Some(match max_seen {
            Some(m) => m.max(s),
            None => s,
        });
    }
    Ok(())
}
