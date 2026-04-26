//! FFmpeg `-progress` parsers.
//!
//! Two parsers coexist in this module:
//!
//! - `ProgressParser` / `EncodeProgress` — the `-progress pipe:2` parser
//!   for the capture→encode recording pipeline (declared below).
//! - `RenderProgressParser` / `RenderProgress` — the render-queue parser
//!   driven fragment-by-fragment from FFmpeg `-progress pipe:1` output and
//!   keyed by `job_id`. Lives in the [`parser`] submodule.

pub mod parser;

pub use parser::{parse_line, ProgressFrag, RenderProgress, RenderProgressParser};

//
// `-progress pipe:2` parser (declared below)
// ------------------------------------------
//
// FFmpeg emits key=value lines, one per line, terminated by either
// `progress=continue` (a running update, emitted roughly every second)
// or `progress=end` (final flush). We accumulate key=value pairs
// between markers and emit one `EncodeProgress` per marker.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::ChildStderr;
use tokio::sync::mpsc;

use crate::error::{EncoderError, Result};

/// Cumulative progress snapshot. Values are "whatever FFmpeg last
/// reported" — frames is monotonic, out_time_ms is wall-clock encoded
/// time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EncodeProgress {
    pub frame: u64,
    pub fps: f32,
    pub bitrate_kbps: f32,
    pub out_time_ms: u64,
    pub drop_frames: u64,
    pub dup_frames: u64,
    pub speed: f32,
    /// True when FFmpeg emitted `progress=end` — i.e. the file has been
    /// finalized. The pipeline uses this to distinguish "still encoding"
    /// from "clean shutdown just happened".
    pub finished: bool,
}

pub struct ProgressParser {
    current: EncodeProgress,
    /// Stderr tail ring buffer — keeps the last ~2 KiB of stderr lines
    /// for `EncoderError::FfmpegExit { stderr_tail, .. }` diagnostics.
    stderr_tail: String,
}

impl ProgressParser {
    pub fn new() -> Self {
        ProgressParser {
            current: EncodeProgress::default(),
            stderr_tail: String::new(),
        }
    }

    pub fn stderr_tail(&self) -> &str {
        &self.stderr_tail
    }

    /// Feed a single stderr line and return a ready `EncodeProgress` if
    /// the line was a `progress=` marker (`continue` or `end`).
    pub fn feed_line(&mut self, line: &str) -> Option<EncodeProgress> {
        // Retain a rolling tail for diagnostics. Keep bounded at 2 KiB.
        self.stderr_tail.push_str(line);
        self.stderr_tail.push('\n');
        if self.stderr_tail.len() > 2048 {
            let overflow = self.stderr_tail.len() - 2048;
            // Drop from the front at a char boundary to avoid slicing UTF-8.
            let cut = self.stderr_tail[overflow..]
                .char_indices()
                .next()
                .map(|(i, _)| overflow + i)
                .unwrap_or(overflow);
            self.stderr_tail = self.stderr_tail[cut..].to_string();
        }

        let (key, value) = match line.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => return None,
        };

        match key {
            "frame" => {
                if let Ok(v) = value.parse::<u64>() {
                    self.current.frame = v;
                }
            }
            "fps" => {
                if let Ok(v) = value.parse::<f32>() {
                    self.current.fps = v;
                }
            }
            "bitrate" => {
                // FFmpeg emits e.g. `4589.2kbits/s` or `N/A`.
                if let Some(num) = value.strip_suffix("kbits/s") {
                    if let Ok(v) = num.trim().parse::<f32>() {
                        self.current.bitrate_kbps = v;
                    }
                }
            }
            "out_time_ms" => {
                // Despite the name, FFmpeg's `out_time_ms` is microseconds.
                if let Ok(v) = value.parse::<u64>() {
                    self.current.out_time_ms = v / 1000;
                }
            }
            "drop_frames" => {
                if let Ok(v) = value.parse::<u64>() {
                    self.current.drop_frames = v;
                }
            }
            "dup_frames" => {
                if let Ok(v) = value.parse::<u64>() {
                    self.current.dup_frames = v;
                }
            }
            "speed" => {
                if let Some(num) = value.strip_suffix('x') {
                    if let Ok(v) = num.trim().parse::<f32>() {
                        self.current.speed = v;
                    }
                }
            }
            "progress" => {
                let finished = value == "end";
                let mut snap = self.current.clone();
                snap.finished = finished;
                if finished {
                    self.current.finished = true;
                }
                return Some(snap);
            }
            _ => {}
        }
        None
    }

    /// Consume an FFmpeg child-process stderr stream and forward every
    /// progress marker to `tx`. Returns the final stderr tail when the
    /// stream closes (child exited or pipe was closed).
    pub async fn pump(
        mut self,
        stderr: ChildStderr,
        tx: mpsc::Sender<EncodeProgress>,
    ) -> Result<String> {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if let Some(p) = self.feed_line(&line) {
                        // Best-effort send; consumer may have dropped.
                        let _ = tx.send(p).await;
                    }
                }
                Ok(None) => break,
                Err(e) => return Err(EncoderError::Io(format!("stderr read: {e}"))),
            }
        }
        Ok(self.stderr_tail)
    }
}

impl Default for ProgressParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_continue_and_end() {
        let mut p = ProgressParser::new();
        assert!(p.feed_line("frame=42").is_none());
        assert!(p.feed_line("fps=30.0").is_none());
        assert!(p.feed_line("bitrate=4589.2kbits/s").is_none());
        assert!(p.feed_line("out_time_ms=5000000").is_none());
        assert!(p.feed_line("speed=1.02x").is_none());
        let cont = p.feed_line("progress=continue").expect("continue marker");
        assert_eq!(cont.frame, 42);
        assert!(!cont.finished);
        assert!((cont.fps - 30.0).abs() < 0.01);
        assert_eq!(cont.out_time_ms, 5000); // 5_000_000 us → 5000 ms

        let end = p.feed_line("progress=end").expect("end marker");
        assert!(end.finished);
    }

    #[test]
    fn stderr_tail_bounded() {
        let mut p = ProgressParser::new();
        for i in 0..1000 {
            p.feed_line(&format!("line{i}=xxxxxxxxxxxxxxxxxxxx"));
        }
        assert!(p.stderr_tail().len() <= 2048);
    }
}
