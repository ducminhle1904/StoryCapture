//! Phase 3 typed accessors over the v3 AI tables in `project.sqlite`.
//!
//! Callers (Wave 2 LLM orchestrator, Wave 3 TTS pipeline) pass a raw
//! `&rusqlite::Connection` borrowed from `ProjectDb`. Keeping this surface
//! connection-scoped (rather than wrapping `ProjectDb`) mirrors the v2
//! `repos/` convention and keeps the helpers usable from any future tier.
//!
//! Security:
//! - T-03-02-02 (path traversal): [`upsert_tts_cache`] rejects any
//!   `file_path` that is absolute, contains a `..` component, or does not
//!   start with the `voiceover/` prefix. This keeps cached audio strictly
//!   inside the project folder.
//! - T-03-02-01 (info disclosure): callers are responsible for never passing
//!   raw API keys or request headers into `content` / `token_usage_json`.
//!   The storage layer cannot enforce this — the `intelligence` crate's
//!   redaction layer (Plan 03-01) handles it at the tracing seam.

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

// ---------- Models ----------

#[derive(Debug, Clone)]
pub struct NlTurnInsert {
    pub id: Uuid,
    pub project_id: Uuid,
    pub turn_index: i64,
    pub role: String, // 'user' | 'assistant' | 'tool'
    pub content: String,
    pub tool_calls_json: Option<String>,
    pub llm_model: Option<String>,
    pub llm_provider: Option<String>,
    pub token_usage_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NlTurn {
    pub id: Uuid,
    pub project_id: Uuid,
    pub turn_index: i64,
    pub role: String,
    pub content: String,
    pub tool_calls_json: Option<String>,
    pub llm_model: Option<String>,
    pub llm_provider: Option<String>,
    pub token_usage_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct LlmTurnMetric {
    pub turn_id: String,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub first_token_ms: Option<i64>,
    pub total_ms: i64,
    pub cost_usd: f64,
    pub error_code: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct TtsClipMetric {
    pub clip_id: String,
    pub step_id: String,
    pub provider: String,
    pub model: String,
    pub voice_id: String,
    pub char_count: i64,
    pub audio_duration_ms: i64,
    pub step_duration_ms: i64,
    pub drift_ms: i64,
    pub cache_hit: i64,
    pub cost_usd: f64,
    pub first_chunk_ms: Option<i64>,
    pub error_code: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct TtsCacheEntry {
    pub hash: String,
    pub step_id: String,
    pub project_id: String,
    pub file_path: PathBuf,
    pub provider: String,
    pub model: String,
    pub voice_id: String,
    pub script_sha: String,
    pub byte_size: i64,
    pub created_at: i64,
    pub last_used_at: i64,
}

// ---------- Path guard (T-03-02-02) ----------

fn validate_voiceover_path(p: &Path) -> rusqlite::Result<()> {
    if p.is_absolute() {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "tts_cache_index.file_path must be relative, got {}",
            p.display()
        )));
    }
    for c in p.components() {
        match c {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "tts_cache_index.file_path may not contain '..' or root, got {}",
                    p.display()
                )));
            }
            _ => {}
        }
    }
    // Must begin with "voiceover/".
    let starts_ok = p
        .components()
        .next()
        .map(|c| matches!(c, Component::Normal(s) if s == "voiceover"))
        .unwrap_or(false);
    if !starts_ok {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "tts_cache_index.file_path must start with 'voiceover/', got {}",
            p.display()
        )));
    }
    Ok(())
}

// ---------- nl_conversations ----------

pub fn insert_nl_turn(conn: &Connection, turn: &NlTurnInsert) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO nl_conversations \
         (id, project_id, turn_index, role, content, tool_calls_json, \
          llm_model, llm_provider, token_usage_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            turn.id.to_string(),
            turn.project_id.to_string(),
            turn.turn_index,
            turn.role,
            turn.content,
            turn.tool_calls_json,
            turn.llm_model,
            turn.llm_provider,
            turn.token_usage_json,
            turn.created_at,
        ],
    )?;
    Ok(())
}

