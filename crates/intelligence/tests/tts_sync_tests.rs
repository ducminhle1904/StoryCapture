//! TTS voiceover-to-timeline sync engine tests (Plan 03-12).
//!
//! Tests the pure function `compute_sync_plan` which aligns TTS clip
//! durations to DSL step boundaries per D-13.

use intelligence::tts::sync::{compute_sync_plan, ClipMeta, StepTiming};
use std::path::PathBuf;

/// Test 1: Clip longer than step -> extend step with freeze frame.
#[test]
fn clip_longer_extends_step_with_freeze_frame() {
    let steps = vec![StepTiming {
        step_id: "s1".to_string(),
        original_duration_ms: 2000,
    }];
    let clips = vec![ClipMeta {
        step_id: "s1".to_string(),
        audio_duration_ms: 2500,
        file_path: PathBuf::from("voiceover/s1.mp3"),
    }];

    let plan = compute_sync_plan(&steps, &clips);

    assert_eq!(plan.adjusted_steps.len(), 1);
    let adj = &plan.adjusted_steps[0];
    assert_eq!(adj.new_duration_ms, 2500);
    assert_eq!(adj.freeze_frame_extension_ms, 500);
    assert_eq!(adj.silence_padding_ms, 0);
    assert_eq!(adj.drift_ms, 500);

    // Should have one duck event
    assert_eq!(plan.duck_events.len(), 1);
    assert_eq!(plan.duck_events[0].start_ms, 0);
    assert_eq!(plan.duck_events[0].end_ms, 2500);
    assert_eq!(plan.duck_events[0].db, -12.0);
}

/// Test 2: Clip shorter than step -> pad silence.
#[test]
fn clip_shorter_pads_silence() {
    let steps = vec![StepTiming {
        step_id: "s1".to_string(),
        original_duration_ms: 3000,
    }];
    let clips = vec![ClipMeta {
        step_id: "s1".to_string(),
        audio_duration_ms: 2200,
        file_path: PathBuf::from("voiceover/s1.mp3"),
    }];

    let plan = compute_sync_plan(&steps, &clips);

    assert_eq!(plan.adjusted_steps.len(), 1);
    let adj = &plan.adjusted_steps[0];
    assert_eq!(adj.new_duration_ms, 3000);
    assert_eq!(adj.freeze_frame_extension_ms, 0);
    assert_eq!(adj.silence_padding_ms, 800);
    assert_eq!(adj.drift_ms, -800);
}

/// Test 3: No clip for step -> unchanged duration, no duck event.
#[test]
fn no_clip_for_step_is_unchanged() {
    let steps = vec![StepTiming {
        step_id: "s1".to_string(),
        original_duration_ms: 1500,
    }];
    let clips: Vec<ClipMeta> = vec![];

    let plan = compute_sync_plan(&steps, &clips);

    assert_eq!(plan.adjusted_steps.len(), 1);
    let adj = &plan.adjusted_steps[0];
    assert_eq!(adj.new_duration_ms, 1500);
    assert_eq!(adj.freeze_frame_extension_ms, 0);
    assert_eq!(adj.silence_padding_ms, 0);
    assert_eq!(adj.drift_ms, 0);
    assert_eq!(plan.duck_events.len(), 0);
}

