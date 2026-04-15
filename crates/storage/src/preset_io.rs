//! `.scpreset` JSON file format — import/export + version migration.
//!
//! Schema v2 (current, Phase 2 first release):
//! ```jsonc
//! {
//!   "id": "<uuid>",
//!   "version": 2,
//!   "kind": "effect_preset",
//!   "name": "...",
//!   "description": "...",
//!   "bundled": true,
//!   "ast": { /* effects::Graph JSON, opaque at this layer */ },
//!   "metadata": { "author": "StoryCapture", "created_at": ..., "tags": [...] }
//! }
//! ```

use crate::error::StorageError;
use crate::models::{EffectPreset, PresetTier};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub const CURRENT_SCPRESET_VERSION: u32 = 2;

/// Max `.scpreset` file size accepted by `import_preset` (mitigates T-02-07
/// DoS via 10-GiB JSON input). Realistic presets are well under 100 KiB.
pub const MAX_SCPRESET_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScpresetMetadata {
    pub author: String,
    /// Unix epoch millis — same time base as storage rows.
    pub created_at: i64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScpresetFile {
    /// Optional stable id — bundled presets supply one to make installation
    /// idempotent via `INSERT OR IGNORE`. User-exported presets may omit it.
    #[serde(default)]
    pub id: Option<Uuid>,
    pub version: u32,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub bundled: bool,
    pub ast: serde_json::Value,
    pub metadata: ScpresetMetadata,
}

/// Add the explicit variants this module raises. Other StorageError variants
/// cover IO + JSON. We fold preset-specific errors into `Serialization` with
/// a descriptive message to avoid a breaking change to the enum.
fn err_invalid_kind(got: &str) -> StorageError {
    StorageError::Serialization(format!("invalid .scpreset kind: expected 'effect_preset', got {got:?}"))
}
fn err_too_new(got: u32) -> StorageError {
    StorageError::Serialization(format!(
        ".scpreset version {got} is newer than supported ({CURRENT_SCPRESET_VERSION}); upgrade StoryCapture"
    ))
}
fn err_unsupported_v1() -> StorageError {
    StorageError::Serialization(
        ".scpreset v1 is not a shipped format; no v1 migration exists".into(),
    )
}
fn err_too_large(sz: u64) -> StorageError {
    StorageError::Serialization(format!(
        ".scpreset file is {sz} bytes; refusing to parse > {MAX_SCPRESET_BYTES} (T-02-07)"
    ))
}

/// Export an `EffectPreset` (as it lives in the DB) to a `.scpreset` JSON
/// file at `out`.
pub fn export_preset(preset: &EffectPreset, out: &Path) -> Result<(), StorageError> {
    let ast: serde_json::Value = serde_json::from_str(&preset.ast_json)?;
    let file = ScpresetFile {
        id: Some(preset.id),
        version: CURRENT_SCPRESET_VERSION,
        kind: "effect_preset".into(),
        name: preset.name.clone(),
        description: preset.description.clone(),
        bundled: preset.bundled,
        ast,
        metadata: ScpresetMetadata {
            author: preset.author.clone().unwrap_or_default(),
            created_at: preset.created_at,
            tags: preset.tags.clone(),
        },
    };
    let json = serde_json::to_string_pretty(&file)?;
    std::fs::write(out, json)?;
    Ok(())
}

/// Import a `.scpreset` JSON file into an `EffectPreset` struct. Target scope
/// defaults to `Project`; call-sites re-assign when installing globally.
pub fn import_preset(path: &Path) -> Result<EffectPreset, StorageError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_SCPRESET_BYTES {
        return Err(err_too_large(meta.len()));
    }
    let txt = std::fs::read_to_string(path)?;
    let mut file: ScpresetFile = serde_json::from_str(&txt)?;

    if file.kind != "effect_preset" {
        return Err(err_invalid_kind(&file.kind));
    }
    if file.version > CURRENT_SCPRESET_VERSION {
        return Err(err_too_new(file.version));
    }
    if file.version < CURRENT_SCPRESET_VERSION {
        file = migrate_preset_v1_to_v2(file)?;
    }

    Ok(EffectPreset {
        id: file.id.unwrap_or_else(Uuid::now_v7),
        scope: PresetTier::Project,
        name: file.name,
        description: file.description,
        ast_json: serde_json::to_string(&file.ast)?,
        version: file.version,
        bundled: file.bundled,
        created_at: file.metadata.created_at,
        author: if file.metadata.author.is_empty() {
            None
        } else {
            Some(file.metadata.author)
        },
        tags: file.metadata.tags,
    })
}

/// v1 → v2 migration stub. Phase 2 is the first shipped `.scpreset` format,
/// so v1 does not exist in the wild. The stub always errors; it is kept as a
/// seam so future v2 → v3 migrations can slot in symmetrically.
pub fn migrate_preset_v1_to_v2(_file: ScpresetFile) -> Result<ScpresetFile, StorageError> {
    Err(err_unsupported_v1())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_kind_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.scpreset");
        std::fs::write(
            &p,
            r#"{"version":2,"kind":"wrong","name":"x","description":"","bundled":false,"ast":{},"metadata":{"author":"a","created_at":0,"tags":[]}}"#,
        )
        .unwrap();
        let err = import_preset(&p).unwrap_err();
        match err {
            StorageError::Serialization(m) => assert!(m.contains("invalid .scpreset kind"), "{m}"),
            other => panic!("expected Serialization, got {other:?}"),
        }
    }

    #[test]
    fn too_new_version_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("future.scpreset");
        std::fs::write(
            &p,
            r#"{"version":99,"kind":"effect_preset","name":"x","description":"","bundled":false,"ast":{},"metadata":{"author":"a","created_at":0,"tags":[]}}"#,
        )
        .unwrap();
        let err = import_preset(&p).unwrap_err();
        match err {
            StorageError::Serialization(m) => assert!(m.contains("newer than supported"), "{m}"),
            other => panic!("expected Serialization, got {other:?}"),
        }
    }

    #[test]
    fn v1_migration_is_unsupported() {
        let file = ScpresetFile {
            id: None,
            version: 1,
            kind: "effect_preset".into(),
            name: "old".into(),
            description: "".into(),
            bundled: false,
            ast: serde_json::json!({}),
            metadata: ScpresetMetadata {
                author: "".into(),
                created_at: 0,
                tags: vec![],
            },
        };
        assert!(migrate_preset_v1_to_v2(file).is_err());
    }
}