pub fn load_nl_history(conn: &Connection, project_id: &Uuid) -> rusqlite::Result<Vec<NlTurn>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, turn_index, role, content, tool_calls_json, \
                llm_model, llm_provider, token_usage_json, created_at \
         FROM nl_conversations \
         WHERE project_id = ?1 \
         ORDER BY turn_index ASC",
    )?;
    let rows = stmt
        .query_map(params![project_id.to_string()], |row| {
            let id_s: String = row.get(0)?;
            let pid_s: String = row.get(1)?;
            Ok(NlTurn {
                id: Uuid::parse_str(&id_s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                project_id: Uuid::parse_str(&pid_s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                turn_index: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                tool_calls_json: row.get(5)?,
                llm_model: row.get(6)?,
                llm_provider: row.get(7)?,
                token_usage_json: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------- llm_turn_metrics ----------

pub fn insert_llm_metric(conn: &Connection, m: &LlmTurnMetric) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO llm_turn_metrics \
         (turn_id, session_id, provider, model, input_tokens, output_tokens, \
          cache_read_tokens, cache_create_tokens, first_token_ms, total_ms, \
          cost_usd, error_code, timestamp) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            m.turn_id,
            m.session_id,
            m.provider,
            m.model,
            m.input_tokens,
            m.output_tokens,
            m.cache_read_tokens,
            m.cache_create_tokens,
            m.first_token_ms,
            m.total_ms,
            m.cost_usd,
            m.error_code,
            m.timestamp,
        ],
    )?;
    Ok(())
}

pub fn session_total_cost(conn: &Connection, session_id: &Uuid) -> rusqlite::Result<f64> {
    let total: Option<f64> = conn
        .query_row(
            "SELECT SUM(cost_usd) FROM llm_turn_metrics WHERE session_id = ?1",
            params![session_id.to_string()],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(total.unwrap_or(0.0))
}

// ---------- tts_clip_metrics ----------

pub fn insert_tts_metric(conn: &Connection, m: &TtsClipMetric) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tts_clip_metrics \
         (clip_id, step_id, provider, model, voice_id, char_count, \
          audio_duration_ms, step_duration_ms, drift_ms, cache_hit, \
          cost_usd, first_chunk_ms, error_code, timestamp) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            m.clip_id,
            m.step_id,
            m.provider,
            m.model,
            m.voice_id,
            m.char_count,
            m.audio_duration_ms,
            m.step_duration_ms,
            m.drift_ms,
            m.cache_hit,
            m.cost_usd,
            m.first_chunk_ms,
            m.error_code,
            m.timestamp,
        ],
    )?;
    Ok(())
}

// ---------- tts_cache_index ----------

pub fn upsert_tts_cache(conn: &Connection, entry: &TtsCacheEntry) -> rusqlite::Result<()> {
    validate_voiceover_path(&entry.file_path)?;
    let file_path_s = entry.file_path.to_string_lossy().to_string();
    // On hash collision, only last_used_at is touched — the audio content
    // addressed by `hash` is content-defined, so byte_size / file_path /
    // model etc. stay canonical from the first insert.
    conn.execute(
        "INSERT INTO tts_cache_index \
         (hash, step_id, project_id, file_path, provider, model, voice_id, \
          script_sha, byte_size, created_at, last_used_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(hash) DO UPDATE SET last_used_at = excluded.last_used_at",
        params![
            entry.hash,
            entry.step_id,
            entry.project_id,
            file_path_s,
            entry.provider,
            entry.model,
            entry.voice_id,
            entry.script_sha,
            entry.byte_size,
            entry.created_at,
            entry.last_used_at,
        ],
    )?;
    Ok(())
}

pub fn lookup_tts_cache(
    conn: &Connection,
    hash: &str,
) -> rusqlite::Result<Option<TtsCacheEntry>> {
    conn.query_row(
        "SELECT hash, step_id, project_id, file_path, provider, model, voice_id, \
                script_sha, byte_size, created_at, last_used_at \
         FROM tts_cache_index WHERE hash = ?1",
        params![hash],
        |row| {
            let file_path_s: String = row.get(3)?;
            Ok(TtsCacheEntry {
                hash: row.get(0)?,
                step_id: row.get(1)?,
                project_id: row.get(2)?,
                file_path: PathBuf::from(file_path_s),
                provider: row.get(4)?,
                model: row.get(5)?,
                voice_id: row.get(6)?,
                script_sha: row.get(7)?,
                byte_size: row.get(8)?,
                created_at: row.get(9)?,
                last_used_at: row.get(10)?,
            })
        },
    )
    .optional()
}

/// Delete cache rows whose `last_used_at < cutoff_ms` and invoke `delete_fn`
/// for each removed row's `file_path`. Returns the number of rows removed.
///
/// The delete closure lets callers plug in their own filesystem policy
/// (real `std::fs::remove_file`, a dry-run logger, or a test spy).
pub fn gc_tts_cache_older_than<F>(
    conn: &Connection,
    cutoff_ms: i64,
    mut delete_fn: F,
) -> rusqlite::Result<u64>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let mut stmt = conn.prepare(
        "SELECT hash, file_path FROM tts_cache_index WHERE last_used_at < ?1",
    )?;
    let victims: Vec<(String, PathBuf)> = stmt
        .query_map(params![cutoff_ms], |row| {
            let hash: String = row.get(0)?;
            let path_s: String = row.get(1)?;
            Ok((hash, PathBuf::from(path_s)))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut removed: u64 = 0;
    for (hash, path) in &victims {
        // File deletion is best-effort — if the file is already gone we
        // still want the index row gone. Unexpected FS errors bubble via
        // UserFunctionError so the caller can decide whether to abort.
        if let Err(e) = delete_fn(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(e)));
            }
        }
        let n = conn.execute(
            "DELETE FROM tts_cache_index WHERE hash = ?1",
            params![hash],
        )?;
        removed += n as u64;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_voiceover_path_accepts_relative_under_voiceover() {
        assert!(validate_voiceover_path(Path::new("voiceover/a.mp3")).is_ok());
        assert!(validate_voiceover_path(Path::new("voiceover/nested/a.mp3")).is_ok());
    }

    #[test]
    fn validate_voiceover_path_rejects_escape() {
        assert!(validate_voiceover_path(Path::new("/etc/passwd")).is_err());
        assert!(validate_voiceover_path(Path::new("voiceover/../x")).is_err());
        assert!(validate_voiceover_path(Path::new("../voiceover/x")).is_err());
        assert!(validate_voiceover_path(Path::new("other/x.mp3")).is_err());
    }
}
