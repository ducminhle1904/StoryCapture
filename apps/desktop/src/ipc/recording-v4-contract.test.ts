import {
  RECORDING_V4_BUNDLE_SCHEMA_VERSION,
  RECORDING_V4_CONTRACT_VERSION,
  RECORDING_V4_FRAME_RATE,
  RECORDING_V4_PROFILE,
  applyRecordingV4Command,
  canTransitionRecordingV4,
  readRecordingV4Bundle,
  readRecordingV4Journal,
  recordingV4ExpectedFrameCount,
  recordingV4AudioSyncPassed,
  recordingV4PtsUs,
  type RecordingV4Bundle,
} from "@storycapture/shared-types/recording-v4";
import { describe, expect, it } from "vitest";

const metric = { measured: 1, threshold: 0.99, comparator: "gte" as const, passed: true };
const encoder = {
  encoder_id: "hardware-h264",
  hardware_accelerated: true as const,
  requested_bitrate_bps: 40_000_000,
  average_bitrate_bps: 38_000_000,
  peak_bitrate_bps: 45_000_000,
  envelope: {
    source: "live_calibration" as const,
    encoder_id: "hardware-h264",
    minimum_bitrate_bps: 30_000_000,
    target_bitrate_bps: 40_000_000,
    maximum_bitrate_bps: 50_000_000,
    safety_headroom_ratio: 0.2,
  },
};

function bundleFixture(): RecordingV4Bundle {
  const outputFrames = recordingV4ExpectedFrameCount(50_000);
  return {
    schema_version: RECORDING_V4_BUNDLE_SCHEMA_VERSION,
    profile: RECORDING_V4_PROFILE,
    status: "completed",
    session_id: "session-1",
    created_at: "2026-07-31T00:00:00.000Z",
    target: { kind: "author_preview", stable_id: "preview-1", process_id: 10, initial_title: null },
    dimensions: { physical_width: 1920, physical_height: 1080 },
    master: {
      relative_path: "master/video.mp4",
      bytes: 1_024,
      sha256: "a".repeat(64),
      codec: "h264",
      pixel_format: "yuv420p",
      frame_rate: RECORDING_V4_FRAME_RATE,
      frame_count: outputFrames,
      encoder,
    },
    audio: [],
    cadence: {
      version: RECORDING_V4_CONTRACT_VERSION,
      frame_rate: RECORDING_V4_FRAME_RATE,
      active_duration_us: 50_000,
      expected_output_frames: outputFrames,
      output_frames: outputFrames,
      source_updates: 1,
      held_frames: outputFrames - 1,
      submitted_frames: outputFrames,
      acknowledged_frames: outputFrames,
      ring_high_water_mark: 1,
      pause_intervals: [],
      ledger: Array.from({ length: outputFrames }, (_, slot) => ({
        slot,
        pts_us: recordingV4PtsUs(slot),
        source_sequence: 0,
        source_timestamp_us: 0,
        held_from_slot: slot === 0 ? null : 0,
        submitted_at_us: recordingV4PtsUs(slot),
        acknowledged_at_us: recordingV4PtsUs(slot) + 100,
      })),
      verdict: "passed",
      failure_codes: [],
    },
    quality: {
      checkpoints: [{
        frame_slot: 0,
        reference_id: "fixture-static-0",
        full_frame_luma_ssim: metric,
        text_edge_roi_ssim: metric,
        edge_spread_increase_px: { ...metric, measured: 0, threshold: 1, comparator: "lte" },
        color_channel_delta: { ...metric, measured: 0, threshold: 1, comparator: "lte" },
      }],
      verdict: "passed",
      failure_codes: [],
    },
    artifact: { finalized: true, full_decode_succeeded: true, decoded_frames: outputFrames, duration_us: 50_000 },
    evidence: {
      cadence_path: "evidence/cadence.json",
      quality_path: "evidence/quality.json",
      bitrate_path: "evidence/bitrate.json",
      frame_ledger_path: "evidence/frame-ledger.jsonl",
      audio_ledger_path: null,
    },
    sidecars: { actions_path: "sidecars/actions.json" },
    failure_codes: [],
  };
}

