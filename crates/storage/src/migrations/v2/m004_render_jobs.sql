-- Background render queue (D-04). Rows survive app restart so Plan 10 can
-- mark orphan 'running' jobs as 'interrupted' at startup and resume.

CREATE TABLE IF NOT EXISTS render_jobs (
    id            TEXT PRIMARY KEY,
    story_id      TEXT NOT NULL,
    preset_id     TEXT REFERENCES effect_presets(id) ON DELETE SET NULL,
    format        TEXT NOT NULL CHECK (format IN ('mp4','webm','gif')),
    resolution    TEXT NOT NULL CHECK (resolution IN ('720p','1080p','4k')),
    fps           INTEGER NOT NULL CHECK (fps IN (24,30,60)),
    quality       TEXT NOT NULL CHECK (quality IN ('low','med','high')),
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

CREATE INDEX IF NOT EXISTS idx_render_jobs_status   ON render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_priority ON render_jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_render_jobs_batch    ON render_jobs(batch_id);
