import { describe, expect, it, vi } from "vitest";

import { recordingNativeGlobalPreflight } from "./recording-native-preflight";

const statfs = vi.fn(async () => ({ bavail: 10_000_000, bsize: 4096 })) as never;

describe("Recording V3 global preflight", () => {
  it("admits a capable machine without a certification catalogue entry", async () => {
    const result = await recordingNativeGlobalPreflight({
      exportsDir: "/tmp/exports",
      platform: "darwin",
      arch: "arm64",
      isPackaged: true,
      resourcesPath: "/resources",
      appPath: "/app",
      env: {},
      statfs,
      helperExists: vi.fn(async () => true),
      accessStatus: () => "granted",
      probeMac: vi.fn(
        async () =>
          ({
            backend_id: "screen-capture-kit",
            backend_version: "3.0.0",
            platform: "darwin",
            arch: "arm64",
            supports_native_master: true,
            supports_hardware_h264: true,
            supports_cfr_held_frames: true,
            supports_atomic_finalization: true,
            encoder: { id: "videotoolbox-h264", hardware_accelerated: true },
          }) as const,
      ),
    });

    expect(result.preflight).toMatchObject({
      version: 3,
      strict_eligible: true,
      helper_available: true,
      protocol_compatible: true,
      encoder_available: true,
      failure_codes: [],
    });
  });

  it("reports global failures before any target window is needed", async () => {
    const result = await recordingNativeGlobalPreflight({
      exportsDir: "/tmp/exports",
      platform: "darwin",
      isPackaged: true,
      resourcesPath: "/resources",
      appPath: "/app",
      env: { STORYCAPTURE_DISABLE_STRICT_NATIVE_RECORDING: "1" },
      statfs,
      helperExists: vi.fn(async () => false),
      accessStatus: () => "denied",
    });

    expect(result.preflight.strict_eligible).toBe(false);
    expect(result.preflight.failure_codes).toEqual(
      expect.arrayContaining(["backend_unavailable", "permission_denied", "preflight_failed"]),
    );
  });
});