/// Test 4: Cumulative timeline - duck_events use adjusted durations.
#[test]
fn cumulative_timeline_duck_events_use_adjusted_durations() {
    let steps = vec![
        StepTiming {
            step_id: "s1".to_string(),
            original_duration_ms: 1000,
        },
        StepTiming {
            step_id: "s2".to_string(),
            original_duration_ms: 2000,
        },
        StepTiming {
            step_id: "s3".to_string(),
            original_duration_ms: 1500,
        },
    ];
    let clips = vec![
        ClipMeta {
            step_id: "s1".to_string(),
            audio_duration_ms: 1200,
            file_path: PathBuf::from("voiceover/s1.mp3"),
        },
        ClipMeta {
            step_id: "s2".to_string(),
            audio_duration_ms: 1800,
            file_path: PathBuf::from("voiceover/s2.mp3"),
        },
        ClipMeta {
            step_id: "s3".to_string(),
            audio_duration_ms: 1700,
            file_path: PathBuf::from("voiceover/s3.mp3"),
        },
    ];

    let plan = compute_sync_plan(&steps, &clips);

    assert_eq!(plan.adjusted_steps.len(), 3);
    assert_eq!(plan.duck_events.len(), 3);

    // Step 1: clip 1200 > step 1000 -> new_dur = 1200, freeze = 200
    assert_eq!(plan.adjusted_steps[0].new_duration_ms, 1200);
    assert_eq!(plan.adjusted_steps[0].freeze_frame_extension_ms, 200);

    // Step 2: clip 1800 < step 2000 -> new_dur = 2000, silence = 200
    assert_eq!(plan.adjusted_steps[1].new_duration_ms, 2000);
    assert_eq!(plan.adjusted_steps[1].silence_padding_ms, 200);

    // Step 3: clip 1700 > step 1500 -> new_dur = 1700, freeze = 200
    assert_eq!(plan.adjusted_steps[2].new_duration_ms, 1700);
    assert_eq!(plan.adjusted_steps[2].freeze_frame_extension_ms, 200);

    // Duck event start_ms should be based on cumulative adjusted durations.
    // duck[0]: start=0, end=1200 (clip1 audio dur)
    assert_eq!(plan.duck_events[0].start_ms, 0);
    assert_eq!(plan.duck_events[0].end_ms, 1200);

    // duck[1]: start=1200 (adjusted s1=1200), end=1200+1800=3000
    assert_eq!(plan.duck_events[1].start_ms, 1200);
    assert_eq!(plan.duck_events[1].end_ms, 1200 + 1800);

    // duck[2]: start=1200+2000=3200 (adjusted s2=2000), end=3200+1700=4900
    assert_eq!(plan.duck_events[2].start_ms, 3200);
    assert_eq!(plan.duck_events[2].end_ms, 3200 + 1700);

    // All duck events at -12dB
    for d in &plan.duck_events {
        assert_eq!(d.db, -12.0);
    }
}

/// Test 5: Drift p95 <= 150ms property test.
///
/// Generate 20 (step, clip) pairs where |clip - step| <= 150ms.
/// After compute_sync_plan, the |drift_ms| p95 should be <= 150.
#[test]
fn drift_p95_leq_150ms() {
    use rand::rngs::StdRng;
    use rand::{Rng, SeedableRng};

    let mut rng = StdRng::seed_from_u64(42);
    let n = 20;

    let mut steps = Vec::with_capacity(n);
    let mut clips = Vec::with_capacity(n);

    for i in 0..n {
        let base_dur: u64 = rng.gen_range(1000..5000);
        // |clip - step| <= 150ms
        let delta: i64 = rng.gen_range(-150..=150);
        let clip_dur = (base_dur as i64 + delta).max(100) as u64;

        let step_id = format!("step-{i}");
        steps.push(StepTiming {
            step_id: step_id.clone(),
            original_duration_ms: base_dur,
        });
        clips.push(ClipMeta {
            step_id,
            audio_duration_ms: clip_dur,
            file_path: PathBuf::from(format!("voiceover/step-{i}.mp3")),
        });
    }

    let plan = compute_sync_plan(&steps, &clips);

    // Collect absolute drift values
    let mut drifts: Vec<i64> = plan
        .adjusted_steps
        .iter()
        .map(|a| a.drift_ms.abs())
        .collect();
    drifts.sort();

    // p95 index: ceil(0.95 * n) - 1
    let p95_idx = ((0.95 * n as f64).ceil() as usize).min(n) - 1;
    let p95_drift = drifts[p95_idx];

    assert!(
        p95_drift <= 150,
        "drift p95 should be <= 150ms, got {p95_drift}ms"
    );
}
