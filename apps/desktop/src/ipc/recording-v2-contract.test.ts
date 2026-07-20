import {
  isExactStrictFrameRate,
  RECORDING_BUNDLE_SCHEMA_VERSION,
  RECORDING_COMPOSITION_SOURCE_VERSION,
  type RecordingBundleV2,
  readExportRecordingSourceV2,
  readRecordingBundleV2,
  readRecordingDeliveryPolicy,
  readRecordingInfoV2,
  STRICT_RECORDING_FRAME_RATE,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";

const bundle: RecordingBundleV2 = {
  schema_version: RECORDING_BUNDLE_SCHEMA_VERSION,
  status: "completed",
  created_at: "2026-07-19T00:00:00.000Z",
  delivery_policy: "strict",
  certified_tier: null,
  capture_contract: {
    exact_fps: STRICT_RECORDING_FRAME_RATE,
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
    relative_path: "master/video.mkv",
    bytes: 100,
    sha256: "a".repeat(64),
    codec: "ffv1",
    pixel_format: "bgra",
    frame_count: 300,
    exact_fps: STRICT_RECORDING_FRAME_RATE,
  },
  proxy: {
    relative_path: "proxy/video.mp4",
    bytes: 50,
    sha256: "b".repeat(64),
    codec: "h264",
  },
  audio: [],
  evidence: {
    cadence_path: "evidence/cadence.json",
    quality_path: "evidence/quality.json",
  },
  sidecars: { actions_path: "sidecars/actions.json" },
  sequence_ledger_path: "evidence/sequence-ledger.jsonl",
  failure_codes: [],
};

describe("recording V2 contracts", () => {
  it("round-trips a JSON-safe V2 bundle", () => {
    expect(readRecordingBundleV2(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it("rejects malformed schema versions and non-60 masters", () => {
    expect(readRecordingBundleV2({ ...bundle, schema_version: 1 })).toBeNull();
    expect(
      readRecordingBundleV2({
        ...bundle,
        master: { ...bundle.master, exact_fps: { numerator: 60_000, denominator: 1_001 } },
      }),
    ).toBeNull();
  });

  it("rejects malformed or escaping bundle artifacts", () => {
    expect(readRecordingBundleV2({ ...bundle, audio: [null] })).toBeNull();
    expect(
      readRecordingBundleV2({
        ...bundle,
        proxy: { ...bundle.proxy, relative_path: "../outside.mp4" },
      }),
    ).toBeNull();
    expect(
      readRecordingBundleV2({
        ...bundle,
        audio: [
          {
            relative_path: "audio/../outside.wav",
            bytes: 10,
            sha256: "c".repeat(64),
            role: "microphone",
            codec: "pcm_s16le",
          },
        ],
      }),
    ).toBeNull();
  });

  it("defaults a missing or malformed persisted policy to best-effort", () => {
    expect(readRecordingDeliveryPolicy(undefined)).toBe("best_effort");
    expect(readRecordingDeliveryPolicy("standard")).toBe("best_effort");
    expect(readRecordingDeliveryPolicy("strict")).toBe("strict");
  });

  it("normalizes legacy recording metadata as unknown and non-Strict", () => {
    expect(
      readRecordingInfoV2({
        path: "/exports/legacy.mp4",
        captured_at: 1,
        duration_ms: 5_000,
        width: 1920,
        height: 1080,
      }),
    ).toMatchObject({
      version: 2,
      path: "/exports/legacy.mp4",
      master_path: null,
      proxy_path: null,
      exact_source_fps: null,
      certified_tier: null,
      quality_verdict: "unknown",
      bundle_path: null,
    });
  });

  it("rejects malformed recording metadata", () => {
    expect(readRecordingInfoV2({ path: "ok", captured_at: -1 })).toBeNull();
    expect(readRecordingInfoV2({ captured_at: 1 })).toBeNull();
  });

  it("reads composition master/proxy metadata without changing legacy graphs", () => {
    const source = {
      version: RECORDING_COMPOSITION_SOURCE_VERSION,
      bundle_path: "/take.sc-recording",
      master_path: "/take.sc-recording/master/video.mkv",
      proxy_path: "/take.sc-recording/proxy/video.mp4",
      cadence_evidence_path: "/take.sc-recording/evidence/cadence.json",
      quality_evidence_path: "/take.sc-recording/evidence/quality.json",
      exact_source_fps: STRICT_RECORDING_FRAME_RATE,
      source_frame_count: 300,
      master_width: 1920,
      master_height: 1080,
      quality_verdict: "passed",
    } as const;
    expect(readExportRecordingSourceV2(source)).toEqual(source);
    expect(readExportRecordingSourceV2({ ...source, source_frame_count: 0 })).toBeNull();
  });

  it("treats 59.94 as distinct from exact 60/1", () => {
    expect(isExactStrictFrameRate(STRICT_RECORDING_FRAME_RATE)).toBe(true);
    expect(isExactStrictFrameRate({ numerator: 60_000, denominator: 1_001 })).toBe(false);
  });
});
