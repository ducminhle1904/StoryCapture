//! TTS voiceover-to-timeline sync engine (Plan 03-12, D-13).
//!
//! Pure function `compute_sync_plan` aligns TTS clip durations to DSL step
//! boundaries. TTS is ground truth:
//!
//! - **Clip longer than step**: step duration extends with freeze frame.
//! - **Clip shorter than step**: step duration unchanged; silence padding
//!   appended to clip.
//!
//! For every clip, a `DuckEvent` is emitted for the Phase 2 BGM mixer
//! to lower BGM by -12 dB during narration.
//!
//! Drift p95 target: <= 150 ms (AI-SPEC E7).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Original step duration from Phase 1 capture / Phase 2 effects AST.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepTiming {
    pub step_id: String,
    pub original_duration_ms: u64,
}

/// Metadata for a single TTS clip matched to a step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipMeta {
    pub step_id: String,
    pub audio_duration_ms: u64,
    pub file_path: PathBuf,
}

/// The full sync plan: adjusted step durations + BGM duck events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPlan {
    pub adjusted_steps: Vec<AdjustedStep>,
    pub duck_events: Vec<DuckEvent>,
}

/// Per-step adjusted timing after TTS sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdjustedStep {
    pub step_id: String,
    /// New duration after TTS alignment (max of original and clip).
    pub new_duration_ms: u64,
    /// > 0 if TTS clip is longer than the original step duration.
    pub freeze_frame_extension_ms: u64,
    /// > 0 if TTS clip is shorter than the original step duration.
    pub silence_padding_ms: u64,
    /// Clip start offset in step-local time (usually 0).
    pub clip_start_ms: u64,
    /// audio_duration - original_duration (signed).
    pub drift_ms: i64,
}

/// BGM auto-duck event for the Phase 2 sound mixer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuckEvent {
    /// Timeline-global start in milliseconds.
    pub start_ms: u64,
    /// Timeline-global end in milliseconds.
    pub end_ms: u64,
    /// Volume reduction in dB (typically -12.0).
    pub db: f32,
}

/// BGM duck level in dB during narration.
const DUCK_DB: f32 = -12.0;

/// Compute a timeline sync plan from DSL steps and TTS clips.
///
/// For each step:
/// - If a matching clip exists and is **longer** than the step, the step
///   duration extends to match the clip (freeze frame fills the gap).
/// - If a matching clip exists and is **shorter**, the step keeps its
///   original duration (silence padding fills the audio gap).
/// - If no clip matches the step, the step is unchanged.
///
/// Duck events are emitted for every clip with timeline-global timestamps
/// derived from the cumulative adjusted durations (not original durations).
pub fn compute_sync_plan(steps: &[StepTiming], clips: &[ClipMeta]) -> SyncPlan {
    let clip_by_id: HashMap<&str, &ClipMeta> =
        clips.iter().map(|c| (c.step_id.as_str(), c)).collect();

    let mut adjusted = Vec::with_capacity(steps.len());
    let mut ducks = Vec::new();
    let mut timeline_cursor_ms: u64 = 0;

    for s in steps {
        match clip_by_id.get(s.step_id.as_str()) {
            Some(c) => {
                let (new_dur, freeze, silence) =
                    if c.audio_duration_ms > s.original_duration_ms {
                        let extra = c.audio_duration_ms - s.original_duration_ms;
                        (c.audio_duration_ms, extra, 0)
                    } else {
                        let gap = s.original_duration_ms - c.audio_duration_ms;
                        (s.original_duration_ms, 0, gap)
                    };

                let drift = c.audio_duration_ms as i64 - s.original_duration_ms as i64;

                adjusted.push(AdjustedStep {
                    step_id: s.step_id.clone(),
                    new_duration_ms: new_dur,
                    freeze_frame_extension_ms: freeze,
                    silence_padding_ms: silence,
                    clip_start_ms: 0,
                    drift_ms: drift,
                });

                ducks.push(DuckEvent {
                    start_ms: timeline_cursor_ms,
                    end_ms: timeline_cursor_ms + c.audio_duration_ms,
                    db: DUCK_DB,
                });

                timeline_cursor_ms += new_dur;
            }
            None => {
                adjusted.push(AdjustedStep {
                    step_id: s.step_id.clone(),
                    new_duration_ms: s.original_duration_ms,
                    freeze_frame_extension_ms: 0,
                    silence_padding_ms: 0,
                    clip_start_ms: 0,
                    drift_ms: 0,
                });
                timeline_cursor_ms += s.original_duration_ms;
            }
        }
    }

    SyncPlan {
        adjusted_steps: adjusted,
        duck_events: ducks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_duration_produces_zero_drift() {
        let steps = vec![StepTiming {
            step_id: "s1".to_string(),
            original_duration_ms: 2000,
        }];
        let clips = vec![ClipMeta {
            step_id: "s1".to_string(),
            audio_duration_ms: 2000,
            file_path: PathBuf::from("voiceover/s1.mp3"),
        }];
        let plan = compute_sync_plan(&steps, &clips);
        assert_eq!(plan.adjusted_steps[0].drift_ms, 0);
        assert_eq!(plan.adjusted_steps[0].freeze_frame_extension_ms, 0);
        assert_eq!(plan.adjusted_steps[0].silence_padding_ms, 0);
    }

    #[test]
    fn duck_event_db_is_minus_12() {
        let steps = vec![StepTiming {
            step_id: "s1".to_string(),
            original_duration_ms: 1000,
        }];
        let clips = vec![ClipMeta {
            step_id: "s1".to_string(),
            audio_duration_ms: 1000,
            file_path: PathBuf::from("voiceover/s1.mp3"),
        }];
        let plan = compute_sync_plan(&steps, &clips);
        assert_eq!(plan.duck_events[0].db, -12.0);
    }

    #[test]
    fn no_steps_produces_empty_plan() {
        let plan = compute_sync_plan(&[], &[]);
        assert!(plan.adjusted_steps.is_empty());
        assert!(plan.duck_events.is_empty());
    }
}
