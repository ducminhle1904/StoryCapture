//! CRUD for `effect_presets`. Tier-agnostic: works on both project.sqlite and
//! app.sqlite connections (schema is identical).

use crate::error::StorageError;
use crate::models::{now_millis, EffectPreset, NewEffectPreset, PresetTier};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

fn parse_uuid(s: &str) -> Result<Uuid, rusqlite::Error> {
    Uuid::parse_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_to_preset(row: &rusqlite::Row<'_>) -> rusqlite::Result<EffectPreset> {
    let id: String = row.get(0)?;
    let scope: String = row.get(1)?;
    let tags_json: String = row.get(9)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let bundled: i64 = row.get(6)?;
    Ok(EffectPreset {
        id: parse_uuid(&id)?,
        scope: PresetTier::parse(&scope).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?,
        name: row.get(2)?,
        description: row.get(3)?,
        ast_json: row.get(4)?,
        version: row.get::<_, i64>(5)? as u32,
        bundled: bundled != 0,
        created_at: row.get(7)?,
        author: row.get(8)?,
        tags,
    })
}

const SELECT_COLS: &str =
    "id, scope, name, description, ast_json, version, bundled, created_at, author, tags_json";

pub fn list_by_scope(
    conn: &Connection,
    scope: PresetTier,
) -> Result<Vec<EffectPreset>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM effect_presets WHERE scope = ?1 ORDER BY bundled DESC, name ASC"
    ))?;
    let rows = stmt
        .query_map(params![scope.as_str()], row_to_preset)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<Option<EffectPreset>, StorageError> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM effect_presets WHERE id = ?1"),
            params![id.to_string()],
            row_to_preset,
        )
        .optional()?;
    Ok(row)
}

pub fn insert(conn: &Connection, p: &NewEffectPreset) -> Result<Uuid, StorageError> {
    let id = p.id.unwrap_or_else(Uuid::now_v7);
    let created_at = now_millis();
    let tags_json = serde_json::to_string(&p.tags)?;
    conn.execute(
        "INSERT INTO effect_presets (id, scope, name, description, ast_json, version, bundled, created_at, author, tags_json) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id.to_string(),
            p.scope.as_str(),
            p.name,
            p.description,
            p.ast_json,
            p.version as i64,
            if p.bundled { 1 } else { 0 },
            created_at,
            p.author,
            tags_json,
        ],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, p: &EffectPreset) -> Result<(), StorageError> {
    let tags_json = serde_json::to_string(&p.tags)?;
    let n = conn.execute(
        "UPDATE effect_presets \
         SET scope = ?2, name = ?3, description = ?4, ast_json = ?5, version = ?6, bundled = ?7, author = ?8, tags_json = ?9 \
         WHERE id = ?1",
        params![
            p.id.to_string(),
            p.scope.as_str(),
            p.name,
            p.description,
            p.ast_json,
            p.version as i64,
            if p.bundled { 1 } else { 0 },
            p.author,
            tags_json,
        ],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!("effect_preset {}", p.id)));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
    let n = conn.execute(
        "DELETE FROM effect_presets WHERE id = ?1",
        params![id.to_string()],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!("effect_preset {id}")));
    }
    Ok(())
}

/// Install every `.scpreset` JSON file found in `bundled_dir` into the given
/// scope. Uses INSERT OR IGNORE keyed on the file's embedded id so repeated
/// calls are idempotent. Returns the number of newly inserted rows.
pub fn install_bundled(
    conn: &Connection,
    scope: PresetTier,
    bundled_dir: &Path,
) -> Result<usize, StorageError> {
    if !bundled_dir.is_dir() {
        return Ok(0);
    }
    let mut installed = 0usize;
    for entry in std::fs::read_dir(bundled_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("scpreset") {
            continue;
        }
        let preset = crate::preset_io::import_preset(&path)?;
        let tags_json = serde_json::to_string(&preset.tags)?;
        let n = conn.execute(
            "INSERT OR IGNORE INTO effect_presets \
             (id, scope, name, description, ast_json, version, bundled, created_at, author, tags_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                preset.id.to_string(),
                scope.as_str(),
                preset.name,
                preset.description,
                preset.ast_json,
                preset.version as i64,
                if preset.bundled { 1 } else { 0 },
                preset.created_at,
                preset.author,
                tags_json,
            ],
        )?;
        installed += n;
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::project;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        project::migrations().to_latest(&mut c).unwrap();
        c
    }

    fn new_preset(name: &str) -> NewEffectPreset {
        NewEffectPreset {
            id: None,
            scope: PresetTier::Project,
            name: name.into(),
            description: "desc".into(),
            ast_json: r#"{"schema_version":2,"video":[],"audio":[]}"#.into(),
            version: 2,
            bundled: false,
            author: Some("test".into()),
            tags: vec!["t".into()],
        }
    }

    #[test]
    fn insert_list_get_update_delete() {
        let c = conn();
        let id = insert(&c, &new_preset("A")).unwrap();
        let _ = insert(&c, &new_preset("B")).unwrap();

        let list = list_by_scope(&c, PresetTier::Project).unwrap();
        assert_eq!(list.len(), 2);

        let mut p = get(&c, id).unwrap().unwrap();
        assert_eq!(p.name, "A");
        p.name = "A2".into();
        update(&c, &p).unwrap();
        assert_eq!(get(&c, id).unwrap().unwrap().name, "A2");

        delete(&c, id).unwrap();
        assert!(get(&c, id).unwrap().is_none());
    }

    #[test]
    fn insert_with_explicit_id_is_idempotent_via_or_ignore() {
        let c = conn();
        let fixed = Uuid::now_v7();
        let mut np = new_preset("Fixed");
        np.id = Some(fixed);
        let id1 = insert(&c, &np).unwrap();
        assert_eq!(id1, fixed);
    }
}
