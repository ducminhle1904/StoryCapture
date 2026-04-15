//! Per-story effect overrides on top of a chosen preset.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectSettings {
    pub story_id: String,
    pub preset_id: Option<Uuid>,
    pub overrides_json: String,
    pub last_modified: i64,
}
