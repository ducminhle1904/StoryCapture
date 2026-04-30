// Sound library Tauri commands.
//
// Wraps `storage::repos::sound_library_repo::list_by_category` so the
// Post-Production editor's Sound panel can enumerate SFX / BGM entries.

use serde::{Deserialize, Serialize};
use storage::repos::sound_library_repo;
use storage::{SoundCategory, SoundLibraryEntry};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SoundCategoryDto {
    Sfx,
    Bgm,
}

impl From<SoundCategoryDto> for SoundCategory {
    fn from(c: SoundCategoryDto) -> Self {
        match c {
            SoundCategoryDto::Sfx => SoundCategory::Sfx,
            SoundCategoryDto::Bgm => SoundCategory::Bgm,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SoundLibraryEntryDto {
    pub id: String,
    /// "sfx" | "bgm"
    pub category: String,
    pub name: String,
    pub file_path: String,
    pub duration_ms: u64,
    pub license: String,
    pub source_url: Option<String>,
    pub author: Option<String>,
    pub bundled: bool,
}

impl From<SoundLibraryEntry> for SoundLibraryEntryDto {
    fn from(e: SoundLibraryEntry) -> Self {
        Self {
            id: e.id.to_string(),
            category: e.category.as_str().to_string(),
            name: e.name,
            file_path: e.file_path.display().to_string(),
            duration_ms: e.duration_ms,
            license: e.license,
            source_url: e.source_url,
            author: e.author,
            bundled: e.bundled,
        }
    }
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "sound_library_list"),
    err(Debug)
)]
pub async fn sound_library_list(
    state: State<'_, AppState>,
    category: SoundCategoryDto,
) -> Result<Vec<SoundLibraryEntryDto>, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let rows = sound_library_repo::list_by_category(&conn, category.into())?;
    Ok(rows.into_iter().map(Into::into).collect())
}
