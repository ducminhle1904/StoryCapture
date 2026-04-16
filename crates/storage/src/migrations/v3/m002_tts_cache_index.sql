-- Phase 3 Plan 02 — TTS audio cache index (D-14).
--
-- `hash` is sha256(provider + model + voice_id + script_text) and is the
-- cache key. `file_path` MUST be a project-relative path beginning with
-- `voiceover/` — the `upsert_tts_cache` helper enforces this at insert time
-- (T-03-02-02 path-traversal mitigation).
CREATE TABLE tts_cache_index (
    hash          TEXT PRIMARY KEY,
    step_id       TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    voice_id      TEXT NOT NULL,
    script_sha    TEXT NOT NULL,
    byte_size     INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL
);
CREATE INDEX idx_tts_cache_project   ON tts_cache_index(project_id);
CREATE INDEX idx_tts_cache_last_used ON tts_cache_index(last_used_at);
