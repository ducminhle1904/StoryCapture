//! Audio AST nodes. All audio lives in the final canonical stage (AudioMix).
//!
//! Values use canonical defaults for sidechain ducking:
//!   threshold=0.08, ratio=8, attack=80ms, release=400ms.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::types::NodeId;

#[cfg(feature = "ts-export")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct SidechainParams {
    pub threshold: f32,
    pub ratio: f32,
    pub attack_ms: u32,
    pub release_ms: u32,
}

impl Default for SidechainParams {
    /// Canonical defaults.
    fn default() -> Self {
        Self {
            threshold: 0.08,
            ratio: 8.0,
            attack_ms: 80,
            release_ms: 400,
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
pub struct AmixParams {
    /// Labels of the input audio streams (one per channel being mixed).
    pub inputs: Vec<String>,
    /// When true, FFmpeg's `amix=normalize=1` scales by 1/N; most cinematic
    /// mixes want `false` so SFX stay punchy.
    pub normalize: bool,
}

/// Audio AST node. See [`crate::builder::order::CanonicalStage::AudioMix`].
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
pub enum AudioNode {
    AudioSource {
        id: NodeId,
        path: PathBuf,
        pts_offset_ms: u64,
    },
    Volume {
        id: NodeId,
        input_label: String,
        volume: f32,
    },
    Delay {
        id: NodeId,
        input_label: String,
        ms: u64,
    },
    Sidechain {
        id: NodeId,
        carrier: String,
        sidechain: String,
        params: SidechainParams,
    },
    Amix {
        id: NodeId,
        inputs: Vec<String>,
        normalize: bool,
    },
    Alimiter {
        id: NodeId,
        input: String,
        limit: f32,
    },
}

impl AudioNode {
    pub fn id(&self) -> NodeId {
        match self {
            AudioNode::AudioSource { id, .. }
            | AudioNode::Volume { id, .. }
            | AudioNode::Delay { id, .. }
            | AudioNode::Sidechain { id, .. }
            | AudioNode::Amix { id, .. }
            | AudioNode::Alimiter { id, .. } => *id,
        }
    }
}
