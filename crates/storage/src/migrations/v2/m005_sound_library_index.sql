-- Sound library catalog. Actual audio files ship under assets/sound-library/
-- (Plan 08). This index is populated via sync_from_manifest().

CREATE TABLE IF NOT EXISTS sound_library_index (
    id              TEXT PRIMARY KEY,
    category        TEXT NOT NULL CHECK (category IN ('sfx','bgm')),
    name            TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    waveform_peaks  BLOB,
    license         TEXT NOT NULL,
    source_url      TEXT,
    author          TEXT,
    bundled         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sound_library_category ON sound_library_index(category);
