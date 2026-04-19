//! Global `app.sqlite` — projects index + app settings.

use crate::error::StorageError;
use crate::migrations::app as app_migrations;
use crate::models::{now_millis, NewProject, Project};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Handle to the global app database. Owns its `rusqlite::Connection`.
pub struct AppDb {
    conn: Connection,
}

impl AppDb {
    /// Open (or create) the global app db at `path`. Runs any pending
    /// migrations to_latest. Returns `SchemaVersionMismatch` if the on-disk
    /// `user_version` is HIGHER than the supported latest (newer DB than the
    /// running app — refuse to write rather than risk corruption).
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let mut conn = Connection::open(path)?;

        // Pragmas — set on every connection.
        // PRAGMA journal_mode = WAL
        // PRAGMA foreign_keys = ON
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        // Detect newer-than-supported schema BEFORE running migrations.
        let on_disk: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if on_disk > app_migrations::LATEST_VERSION {
            return Err(StorageError::SchemaVersionMismatch {
                expected: app_migrations::LATEST_VERSION,
                found: on_disk,
            });
        }

        app_migrations::migrations().to_latest(&mut conn)?;

        Ok(AppDb { conn })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, folder_path, created_at, last_opened_at, thumbnail_path \
             FROM projects \
             ORDER BY (last_opened_at IS NULL) ASC, last_opened_at DESC, created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let folder_path: String = row.get(2)?;
                let thumbnail_path: Option<String> = row.get(5)?;
                Ok(Project {
                    id: Uuid::parse_str(&id).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    name: row.get(1)?,
                    folder_path: PathBuf::from(folder_path),
                    created_at: row.get(3)?,
                    last_opened_at: row.get(4)?,
                    thumbnail_path: thumbnail_path.map(PathBuf::from),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn insert_project(&mut self, p: NewProject) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let created_at = now_millis();
        let folder_path = p.folder_path.to_string_lossy().to_string();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO projects (id, name, folder_path, created_at, last_opened_at, thumbnail_path) \
             VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
            params![id.to_string(), p.name, folder_path, created_at],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn touch_project(&mut self, id: Uuid) -> Result<(), StorageError> {
        let now = now_millis();
        let n = self.conn.execute(
            "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
            params![now, id.to_string()],
        )?;
        if n == 0 {
            return Err(StorageError::NotFound(format!("project {id}")));
        }
        Ok(())
    }

    pub fn remove_project(&mut self, id: Uuid) -> Result<(), StorageError> {
        let n = self.conn.execute(
            "DELETE FROM projects WHERE id = ?1",
            params![id.to_string()],
        )?;
        if n == 0 {
            return Err(StorageError::NotFound(format!("project {id}")));
        }
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, StorageError> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(v)
    }

    pub fn set_setting(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )?;
        Ok(())
    }

    /// Test/debug accessor: report on-disk user_version.
    pub fn schema_version(&self) -> Result<u32, StorageError> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))?)
    }
}
