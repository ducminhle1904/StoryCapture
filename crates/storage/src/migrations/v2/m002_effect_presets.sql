-- Effect presets — user-defined or bundled. Scope 'project' lives in
-- project.sqlite, scope 'global' lives in app.sqlite (same schema in both
-- tiers; router logic is a call-site concern).

CREATE TABLE IF NOT EXISTS effect_presets (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('project', 'global')),
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    ast_json     TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 2,
    bundled      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    author       TEXT,
    tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_effect_presets_scope ON effect_presets(scope);
