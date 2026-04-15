//! `effects` — typed filter-graph AST for post-production (auto-zoom, cursor, transitions, sound).
//!
//! This crate is the single source of truth for both:
//!   - FFmpeg final export (via [`emit::ffmpeg::emit`] producing a `filter_complex` string)
//!   - WebGPU preview (via [`emit::preview::emit`] producing a [`emit::preview::PreviewRenderPlan`])
//!
//! All nodes derive `serde::{Serialize, Deserialize}` for `.scpreset` round-trip and,
//! when the `ts-export` feature is on, `ts-rs` mirror types are emitted to
//! `packages/shared-types/src/generated/effects.ts` so the frontend inspector edits
//! the same AST.

pub mod ast;
pub mod builder;
pub mod cursor;
pub mod emit;
pub mod error;
pub mod math;
pub mod zoom;

pub use ast::{AudioNode, Graph, VideoNode, SCHEMA_VERSION};
pub use builder::{BuilderError, GraphBuilder};
pub use emit::{FfmpegEmit, PreviewEmit, PreviewRenderPlan};
pub use error::{EffectsError, Result};
