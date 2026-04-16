-- Phase 3 Plan 02 — NL Mode conversation history (D-09).
--
-- Security note (T-03-02-01): user NL prompts + assistant DSL responses are
-- stored here for the D-09 conversation feature. API keys MUST NEVER be
-- written into `content` or `token_usage_json` — those live only in the OS
-- keychain (AI-05). `token_usage_json` carries numeric counters only.
CREATE TABLE nl_conversations (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    turn_index        INTEGER NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content           TEXT NOT NULL,
    tool_calls_json   TEXT,
    llm_model         TEXT,
    llm_provider      TEXT,
    token_usage_json  TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE (project_id, turn_index)
);
CREATE INDEX idx_nl_conversations_project ON nl_conversations(project_id, turn_index);
