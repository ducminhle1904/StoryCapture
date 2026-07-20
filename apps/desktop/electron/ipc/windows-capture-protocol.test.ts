import type { RecordingPreflightV2Request } from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";
import {
  encodeWindowsCaptureCommand,
  parseWindowsCaptureEvent,
  validateWindowsCaptureTarget,
  WINDOWS_CAPTURE_RING_CAPACITY,
  type WindowsCaptureProbeResult,
  WindowsCaptureProtocolError,
  windowsProbeToPreflight,
} from "./windows-capture-protocol";

const request: RecordingPreflightV2Request = {
  version: 2,
  delivery_policy: "strict",
  target_class: "display",
  requested_fps: { numerator: 60, denominator: 1 },
  dimensions: {
    logical_width: 1_280,
    logical_height: 720,
    capture_dpr: 2,
    physical_width: 2_560,
    physical_height: 1_440,
    requested_output_width: 1_920,
    requested_output_height: 1_080,
  },
  audio_roles: ["system"],
  desired_tier: {
    version: 2,
    id: "windows-wgc-display-x64",
    stage: "certified",
    target_class: "display",
    platform: "win32",
    arch: "x64",
    backend_id: "windows-graphics-capture",
    backend_version: "1.0.0",
    hardware_fingerprint: "gpu-1",
    exact_fps: { numerator: 60, denominator: 1 },
    output_width: 1_920,
    output_height: 1_080,
  },
};

const probeResult: WindowsCaptureProbeResult = {
  backend_id: "windows-graphics-capture",
  backend_version: "1.0.0",
  gpu_identity: "Adapter",
  hardware_fingerprint: "gpu-1",
  adapter_luid: "00000000:00000001",
  permissions_granted: true,
  source_presentations: 120,
  probe_duration_ms: 2_000,
  measured_fps_numerator: 60,
  measured_fps_denominator: 1,
  sequence_gaps: 0,
  stale_reuses: 0,
  physical_width: 2_560,
  physical_height: 1_440,
  failure_codes: [],
};

describe("Windows capture helper protocol", () => {
  it("accepts metadata-only native ring and frame envelopes", () => {
    expect(
      parseWindowsCaptureEvent(
        JSON.stringify({
          version: 2,
          type: "ready",
          session_id: "session-1",
          ring: {
            mapping_name: "Local\\StoryCaptureWgcRing-session-1",
            frame_event_name: "Local\\StoryCaptureWgcFrame-session-1",
            ownership_token: "owner-1",
            capacity: WINDOWS_CAPTURE_RING_CAPACITY,
            width: 1_920,
            height: 1_080,
            stride: 7_680,
            pixel_format: "bgra",
          },
        }),
      ),
    ).toMatchObject({ type: "ready", ring: { capacity: 8, pixel_format: "bgra" } });

    expect(
      parseWindowsCaptureEvent(
        JSON.stringify({
          version: 2,
          type: "frame-committed",
          session_id: "session-1",
          delivery_sequence: 1,
          source_frame_index: 9,
          native_pts_us: 0,
          duration_us: 16_667,
          slot_index: 0,
          width: 1_920,
          height: 1_080,
          stride: 7_680,
          pixel_format: "bgra",
          ownership_token: "owner-1",
        }),
      ),
    ).toMatchObject({ type: "frame-committed", delivery_sequence: 1, source_frame_index: 9 });
  });

  it("rejects frame bytes and malformed native metadata on the JSON channel", () => {
    expect(() =>
      parseWindowsCaptureEvent(
        JSON.stringify({
          version: 2,
          type: "frame-committed",
          session_id: "session-1",
          delivery_sequence: 1,
          source_frame_index: 1,
          native_pts_us: 0,
          duration_us: 16_667,
          slot_index: 0,
          width: 2,
          height: 2,
          stride: 8,
          pixel_format: "bgra",
          ownership_token: "owner-1",
          pixels: "base64-is-forbidden",
        }),
      ),
    ).toThrow(/cannot cross the JSON/);
    expect(() =>
      parseWindowsCaptureEvent(
        JSON.stringify({
          version: 2,
          type: "ready",
          session_id: "session-1",
          ring: {
            mapping_name: "ring",
            frame_event_name: "event",
            ownership_token: "owner",
            capacity: 4,
            width: 2,
            height: 2,
            stride: 8,
            pixel_format: "bgra",
          },
        }),
      ),
    ).toThrow(/ring descriptor/);
  });

  it("validates deterministic display and window identities", () => {
    expect(() => validateWindowsCaptureTarget({ kind: "display", device_path: "" })).toThrow(
      WindowsCaptureProtocolError,
    );
    expect(() =>
      validateWindowsCaptureTarget({
        kind: "window",
        hwnd: "123",
        process_id: 10,
        executable_path: "C:\\App\\app.exe",
        class_name: "AppWindow",
      }),
    ).toThrow(/HWND/);
    expect(() =>
      validateWindowsCaptureTarget({
        kind: "window",
        hwnd: "0x123",
        process_id: 10,
        executable_path: "C:\\App\\app.exe",
        class_name: "AppWindow",
      }),
    ).not.toThrow();
  });

  it("preserves exact JSON commands without a pixel payload", () => {
    const line = encodeWindowsCaptureCommand({
      version: 2,
      type: "pause",
      session_id: "session-1",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ version: 2, type: "pause", session_id: "session-1" });
  });

  it("requires exact 60/1, certification, 1.5x throughput, and native dimensions", () => {
    const passed = windowsProbeToPreflight(request, probeResult, {
      arch: "x64",
      certificationMatch: true,
      encodeThroughputRatio: 1.5,
      estimatedBytesPerSecond: 100,
      requiredBytesForTenMinutes: 60_000,
      availableBytes: 70_000,
      reserveBytes: 10_000,
    });
    expect(passed).toMatchObject({ strict_eligible: true, failure_codes: [] });

    const failed = windowsProbeToPreflight(
      request,
      {
        ...probeResult,
        measured_fps_numerator: 60_000,
        measured_fps_denominator: 1_001,
        physical_width: 1_280,
        physical_height: 720,
      },
      {
        arch: "x64",
        certificationMatch: false,
        encodeThroughputRatio: 1.49,
        estimatedBytesPerSecond: 100,
        requiredBytesForTenMinutes: 60_000,
        availableBytes: 70_000,
        reserveBytes: 10_000,
      },
    );
    expect(failed.strict_eligible).toBe(false);
    expect(failed.failure_codes).toEqual(
      expect.arrayContaining([
        "backend_capability_mismatch",
        "uncertified_tier",
        "preflight_failed",
      ]),
    );
  });
});
