-- Timeline layout snapshot per story. `story_id` is an opaque TEXT identifier
-- chosen by the caller (UUID, session id, or a future stories.id FK) — this
-- migration does NOT add a FK because Phase 1 has no `stories` table; the
-- constraint will be added in a later migration once the stories table exists.

CREATE TABLE IF NOT EXISTS timeline_state (
    story_id      TEXT PRIMARY KEY,
    layout_json   TEXT NOT NULL,
    last_modified INTEGER NOT NULL
);
