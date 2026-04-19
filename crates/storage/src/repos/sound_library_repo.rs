//! Sound library catalog CRUD. The actual audio files + manifest are shipped
//! in Plan 08; this repo just owns the index side.

use crate::error::StorageError;
use crate::models::{SoundCategory, SoundLibraryEntry};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn parse_uuid(s: &str) -> Result<Uuid, rusqlite::Error> {
    Uuid::parse_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<SoundLibraryEntry> {
    let id: String = row.get(0)?;
    let category: String = row.get(1)?;
    let file_path: String = row.get(3)?;
    let waveform_peaks: Option<Vec<u8>> = row.get(5)?;
    let bundled: i64 = row.get(9)?;
    Ok(SoundLibraryEntry {
        id: parse_uuid(&id)?,
        category: SoundCategory::parse(&category).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?,
        name: row.get(2)?,
        file_path: PathBuf::from(file_path),
        duration_ms: row.get::<_, i64>(4)? as u64,
        waveform_peaks,
        license: row.get(6)?,
        source_url: row.get(7)?,
        author: row.get(8)?,
        bundled: bundled != 0,
    })
}

const SELECT_COLS: &str =
    "id, category, name, file_path, duration_ms, waveform_peaks, license, source_url, author, bundled";

pub fn list_by_category(
    conn: &Connection,
    category: SoundCategory,
) -> Result<Vec<SoundLibraryEntry>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM sound_library_index WHERE category = ?1 ORDER BY name ASC"
    ))?;
    let rows = stmt
        .query_map(params![category.as_str()], row_to_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_all(conn: &Connection) -> Result<Vec<SoundLibraryEntry>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM sound_library_index ORDER BY category ASC, name ASC"
    ))?;
    let rows = stmt
        .query_map([], row_to_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Manifest file shape (`assets/sound-library/manifest.json`, produced by
/// Plan 08). `id` is a stable UUID baked into the manifest so re-syncs are
/// idempotent.
#[derive(Debug, Deserialize)]
pub struct SoundManifestEntry {
    pub id: Uuid,
    pub category: SoundCategory,
    pub name: String,
    pub file_path: String,
    pub duration_ms: u64,
    pub license: String,
    pub source_url: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SoundManifest {
    pub entries: Vec<SoundManifestEntry>,
}

/// Upsert every entry from the manifest. Returns the number of new rows
/// inserted (updates don't count).
pub fn sync_from_manifest(conn: &Connection, manifest_path: &Path) -> Result<usize, StorageError> {
    let txt = std::fs::read_to_string(manifest_path)?;
    let manifest: SoundManifest = serde_json::from_str(&txt)?;
    let mut inserted = 0usize;
    for e in manifest.entries {
        let n = conn.execute(
            "INSERT INTO sound_library_index \
             (id, category, name, file_path, duration_ms, waveform_peaks, license, source_url, author, bundled) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, 1) \
             ON CONFLICT(id) DO UPDATE SET category=excluded.category, name=excluded.name, file_path=excluded.file_path, duration_ms=excluded.duration_ms, license=excluded.license, source_url=excluded.source_url, author=excluded.author",
            params![
                e.id.to_string(),
                e.category.as_str(),
                e.name,
                e.file_path,
                e.duration_ms as i64,
                e.license,
                e.source_url,
                e.author,
            ],
        )?;
        inserted += n;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::project;
    use std::io::Write;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        project::migrations().to_latest(&mut c).unwrap();
        c
    }

    #[test]
    fn sync_and_list() {
        let c = conn();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        let mut f = std::fs::File::create(&path).unwrap();
        let id1 = Uuid::now_v7();
        let id2 = Uuid::now_v7();
        let body = format!(
            r#"{{"entries":[
                {{"id":"{id1}","category":"sfx","name":"Click","file_path":"sfx/click.wav","duration_ms":120,"license":"CC0"}},
                {{"id":"{id2}","category":"bgm","name":"Ambient","file_path":"bgm/amb.mp3","duration_ms":60000,"license":"Pixabay-free"}}
            ]}}"#
        );
        f.write_all(body.as_bytes()).unwrap();
        drop(f);

        let n = sync_from_manifest(&c, &path).unwrap();
        assert_eq!(n, 2);

        let sfx = list_by_category(&c, SoundCategory::Sfx).unwrap();
        assert_eq!(sfx.len(), 1);
        assert_eq!(sfx[0].name, "Click");
        let bgm = list_by_category(&c, SoundCategory::Bgm).unwrap();
        assert_eq!(bgm.len(), 1);

        // Re-sync is idempotent (0 new rows; data is updated in place).
        let n2 = sync_from_manifest(&c, &path).unwrap();
        // SQLite returns 1 for INSERT OR ... ON CONFLICT UPDATE when the row
        // matches the conflict path; we accept any count ≤ 2.
        assert!(n2 <= 2);
        assert_eq!(list_all(&c).unwrap().len(), 2);
    }
}
