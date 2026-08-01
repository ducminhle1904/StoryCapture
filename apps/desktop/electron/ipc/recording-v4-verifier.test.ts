import { describe, expect, it } from "vitest";

import {
  selectRecordingV4EncoderEnvelope,
  verifyRecordingV4Audio,
  verifyRecordingV4Cadence,
  verifyRecordingV4Encoder,
  verifyRecordingV4Quality,
} from "./recording-v4-verifier";

const envelope = {
  source: "built_in_profile" as const,
  encoder_id: "hardware-h264",
  minimum_bitrate_bps: 10_000_000,
  target_bitrate_bps: 20_000_000,
  maximum_bitrate_bps: 30_000_000,
  safety_headroom_ratio: 0.2,
};

describe("Recording V4 verification", () => {
  it("selects an envelope only when calibrated safety headroom preserves the quality floor", () => {
    expect(selectRecordingV4EncoderEnvelope({ source: "built_in_profile", encoder_id: "hardware-h264",
      minimum_required_bitrate_bps: 10_000_000, sustained_bitrate_bps: 25_000_000,
      peak_bitrate_bps: 30_000_000 }, 0.2)).toEqual(envelope);
    expect(selectRecordingV4EncoderEnvelope({ source: "built_in_profile", encoder_id: "hardware-h264",
      minimum_required_bitrate_bps: 24_000_000, sustained_bitrate_bps: 25_000_000,
      peak_bitrate_bps: 30_000_000 }, 0.2)).toBeNull();
  });

  it("rejects cadence slot, hold, submit, acknowledgement, and PTS contradictions", () => {
    const cadence = {
      version: 4 as const, frame_rate: { numerator: 60 as const, denominator: 1 as const },
      active_duration_us: 33_333, expected_output_frames: 2, output_frames: 2, source_updates: 1,
      held_frames: 1, submitted_frames: 2, acknowledged_frames: 2, ring_high_water_mark: 1,
      pause_intervals: [],
      ledger: [
        { slot: 0, pts_us: 0, source_sequence: 1, source_timestamp_us: 0, held_from_slot: null,
          submitted_at_us: 1, acknowledged_at_us: 2 },
        { slot: 1, pts_us: 16_667, source_sequence: 1, source_timestamp_us: 0, held_from_slot: 0,
          submitted_at_us: 3, acknowledged_at_us: 4 },
      ], verdict: "passed" as const, failure_codes: [],
    };
    expect(verifyRecordingV4Cadence(cadence)).toEqual([]);
    expect(verifyRecordingV4Cadence({ ...cadence, acknowledged_frames: 1 })).toContain("output_frame_count_mismatch");
    expect(verifyRecordingV4Cadence({ ...cadence, ledger: cadence.ledger.map((entry, index) =>
      index ? { ...entry, held_from_slot: null } : entry) })).toContain("frame_ledger_invalid");
  });

  it("verifies bitrate, audio continuity/sync, and stable quality checkpoint IDs", () => {
    expect(verifyRecordingV4Encoder({ encoder_id: "hardware-h264", hardware_accelerated: true,
      requested_bitrate_bps: 20_000_000, average_bitrate_bps: 19_000_000,
      peak_bitrate_bps: 25_000_000, envelope })).toEqual([]);
    expect(verifyRecordingV4Encoder({ encoder_id: "hardware-h264", hardware_accelerated: true,
      requested_bitrate_bps: 20_000_000, average_bitrate_bps: 9_000_000,
      peak_bitrate_bps: 25_000_000, envelope })).toEqual(["bitrate_outside_envelope"]);
    const audio = { role: "microphone" as const, requested: true as const, status: "captured" as const,
      codec: "pcm_f32le" as const, sample_rate_hz: 48_000, channels: 1, started_offset_us: 0,
      duration_us: 1_000_000, end_drift_us: 0, sync_tolerance_us: 20_000, pause_mapping_valid: true,
      continuity_gaps: 0, ledger: [{ sequence: 0, pts_us: 0, duration_us: 1_000_000, frames: 48_000 }],
      failure_codes: [] };
    expect(verifyRecordingV4Audio(["microphone"], [audio], 1_000_000)).toEqual([]);
    expect(verifyRecordingV4Audio(["microphone"], [{ ...audio, end_drift_us: 20_001 }], 1_000_000))
      .toContain("audio_sync_failed");
    const passed = { measured: 1, threshold: 0.9, comparator: "gte" as const, passed: true };
    const quality = { checkpoints: [{ frame_slot: 0, reference_id: "initial-surface",
      full_frame_luma_ssim: passed, text_edge_roi_ssim: passed,
      edge_spread_increase_px: { measured: 0, threshold: 1, comparator: "lte" as const, passed: true },
      color_channel_delta: { measured: 0, threshold: 1, comparator: "lte" as const, passed: true } }],
      verdict: "passed" as const, failure_codes: [] };
    expect(verifyRecordingV4Quality(quality, ["initial-surface"])).toEqual([]);
    expect(verifyRecordingV4Quality(quality, ["motion-60"])).toContain("quality_checkpoint_failed");
  });
});
