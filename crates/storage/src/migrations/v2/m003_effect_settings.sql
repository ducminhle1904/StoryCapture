-- Per-story effect overrides on top of a chosen preset. `preset_id` is
-- nullable (no preset selected = pure overrides). No FK on story_id for the
-- same reason as m001.

CREATE TABLE IF NOT EXISTS effect_settings (
    story_id       TEXT PRIMARY KEY,
    preset_id      TEXT REFERENCES effect_presets(id) ON DELETE SET NULL,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    last_modified  INTEGER NOT NULL
);
