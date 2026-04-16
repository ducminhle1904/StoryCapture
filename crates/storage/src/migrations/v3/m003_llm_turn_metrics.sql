-- Phase 3 Plan 02 — LLM turn metrics (AI-SPEC §7.2).
CREATE TABLE llm_turn_metrics (
    turn_id             TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER NOT NULL,
    output_tokens       INTEGER NOT NULL,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    first_token_ms      INTEGER,
    total_ms            INTEGER NOT NULL,
    cost_usd            REAL NOT NULL,
    error_code          TEXT,
    timestamp           INTEGER NOT NULL
);
CREATE INDEX idx_llm_turn_session ON llm_turn_metrics(session_id, timestamp);
