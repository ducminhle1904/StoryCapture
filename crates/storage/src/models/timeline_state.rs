//! Per-story timeline layout snapshot. `layout_json` is opaque Zustand slice
//! state produced by the frontend; the storage crate does not parse it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineState {
    pub story_id: String,
    pub layout_json: String,
    pub last_modified: i64,
}
