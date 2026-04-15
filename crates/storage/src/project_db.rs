//! Per-project `project.sqlite` — sessions, steps, attempts, exports, presets.

use crate::error::StorageError;
use crate::migrations::project as project_migrations;
use crate::models::{
    now_millis, Export, NewAttempt, NewExport, NewSession, NewStep, Preset, PresetScope, Session,
    SessionStatus, Step, StepAttempt, StepStatus,
};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const PROJECT_DB_FILENAME: &str = "project.sqlite";

pub struct ProjectDb {
    conn: Connection,
}

fn parse_uuid(s: &str) -> Result<Uuid, rusqlite::Error> {
    Uuid::parse_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

impl ProjectDb {
    /// Open `<folder>/project.sqlite`, running migrations on first open.
    pub fn open(folder: &Path) -> Result<Self, StorageError> {
        std::fs::create_dir_all(folder)?;
        let path = folder.join(PROJECT_DB_FILENAME);

        let mut conn = Connection::open(&path)?;

        // PRAGMA journal_mode = WAL
        // PRAGMA foreign_keys = ON
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let on_disk: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if on_disk > project_migrations::LATEST_VERSION {
            return Err(StorageError::SchemaVersionMismatch {
                expected: project_migrations::LATEST_VERSION,
                found: on_disk,
            });
        }

        project_migrations::migrations().to_latest(&mut conn)?;

        Ok(ProjectDb { conn })
    }

    // ---------- sessions ----------

    pub fn insert_session(&mut self, s: NewSession) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let started_at = now_millis();
        self.conn.execute(
            "INSERT INTO sessions (id, story_hash, started_at, ended_at, status, meta_json) \
             VALUES (?1, ?2, ?3, NULL, 'running', ?4)",
            params![id.to_string(), s.story_hash, started_at, s.meta_json],
        )?;
        Ok(id)
    }

    pub fn complete_session(
        &mut self,
        id: Uuid,
        status: SessionStatus,
    ) -> Result<(), StorageError> {
        let ended_at = now_millis();
        let n = self.conn.execute(
            "UPDATE sessions SET ended_at = ?1, status = ?2 WHERE id = ?3",
            params![ended_at, status.as_str(), id.to_string()],
        )?;
        if n == 0 {
            return Err(StorageError::NotFound(format!("session {id}")));
        }
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, story_hash, started_at, ended_at, status, meta_json \
             FROM sessions ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let status: String = row.get(4)?;
                Ok(Session {
                    id: parse_uuid(&id)?,
                    story_hash: row.get(1)?,
                    started_at: row.get(2)?,
                    ended_at: row.get(3)?,
                    status: SessionStatus::parse(&status).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
                    })?,
                    meta_json: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---------- steps ----------

    pub fn append_step(&mut self, session_id: Uuid, step: NewStep) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let started_at = now_millis();
        self.conn.execute(
            "INSERT INTO steps (id, session_id, ordinal, command_json, started_at, ended_at, status, error_message) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'running', NULL)",
            params![
                id.to_string(),
                session_id.to_string(),
                step.ordinal,
                step.command_json,
                started_at
            ],
        )?;
        Ok(id)
    }

    pub fn complete_step(
        &mut self,
        step_id: Uuid,
        status: StepStatus,
        error_message: Option<&str>,
    ) -> Result<(), StorageError> {
        let ended_at = now_millis();
        let n = self.conn.execute(
            "UPDATE steps SET ended_at = ?1, status = ?2, error_message = ?3 WHERE id = ?4",
            params![ended_at, status.as_str(), error_message, step_id.to_string()],
        )?;
        if n == 0 {
            return Err(StorageError::NotFound(format!("step {step_id}")));
        }
        Ok(())
    }

    pub fn list_steps(&self, session_id: Uuid) -> Result<Vec<Step>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, ordinal, command_json, started_at, ended_at, status, error_message \
             FROM steps WHERE session_id = ?1 ORDER BY ordinal ASC",
        )?;
        let rows = stmt
            .query_map(params![session_id.to_string()], |row| {
                let id: String = row.get(0)?;
                let session_id_s: String = row.get(1)?;
                let status: String = row.get(6)?;
                Ok(Step {
                    id: parse_uuid(&id)?,
                    session_id: parse_uuid(&session_id_s)?,
                    ordinal: row.get(2)?,
                    command_json: row.get(3)?,
                    started_at: row.get(4)?,
                    ended_at: row.get(5)?,
                    status: StepStatus::parse(&status).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
                    })?,
                    error_message: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---------- attempts ----------

    pub fn append_attempt(
        &mut self,
        step_id: Uuid,
        attempt: NewAttempt,
    ) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let attempted_at = now_millis();
        let screenshot_path = attempt
            .screenshot_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        self.conn.execute(
            "INSERT INTO step_attempts (id, step_id, selector_strategy, selector_value, attempted_at, outcome, screenshot_path) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id.to_string(),
                step_id.to_string(),
                attempt.selector_strategy,
                attempt.selector_value,
                attempted_at,
                attempt.outcome,
                screenshot_path,
            ],
        )?;
        Ok(id)
    }

    pub fn list_attempts(&self, step_id: Uuid) -> Result<Vec<StepAttempt>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, step_id, selector_strategy, selector_value, attempted_at, outcome, screenshot_path \
             FROM step_attempts WHERE step_id = ?1 ORDER BY attempted_at ASC",
        )?;
        let rows = stmt
            .query_map(params![step_id.to_string()], |row| {
                let id: String = row.get(0)?;
                let step_id_s: String = row.get(1)?;
                let screenshot_path: Option<String> = row.get(6)?;
                Ok(StepAttempt {
                    id: parse_uuid(&id)?,
                    step_id: parse_uuid(&step_id_s)?,
                    selector_strategy: row.get(2)?,
                    selector_value: row.get(3)?,
                    attempted_at: row.get(4)?,
                    outcome: row.get(5)?,
                    screenshot_path: screenshot_path.map(PathBuf::from),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---------- exports ----------

    pub fn insert_export(&mut self, e: NewExport) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let created_at = now_millis();
        let path_s = e.path.to_string_lossy().to_string();
        self.conn.execute(
            "INSERT INTO exports (id, session_id, format, path, size_bytes, duration_ms, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id.to_string(),
                e.session_id.to_string(),
                e.format,
                path_s,
                e.size_bytes as i64,
                e.duration_ms.map(|v| v as i64),
                created_at,
            ],
        )?;
        Ok(id)
    }

    pub fn list_exports(&self, session_id: Uuid) -> Result<Vec<Export>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, format, path, size_bytes, duration_ms, created_at \
             FROM exports WHERE session_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![session_id.to_string()], |row| {
                let id: String = row.get(0)?;
                let session_id_s: String = row.get(1)?;
                let path_s: String = row.get(3)?;
                let size_bytes: i64 = row.get(4)?;
                let duration_ms: Option<i64> = row.get(5)?;
                Ok(Export {
                    id: parse_uuid(&id)?,
                    session_id: parse_uuid(&session_id_s)?,
                    format: row.get(2)?,
                    path: PathBuf::from(path_s),
                    size_bytes: size_bytes as u64,
                    duration_ms: duration_ms.map(|v| v as u64),
                    created_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---------- presets ----------

    pub fn insert_preset(
        &mut self,
        name: &str,
        scope: PresetScope,
        config_json: &str,
    ) -> Result<Uuid, StorageError> {
        let id = Uuid::now_v7();
        let created_at = now_millis();
        self.conn.execute(
            "INSERT INTO presets (id, name, scope, config_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id.to_string(), name, scope.as_str(), config_json, created_at],
        )?;
        Ok(id)
    }

    pub fn list_presets(&self) -> Result<Vec<Preset>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, scope, config_json, created_at FROM presets ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let scope: String = row.get(2)?;
                Ok(Preset {
                    id: parse_uuid(&id)?,
                    name: row.get(1)?,
                    scope: PresetScope::parse(&scope).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
                    })?,
                    config_json: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn schema_version(&self) -> Result<u32, StorageError> {
        Ok(self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
    }
}
