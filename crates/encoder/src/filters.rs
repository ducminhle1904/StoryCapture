//! Filter/type definitions shared across Phase 12 encoder plans.
//!
//! Wave-1 stub: only `QualityPreset` is declared here so that Plan 12-02's
//! `quality` module can `use crate::filters::QualityPreset`. Plan 12-01 (also
//! Wave 1) extends this file with `FilterSpec`, `FitMode`, `ScaleAlgo`,
//! `PadColor`, `OutputResolution`, and `build_vf` — the orchestrator merges
//! the two worktrees.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum QualityPreset {
    Low,
    Med,
    High,
    Lossless,
}