describe("Recording V4 contract", () => {
  it("defines legal transitions and idempotent terminal stop/cancel", () => {
    expect(canTransitionRecordingV4("idle", "preflighting")).toBe(true);
    expect(canTransitionRecordingV4("capturing", "verifying")).toBe(false);
    expect(applyRecordingV4Command("capturing", "pause")).toBe("paused");
    expect(applyRecordingV4Command("paused", "resume")).toBe("capturing");
    expect(applyRecordingV4Command("capturing", "stop")).toBe("stopping");
    expect(applyRecordingV4Command("completed", "stop")).toBe("completed");
    expect(applyRecordingV4Command("failed", "cancel")).toBe("failed");
    expect(applyRecordingV4Command("completed", "start")).toBeNull();
  });

  it("uses deterministic 60Hz rounding and PTS", () => {
    expect(recordingV4ExpectedFrameCount(0)).toBe(0);
    expect(recordingV4ExpectedFrameCount(16_666)).toBe(1);
    expect(recordingV4ExpectedFrameCount(25_000)).toBe(2);
    expect(recordingV4PtsUs(0)).toBe(0);
    expect(recordingV4PtsUs(1)).toBe(16_667);
    expect(recordingV4PtsUs(3)).toBe(50_000);
  });

  it("round-trips valid held-frame evidence", () => {
    const fixture = bundleFixture();
    expect(readRecordingV4Bundle(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });

  it("rejects non-60, non-1080, incomplete, and malformed ledgers", () => {
    const fixture = bundleFixture();
    expect(readRecordingV4Bundle({ ...fixture, dimensions: { physical_width: 1280, physical_height: 720 } })).toBeNull();
    expect(readRecordingV4Bundle({ ...fixture, master: { ...fixture.master, frame_rate: { numerator: 30, denominator: 1 } } })).toBeNull();
    expect(readRecordingV4Bundle({ ...fixture, artifact: { ...fixture.artifact, decoded_frames: 2 } })).toBeNull();
    expect(readRecordingV4Bundle({
      ...fixture,
      cadence: { ...fixture.cadence, ledger: fixture.cadence.ledger.slice(1) },
    })).toBeNull();
  });

  it("rejects requested audio with continuity or sync contradictions", () => {
    const fixture = bundleFixture();
    const audio = {
      relative_path: "audio/microphone.wav",
      bytes: 100,
      sha256: "b".repeat(64),
      role: "microphone" as const,
      evidence: {
        role: "microphone" as const,
        requested: true as const,
        status: "captured" as const,
        codec: "pcm_f32le" as const,
        sample_rate_hz: 48_000,
        channels: 1,
        started_offset_us: 0,
        duration_us: 50_000,
        end_drift_us: 0,
        sync_tolerance_us: 20_000,
        pause_mapping_valid: true,
        continuity_gaps: 0,
        ledger: [{ sequence: 0, pts_us: 0, duration_us: 50_000, frames: 2_400 }],
        failure_codes: [],
      },
    };
    expect(readRecordingV4Bundle({ ...fixture, audio: [audio] })).not.toBeNull();
    expect(readRecordingV4Bundle({
      ...fixture,
      audio: [{ ...audio, evidence: { ...audio.evidence, status: "failed", failure_codes: [] } }],
    })).toBeNull();
    expect(readRecordingV4Bundle({
      ...fixture,
      audio: [{ ...audio, evidence: { ...audio.evidence, end_drift_us: 20_001 } }],
    })).toBeNull();
    expect(recordingV4AudioSyncPassed(-20_000, 20_000, 20_000)).toBe(true);
    expect(recordingV4AudioSyncPassed(0, 20_001, 20_000)).toBe(false);
  });

  it("accepts recoverable journals and rejects terminal contradictions", () => {
    const journal = {
      version: RECORDING_V4_CONTRACT_VERSION,
      session_id: "session-1",
      project_path: "/project",
      workspace_path: "/project/exports/.staging-session-1",
      state: "capturing",
      revision: 4,
      helper_pid: 123,
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:00:01.000Z",
      terminal_result: null,
    };
    expect(readRecordingV4Journal(journal)).toEqual(journal);
    expect(readRecordingV4Journal({ ...journal, state: "failed" })).toBeNull();
    expect(readRecordingV4Journal({ ...journal, version: 3 })).toBeNull();
  });
});
