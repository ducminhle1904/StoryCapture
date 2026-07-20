import type {
  CaptureBackendV2Capabilities,
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";

import {
  CaptureBackendV2Error,
  CaptureBackendV2Guard,
  validateCaptureBackendV2Preflight,
  validateCaptureBackendV2Request,
} from "./capture-backend-v2-guard";

const capabilities: CaptureBackendV2Capabilities = {
  version: 2,
  backend_id: "test-backend",
  backend_version: "1",
  target_classes: ["browser", "display", "window"],
  supports_native_timestamps: true,
  supports_source_sequences: true,
  supports_physical_pixels: true,
  supports_cursor_policy: true,
  supports_pause_resume: true,
};

function request(
  overrides: Partial<RecordingPreflightV2Request> = {},
): RecordingPreflightV2Request {
  return {
    version: 2,
    delivery_policy: "strict",
    target_class: "browser",
    requested_fps: { numerator: 60, denominator: 1 },
    dimensions: {
      logical_width: 960,
      logical_height: 540,
      capture_dpr: 2,
      physical_width: 1_920,
      physical_height: 1_080,
      requested_output_width: 1_920,
      requested_output_height: 1_080,
    },
    audio_roles: [],
    desired_tier: null,
    ...overrides,
  };
}

function preflight(overrides: Partial<RecordingPreflightV2Dto> = {}): RecordingPreflightV2Dto {
  return {
    version: 2,
    backend_id: capabilities.backend_id,
    backend_version: capabilities.backend_version,
    platform: "darwin",
    arch: "arm64",
    gpu_identity: "test-gpu",
    hardware_fingerprint: "test-hardware",
    certification: {
      version: 2,
      id: "test-browser",
      stage: "certified",
      target_class: "browser",
      platform: "darwin",
      arch: "arm64",
      backend_id: capabilities.backend_id,
      backend_version: capabilities.backend_version,
      hardware_fingerprint: "test-hardware",
      exact_fps: { numerator: 60, denominator: 1 },
      output_width: 1_920,
      output_height: 1_080,
    },
    certification_match: true,
    source_rate: {
      measured_fps: { numerator: 60, denominator: 1 },
      source_presentations: 120,
      sequence_gaps: 0,
      stale_reuses: 0,
      probe_duration_ms: 2_000,
    },
    encode_throughput_ratio: 1.5,
    storage: {
      estimated_bytes_per_second: 1,
      required_bytes_for_ten_minutes: 600,
      available_bytes: 10_000,
      reserve_bytes: 1_000,
    },
    permissions_granted: true,
    strict_eligible: true,
    failure_codes: [],
    ...overrides,
  };
}

describe("CaptureBackendV2Guard", () => {
  it("accepts a physical source larger than the requested 1080p output", () => {
    const higherResolution = request({
      dimensions: {
        logical_width: 1_920,
        logical_height: 1_080,
        capture_dpr: 2,
        physical_width: 3_840,
        physical_height: 2_160,
        requested_output_width: 1_920,
        requested_output_height: 1_080,
      },
    });

    expect(validateCaptureBackendV2Request(capabilities, higherResolution)).toEqual([]);
  });

  it("rejects logical/DPR mismatches and non-1080 Strict output", () => {
    const invalid = request({
      dimensions: {
        logical_width: 960,
        logical_height: 540,
        capture_dpr: 1,
        physical_width: 1_920,
        physical_height: 1_080,
        requested_output_width: 1_280,
        requested_output_height: 720,
      },
    });

    expect(validateCaptureBackendV2Request(capabilities, invalid)).toEqual(["contract_mismatch"]);
  });

  it("requires at least 1.5x encode throughput", () => {
    expect(
      validateCaptureBackendV2Preflight(
        capabilities,
        request(),
        preflight({ encode_throughput_ratio: 1.49 }),
      ),
    ).toContain("backend_capability_mismatch");
  });

  it("enforces probe-before-start and exact session request identity", () => {
    const guard = new CaptureBackendV2Guard(capabilities);
    expect(() => guard.begin({ session_id: "session", request: request() })).toThrow(
      expect.objectContaining({ code: "preflight_failed" }),
    );

    guard.acceptProbe(request(), preflight());
    expect(() =>
      guard.begin({
        session_id: "session",
        request: request({ audio_roles: ["microphone"] }),
      }),
    ).toThrow(expect.objectContaining({ code: "contract_mismatch" }));
  });

  it("accepts contiguous physical frames and keeps stop idempotent", () => {
    const guard = new CaptureBackendV2Guard(capabilities);
    const negotiated = request();
    guard.acceptProbe(negotiated, preflight());
    guard.begin({ session_id: "session", request: negotiated });
    guard.acceptFrame({
      source_sequence: 1,
      native_pts_us: 0,
      width: 1_920,
      height: 1_080,
      stride: 7_680,
      pixel_format: "bgra",
    });
    guard.acceptFrame({
      source_sequence: 2,
      native_pts_us: 16_667,
      width: 1_920,
      height: 1_080,
      stride: 7_680,
      pixel_format: "bgra",
    });

    expect(guard.stop()).toBe(true);
    expect(guard.stop()).toBe(false);
    expect(guard.lifecycle).toBe("stopped");
  });

  it("sticks the first source sequence or timestamp failure", () => {
    const guard = new CaptureBackendV2Guard(capabilities);
    const negotiated = request();
    guard.acceptProbe(negotiated, preflight());
    guard.begin({ session_id: "session", request: negotiated });
    guard.acceptFrame({
      source_sequence: 1,
      native_pts_us: 10,
      width: 1_920,
      height: 1_080,
      stride: 7_680,
      pixel_format: "bgra",
    });

    expect(() =>
      guard.acceptFrame({
        source_sequence: 3,
        native_pts_us: 20,
        width: 1_920,
        height: 1_080,
        stride: 7_680,
        pixel_format: "bgra",
      }),
    ).toThrow(CaptureBackendV2Error);
    expect(guard.stickyFailure?.code).toBe("source_sequence_gap");
    expect(guard.lifecycle).toBe("failed");
  });
});
