-- Add duration_ms to tts_cache_index so cache hits can return duration
-- without re-reading the MP3 file from disk.
ALTER TABLE tts_cache_index ADD COLUMN duration_ms INTEGER;
