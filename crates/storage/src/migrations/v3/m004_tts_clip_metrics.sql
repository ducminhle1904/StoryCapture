-- Phase 3 Plan 02 — TTS clip metrics (AI-SPEC §7.2) + session rollup view.
--
-- The view is created in the same migration as the final metrics table so the
-- v3 bundle contributes exactly 4 migrations (total user_version = 10).
CREATE TABLE tts_clip_metrics (
    clip_id           TEXT PRIMARY KEY,
    step_id           TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    voice_id          TEXT NOT NULL,
    char_count        INTEGER NOT NULL,
    audio_duration_ms INTEGER NOT NULL,
    step_duration_ms  INTEGER NOT NULL,
    drift_ms          INTEGER NOT NULL,
    cache_hit         INTEGER NOT NULL,
    cost_usd          REAL NOT NULL,
    first_chunk_ms    INTEGER,
    error_code        TEXT,
    timestamp         INTEGER NOT NULL
);
CREATE INDEX idx_tts_clip_step ON tts_clip_metrics(step_id, timestamp);

-- Session rollup view — cost + token + latency aggregates per session.
CREATE VIEW session_rollup AS
SELECT
    session_id,
    COUNT(*)                          AS turn_count,
    SUM(cost_usd)                     AS total_cost_usd,
    SUM(input_tokens + output_tokens) AS total_tokens,
    AVG(first_token_ms)               AS avg_first_token_ms,
    MAX(timestamp)                    AS last_turn_at
FROM llm_turn_metrics
GROUP BY session_id;
