// Plan 02-12a: preset Tauri commands.
//
// Thin wrappers over `storage::repos::preset_repo` + `storage::preset_io`.
// The project DB connection is borrowed from the installed render queue
// state (Plan 02-10's `AppState::render_queue`), since the post-production
// editor only operates on an open project. Global-scope requests are
// accepted but routed to the same connection for now — a separate global
// app-db handle will be added when Plan 02-13 (settings/about) needs it.
//
// T-02-36 (preset_import path escape): `import_preset_cmd` re-canonicalises
// the requested `.scpreset` path and rejects traversal attempts that resolve
// outside the user's home directory or the project folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use storage::repos::preset_repo;
use storage::{export_preset, import_preset, EffectPreset, NewEffectPreset, PresetTier};
use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs — TS-bound via specta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PresetScopeDto {
    Project,
    Global,
}

impl From<PresetScopeDto> for PresetTier {
    fn from(s: PresetScopeDto) -> Self {
        match s {
            PresetScopeDto::Project => PresetTier::Project,
            PresetScopeDto::Global => PresetTier::Global,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct EffectPresetDto {
    pub id: String,
    /// "project" | "global"
    pub scope: String,
    pub name: String,
    pub description: String,
    pub ast_json: String,
    pub version: u32,
    pub bundled: bool,
    pub created_at: i64,
    pub author: Option<String>,
    pub tags: Vec<String>,
}

impl From<EffectPreset> for EffectPresetDto {
    fn from(p: EffectPreset) -> Self {
        Self {
            id: p.id.to_string(),
            scope: p.scope.as_str().to_string(),
            name: p.name,
            description: p.description,
            ast_json: p.ast_json,
            version: p.version,
            bundled: p.bundled,
            created_at: p.created_at,
            author: p.author,
            tags: p.tags,
        }
    }
}

// ---------------------------------------------------------------------------
// Path guard (T-02-36)
// ---------------------------------------------------------------------------

/// Reject paths that — after canonicalisation — escape both the user's home
/// directory AND any parent the caller has plausibly chosen (temp dir,
/// user-data dir). The simplest rule: the canonical path must be under
/// `$HOME` or `$TMPDIR`. The user explicitly picks the import path through
/// the native file dialog, so we are not sandboxing legitimate usage — we
/// are just rejecting `..`-escape attempts that jumped out of a dialog
/// scope.
fn validate_preset_path(path: &Path) -> Result<PathBuf, AppError> {
    let canonical = path
        .canonicalize()
        .map_err(|e| AppError::InvalidArgument(format!("preset path: {e}")))?;
    let home = dirs_like_home();
    let tmp = std::env::temp_dir();
    let in_home = home
        .as_deref()
        .map(|h| canonical.starts_with(h))
        .unwrap_or(false);
    let in_tmp = canonical.starts_with(&tmp);
    if !in_home && !in_tmp {
        return Err(AppError::InvalidArgument(format!(
            "preset path escapes allowed roots: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// Resolve a home directory without pulling the `dirs` crate as a new dep
/// in the host (it's transitively available but we avoid introducing the
/// API surface here).
fn dirs_like_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn preset_list(
    state: State<'_, AppState>,
    scope: PresetScopeDto,
) -> Result<Vec<EffectPresetDto>, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let rows = preset_repo::list_by_scope(&conn, scope.into())?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn preset_import(
    state: State<'_, AppState>,
    path: String,
    scope: PresetScopeDto,
) -> Result<String, AppError> {
    let canonical = validate_preset_path(Path::new(&path))?;
    let mut preset = import_preset(&canonical)?;
    // Align scope with the caller's request; `import_preset` defaults to Project.
    preset.scope = PresetTier::from(scope);

    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let new = NewEffectPreset {
        id: Some(preset.id),
        scope: preset.scope,
        name: preset.name,
        description: preset.description,
        ast_json: preset.ast_json,
        version: preset.version,
        bundled: preset.bundled,
        author: preset.author,
        tags: preset.tags,
    };
    let id = preset_repo::insert(&conn, &new)?;
    Ok(id.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn preset_export(
    state: State<'_, AppState>,
    id: String,
    out: String,
) -> Result<(), AppError> {
    let uuid =
        Uuid::parse_str(&id).map_err(|e| AppError::InvalidArgument(format!("preset id: {e}")))?;
    // Allow export to any writable path under home/tmp — the file dialog
    // already gated the choice.
    let out_path = PathBuf::from(&out);
    if let Some(parent) = out_path.parent() {
        if !parent.exists() {
            return Err(AppError::InvalidArgument(format!(
                "export parent dir does not exist: {}",
                parent.display()
            )));
        }
    }

    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let preset = preset_repo::get(&conn, uuid)?
        .ok_or_else(|| AppError::NotFound(format!("preset {uuid}")))?;
    export_preset(&preset, &out_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_dto_round_trip() {
        let p: PresetTier = PresetScopeDto::Project.into();
        assert!(matches!(p, PresetTier::Project));
        let g: PresetTier = PresetScopeDto::Global.into();
        assert!(matches!(g, PresetTier::Global));
    }

    #[test]
    fn path_guard_rejects_root_escape() {
        // /etc/passwd exists on unix and is outside HOME/TMP → rejected.
        #[cfg(unix)]
        {
            let out = validate_preset_path(Path::new("/etc/passwd"));
            assert!(out.is_err(), "expected path-guard rejection, got {out:?}");
        }
    }
}
