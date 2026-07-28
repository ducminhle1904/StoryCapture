import { STRICT_RECORDING_FRAME_RATE } from "@storycapture/shared-types/recording-v2";
import {
  RECORDING_V3_BUNDLE_SCHEMA_VERSION,
  RECORDING_V3_CONTRACT_VERSION,
  type RecordingBundleV3,
  readRecordingBundle,
  readRecordingBundleV3,
} from "@storycapture/shared-types/recording-v3";
import { describe, expect, it } from "vitest";

const recordingBundleV3Fixture: RecordingBundleV3 = {
  schema_version: RECORDING_V3_BUNDLE_SCHEMA_VERSION,
  status: "completed",
  created_at: "2026-07-28T00:00:00.000Z",
  delivery_policy: "strict",
  capture_contract: {
    requested_fps: STRICT_RECORDING_FRAME_RATE,
    verified_fps: STRICT_RECORDING_FRAME_RATE,
    dimensions: {
      logical_width: 960,
      logical_height: 540,
      capture_dpr: 2,
      physical_width: 1920,
      physical_height: 1080,
      requested_output_width: 1920,
      requested_output_height: 1080,
    },
  },
  master: {
    relative_path: "master/video.mp4",
    bytes: 100,
    sha256: "a".repeat(64),
    codec: "h264",
    pixel_format: "yuv420p",
    frame_count: 300,
    exact_fps: STRICT_RECORDING_FRAME_RATE,
    native_capture_backend: { id: "screencapturekit", version: "1" },
    native_encoder: { id: "videotoolbox-h264", hardware_accelerated: true },
    started_monotonic_us: 1_000,
    ended_monotonic_us: 5_001_000,
    finalized_duration_us: 5_000_000,
  },
  proxy: null,
  audio: [],
  cadence: {
    version: RECORDING_V3_CONTRACT_VERSION,
    requested_fps: STRICT_RECORDING_FRAME_RATE,
    active_duration_us: 5_000_000,
    source_updates: 1,
    output_frames: 300,
    held_frames: 299,
    encoder_dropped_frames: 0,
    backpressure_events: 0,
    unresolved_backpressure_events: 0,
    pts_gaps: 0,
    pts_duplicates: 0,
    pts_non_monotonic: 0,
    initial_surface_received: true,
    verdict: "passed",
    failure_codes: [],
  },
  artifact: {
    finalized: true,
    full_decode_succeeded: true,
    decoded_frames: 300,
  },
  quality: {
    version: RECORDING_V3_CONTRACT_VERSION,
    evaluated_frames: 12,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes: "not_applicable",
    verdict: "passed",
    failure_codes: [],
  },
  evidence: {
    cadence_path: "evidence/cadence.json",
    quality_path: "evidence/quality.json",
  },
  sidecars: { actions_path: "sidecars/actions.json" },
  sequence_ledger_path: "evidence/sequence-ledger.jsonl",
  failure_codes: [],
};

describe("recording V3 contracts", () => {
  it("round-trips a JSON-safe V3 bundle with held CFR frames and no proxy", () => {
    const serialized = JSON.parse(JSON.stringify(recordingBundleV3Fixture));
    expect(readRecordingBundleV3(serialized)).toEqual(recordingBundleV3Fixture);
    expect(readRecordingBundle(serialized)).toEqual(recordingBundleV3Fixture);
  });

  it("keeps lossless evidence inapplicable and rejects incomplete artifacts", () => {
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        quality: {
          ...recordingBundleV3Fixture.quality,
          lossless_master_hashes: true,
        },
      }),
    ).toBeNull();
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        artifact: { ...recordingBundleV3Fixture.artifact, decoded_frames: 299 },
      }),
    ).toBeNull();
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        failure_codes: ["made_up_failure"],
      }),
    ).toBeNull();
  });

  it("rejects V2 masters without changing the V2 reader", () => {
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        master: { ...recordingBundleV3Fixture.master, relative_path: "master/video.mkv" },
      }),
    ).toBeNull();
  });

  it("rejects terminal status that contradicts verification evidence", () => {
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        cadence: {
          ...recordingBundleV3Fixture.cadence,
          verdict: "failed",
          failure_codes: ["artifact_pts_gap"],
        },
      }),
    ).toBeNull();
    expect(
      readRecordingBundleV3({
        ...recordingBundleV3Fixture,
        status: "quality_failed",
      }),
    ).toBeNull();
  });
});
