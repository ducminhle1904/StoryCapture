//! v3 migration set. Contributes four `M::up` steps to `project.sqlite`
//! (no app-tier additions): nl_conversations, tts_cache_index,
//! llm_turn_metrics, and tts_clip_metrics + session_rollup view (bundled
//! with the last table).

use rusqlite_migration::M;

/// v3 migrations for `project.sqlite` — all 4 AI tables + 1 view.
pub fn project_migrations() -> Vec<M<'static>> {
    vec![
        M::up(include_str!("m001_nl_conversations.sql")),
        M::up(include_str!("m002_tts_cache_index.sql")),
        M::up(include_str!("m003_llm_turn_metrics.sql")),
        M::up(include_str!("m004_tts_clip_metrics.sql")),
        M::up(include_str!("m005_tts_cache_duration.sql")),
    ]
}
