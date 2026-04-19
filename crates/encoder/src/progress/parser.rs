//! Render-queue FFmpeg `-progress` parser (Plan 02-10).
//!
//! FFmpeg's `-progress <url>` flag emits one `key=value` per line,
//! terminated by `progress=continue` (rolling) or `progress=end` (final
//! flush). This module provides:
//!
//! - [`parse_line`] — stateless: maps a single line to a [`ProgressFrag`].
//! - [`RenderProgressParser`] — stateful accumulator that emits a
//!   [`RenderProgress`] snapshot (keyed by `job_id`, normalised to
//!   a progress percentage) every time FFmpeg closes a progress block.
//!
//! The render-queue actor (`queue::actor`) instantiates one parser per
//! spawned job and forwards emitted [`RenderProgress`] values over an
//! `mpsc::Sender<RenderProgress>` → the Tauri host's `stream_render_progress`
//! Channel. The pre-existing Phase 1 [`super::ProgressParser`] is NOT
//! replaced — the capture/encode recording pipeline still uses that shape.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Per-job progress snapshot streamed to the frontend.
///
/// `pct` is a percentage in `0.0..=100.0` derived from
/// `out_time_ms / total_duration_ms * 100`. `eta_ms` is a best-effort
/// estimate computed from `speed` and the remaining duration.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RenderProgress {
    pub job_id: Uuid,
    pub pct: f32,
    pub frame: u64,
    pub fps: f32,
    pub speed: f32,
    pub eta_ms: u64,
}

/// A single parsed fragment from one `key=value` progress line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProgressFrag {
    Frame(u64),
    Fps(f32),
    /// FFmpeg's `out_time_ms` is (confusingly) microseconds. The parser
    /// stores the raw reported value here — the caller is responsible
    /// for the `/1000` conversion when using it as ms.
    OutTimeMs(u64),
    Speed(f32),
    /// `progress=continue` marker — emit a rolling snapshot.
    Continue,
    /// `progress=end` marker — emit the final snapshot.
    End,
}

/// Parse a single `-progress` line to a fragment. Returns `None` for
/// lines we don't care about (or ill-formed values).
pub fn parse_line(line: &str) -> Option<ProgressFrag> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(v) = line.strip_prefix("out_time_ms=") {
        return v.trim().parse::<u64>().ok().map(ProgressFrag::OutTimeMs);
    }
    if let Some(v) = line.strip_prefix("speed=") {
        // FFmpeg emits `speed=2.34x` or `speed= N/A`.
        let v = v.trim().trim_end_matches('x');
        return v.parse::<f32>().ok().map(ProgressFrag::Speed);
    }
    if let Some(v) = line.strip_prefix("frame=") {
        return v.trim().parse::<u64>().ok().map(ProgressFrag::Frame);
    }
    if let Some(v) = line.strip_prefix("fps=") {
        return v.trim().parse::<f32>().ok().map(ProgressFrag::Fps);
    }
    if line.trim() == "progress=continue" {
        return Some(ProgressFrag::Continue);
    }
    if line.trim() == "progress=end" {
        return Some(ProgressFrag::End);
    }
    None
}

/// Stateful accumulator over `-progress` fragments.
#[derive(Debug)]
pub struct RenderProgressParser {
    job_id: Uuid,
    total_duration_ms: u64,
    frame: u64,
    fps: f32,
    out_time_ms: u64,
    speed: f32,
}

impl RenderProgressParser {
    pub fn new(job_id: Uuid, total_duration_ms: u64) -> Self {
        Self {
            job_id,
            total_duration_ms: total_duration_ms.max(1),
            frame: 0,
            fps: 0.0,
            out_time_ms: 0,
            speed: 0.0,
        }
    }

    /// Feed one `-progress` line. Returns a `RenderProgress` snapshot when
    /// a `progress=continue` or `progress=end` marker closes a block.
    pub fn feed_line(&mut self, line: &str) -> Option<RenderProgress> {
        let frag = parse_line(line)?;
        match frag {
            ProgressFrag::Frame(v) => {
                self.frame = v;
                None
            }
            ProgressFrag::Fps(v) => {
                self.fps = v;
                None
            }
            ProgressFrag::OutTimeMs(v) => {
                // FFmpeg reports microseconds despite the name.
                self.out_time_ms = v / 1000;
                None
            }
            ProgressFrag::Speed(v) => {
                self.speed = v;
                None
            }
            ProgressFrag::Continue => Some(self.snapshot(false)),
            ProgressFrag::End => {
                self.out_time_ms = self.total_duration_ms;
                Some(self.snapshot(true))
            }
        }
    }

    fn snapshot(&self, is_end: bool) -> RenderProgress {
        let pct = if is_end {
            100.0
        } else {
            ((self.out_time_ms as f64 / self.total_duration_ms as f64) * 100.0).clamp(0.0, 100.0)
                as f32
        };
        let remaining = self.total_duration_ms.saturating_sub(self.out_time_ms);
        let eta_ms = if self.speed > 0.01 {
            (remaining as f32 / self.speed) as u64
        } else {
            0
        };
        RenderProgress {
            job_id: self.job_id,
            pct,
            frame: self.frame,
            fps: self.fps,
            speed: self.speed,
            eta_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_progress_line_out_time() {
        assert_eq!(
            parse_line("out_time_ms=5000000"),
            Some(ProgressFrag::OutTimeMs(5_000_000))
        );
    }

    #[test]
    fn parse_progress_line_speed() {
        match parse_line("speed=2.34x").unwrap() {
            ProgressFrag::Speed(v) => assert!((v - 2.34).abs() < 1e-4),
            f => panic!("expected Speed, got {f:?}"),
        }
    }

    #[test]
    fn parse_progress_line_frame_and_fps() {
        assert_eq!(parse_line("frame=42"), Some(ProgressFrag::Frame(42)));
        match parse_line("fps=30.0").unwrap() {
            ProgressFrag::Fps(v) => assert!((v - 30.0).abs() < 1e-4),
            f => panic!("expected Fps, got {f:?}"),
        }
    }

    #[test]
    fn parse_progress_accumulates() {
        let job = Uuid::now_v7();
        let mut p = RenderProgressParser::new(job, 60_000);
        assert!(p.feed_line("frame=600").is_none());
        assert!(p.feed_line("fps=60.0").is_none());
        assert!(p.feed_line("out_time_ms=30000000").is_none()); // 30s in us
        assert!(p.feed_line("speed=2.0x").is_none());
        let snap = p.feed_line("progress=continue").expect("snap");
        assert_eq!(snap.job_id, job);
        assert_eq!(snap.frame, 600);
        assert!((snap.fps - 60.0).abs() < 1e-4);
        assert!((snap.speed - 2.0).abs() < 1e-4);
        // 30000ms / 60000ms = 50%
        assert!((snap.pct - 50.0).abs() < 0.01, "pct={}", snap.pct);
    }

    #[test]
    fn parse_progress_progress_end() {
        let job = Uuid::now_v7();
        let mut p = RenderProgressParser::new(job, 60_000);
        p.feed_line("out_time_ms=50000000");
        p.feed_line("speed=1.5x");
        let snap = p.feed_line("progress=end").expect("end");
        assert_eq!(snap.pct, 100.0);
    }

    #[test]
    fn ignores_unknown_lines() {
        assert!(parse_line("unknown=foo").is_none());
        assert!(parse_line("").is_none());
    }
}
