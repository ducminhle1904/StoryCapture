CREATE TABLE IF NOT EXISTS render_jobs_new (
    id            TEXT PRIMARY KEY,
    story_id      TEXT NOT NULL,
    preset_id     TEXT REFERENCES effect_presets(id) ON DELETE SET NULL,
    format        TEXT NOT NULL CHECK (format IN ('mp4','webm','gif')),
    resolution    TEXT NOT NULL CHECK (resolution IN ('match-source','720p','1080p','4k') OR resolution GLOB 'custom:[0-9]*x[0-9]*'),
    output_width  INTEGER,
    output_height INTEGER,
    fps           INTEGER NOT NULL CHECK (fps IN (24,30,60)),
    quality       TEXT NOT NULL CHECK (quality IN ('low','med','high')),
    encoder_options_json TEXT,
    status        TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled','interrupted')),
    progress_pct  REAL NOT NULL DEFAULT 0.0,
    started_at    INTEGER,
    completed_at  INTEGER,
    error         TEXT,
    priority      INTEGER NOT NULL DEFAULT 0,
    output_path   TEXT,
    batch_id      TEXT,
    created_at    INTEGER NOT NULL
);

INSERT INTO render_jobs_new (
    id, story_id, preset_id, format, resolution, output_width, output_height,
    fps, quality, encoder_options_json, status, progress_pct, started_at,
    completed_at, error, priority, output_path, batch_id, created_at
)
SELECT
    id,
    story_id,
    preset_id,
    format,
    resolution,
    CASE resolution
        WHEN '720p' THEN 1280
        WHEN '1080p' THEN 1920
        WHEN '4k' THEN 3840
        ELSE NULL
    END,
    CASE resolution
        WHEN '720p' THEN 720
        WHEN '1080p' THEN 1080
        WHEN '4k' THEN 2160
        ELSE NULL
    END,
    fps,
    quality,
    NULL,
    status,
    progress_pct,
    started_at,
    completed_at,
    error,
    priority,
    output_path,
    batch_id,
    created_at
FROM render_jobs;

DROP TABLE render_jobs;
ALTER TABLE render_jobs_new RENAME TO render_jobs;

CREATE INDEX IF NOT EXISTS idx_render_jobs_status   ON render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_priority ON render_jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_render_jobs_batch    ON render_jobs(batch_id);
