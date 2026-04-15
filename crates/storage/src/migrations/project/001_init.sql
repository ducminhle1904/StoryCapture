CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    story_hash TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    command_json TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_session_ordinal ON steps(session_id, ordinal);

CREATE TABLE IF NOT EXISTS step_attempts (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    selector_strategy TEXT NOT NULL,
    selector_value TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    screenshot_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_step ON step_attempts(step_id);

CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_session ON exports(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
