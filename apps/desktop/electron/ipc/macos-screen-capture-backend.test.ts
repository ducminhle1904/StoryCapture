import fs from "node:fs";
import path from "node:path";
import type {
  RecordingCertifiedTier,
  RecordingPreflightV2Request,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it, vi } from "vitest";
import { CaptureBackendV2Error } from "./capture-backend-v2-guard";
import {
  MACOS_SCREEN_CAPTURE_BACKEND_ID,
  MACOS_SCREEN_CAPTURE_BACKEND_VERSION,
  MacNativePacketDecoder,
  MacOSScreenCaptureBackend,
  type MacScreenCaptureHelperTransport,
  type MacScreenCapturePacket,
  resolveMacScreenCaptureHelperPath,
} from "./macos-screen-capture-backend";

function nativePacket({
  kind = 1,
  sequence = 1,
  pts = 1_000,
  width = 2,
  height = 1,
  stride = width * 4,
  bytes = Buffer.alloc(stride * height, 9),
}: {
  kind?: 1 | 2;
  sequence?: number;
  pts?: number;
  width?: number;
  height?: number;
  stride?: number;
  bytes?: Buffer;
} = {}): Buffer {
  const header = Buffer.alloc(64);
  Buffer.from([0x53, 0x43, 0x46, 0x52, 0x4d, 0x32, 0, 0]).copy(header);
  header.writeUInt32LE(kind, 8);
  header.writeUInt32LE(64, 12);
  header.writeBigUInt64LE(BigInt(sequence), 16);
  header.writeBigUInt64LE(BigInt(pts), 24);
  header.writeUInt32LE(width, 32);
  header.writeUInt32LE(height, 36);
  header.writeUInt32LE(stride, 40);
  header.writeUInt32LE(kind === 1 ? 1 : 1_816_301_296, 44);
  header.writeBigUInt64LE(BigInt(bytes.byteLength), 48);
  return Buffer.concat([header, bytes]);
}

const storage = {
  estimated_bytes_per_second: 1,
  required_bytes_for_ten_minutes: 600,
  available_bytes: 10_000,
  reserve_bytes: 1_000,
};

function tier(targetClass: "display" | "window" = "display"): RecordingCertifiedTier {
  return {
    version: 2,
    id: `mac-${targetClass}`,
    stage: "certified",
    target_class: targetClass,
    platform: "darwin",
    arch: "arm64",
    backend_id: MACOS_SCREEN_CAPTURE_BACKEND_ID,
    backend_version: MACOS_SCREEN_CAPTURE_BACKEND_VERSION,
    hardware_fingerprint: "mac-hardware",
    exact_fps: { numerator: 60, denominator: 1 },
    output_width: 1_920,
    output_height: 1_080,
  };
}

function request(targetClass: "display" | "window" = "display"): RecordingPreflightV2Request {
  return {
    version: 2,
    delivery_policy: "strict",
    target_class: targetClass,
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
    audio_roles: ["system"],
    desired_tier: tier(targetClass),
  };
}

class FakeTransport implements MacScreenCaptureHelperTransport {
  packet: ((packet: MacScreenCapturePacket) => Promise<void>) | null = null;
  failure: ((code: "target_changed" | "backend_unavailable", message: string) => void) | null =
    null;
  readonly requests: Array<{ command: string; options: unknown }> = [];
  probeFailure: "permission_denied" | null = null;
  resumeFailure: "target_changed" | null = null;

  async request(
    command: string,
    options: unknown = {},
  ): ReturnType<MacScreenCaptureHelperTransport["request"]> {
    this.requests.push({ command, options });
    if (command === "probe" && this.probeFailure) {
      throw Object.assign(new Error(this.probeFailure), { code: this.probeFailure });
    }
    if (command === "resume" && this.resumeFailure) {
      throw new CaptureBackendV2Error(this.resumeFailure, this.resumeFailure);
    }
    if (command === "probe") {
      return {
        version: 2,
        event: "probe",
        ok: true,
        data: {
          backend_id: MACOS_SCREEN_CAPTURE_BACKEND_ID,
          backend_version: MACOS_SCREEN_CAPTURE_BACKEND_VERSION,
          platform: "darwin",
          arch: "arm64",
          hardware_fingerprint: "mac-hardware",
          target_identity: "target-fingerprint",
          permissions_granted: true,
          measured_fps: { numerator: 60, denominator: 1 },
          source_presentations: 300,
          sequence_gaps: 0,
          stale_reuses: 0,
          probe_duration_ms: 5_000,
          logical_width: 960,
          logical_height: 540,
          physical_width: 1_920,
          physical_height: 1_080,
        },
      };
    }
    return { version: 2, event: command, ok: true, data: {} };
  }

  close(): void {}
}

function makeBackend(fake: FakeTransport, submit = vi.fn(async () => undefined)) {
  return {
    backend: new MacOSScreenCaptureBackend({
      target: { kind: "display", displayID: 7 },
      helperPath: "/helper",
      preflight: { storage, encodeThroughputRatio: 2, gpuIdentity: "gpu" },
      sink: { submit },
      transportFactory: (_path, onPacket, onFailure) => {
        fake.packet = onPacket;
        fake.failure = onFailure;
        return fake;
      },
    }),
    submit,
  };
}

describe("ScreenCaptureKit native packet protocol", () => {
  it("decodes split BGRA packets without PNG conversion", () => {
    const decoder = new MacNativePacketDecoder();
    const packet = nativePacket({ sequence: 12, pts: 34_000 });
    expect(decoder.push(packet.subarray(0, 31))).toEqual([]);
    const [decoded] = decoder.push(packet.subarray(31));
    expect(decoded).toMatchObject({
      kind: "video",
      sequence: 12,
      nativePtsUs: 34_000,
      width: 2,
      height: 1,
      stride: 8,
    });
    expect([...decoded.bytes]).toEqual(Array(8).fill(9));
    decoder.finish();
  });

  it("rejects a truncated native packet", () => {
    const decoder = new MacNativePacketDecoder();
    decoder.push(nativePacket().subarray(0, 67));
    expect(() => decoder.finish()).toThrow(/mid-packet/);
  });
});

describe("MacOSScreenCaptureBackend", () => {
  it("passes certified Retina preflight and pins target identity for start", async () => {
    const fake = new FakeTransport();
    const { backend: capture } = makeBackend(fake);
    const input = request();
    const result = await capture.probe(input);
    expect(result).toMatchObject({ strict_eligible: true, permissions_granted: true });
    await capture.start({ session_id: "take-1", request: input });
    expect(fake.requests[1]).toMatchObject({
      command: "start",
      options: {
        sessionID: "take-1",
        payload: {
          target: { kind: "display", displayID: 7, expectedIdentity: "target-fingerprint" },
          outputWidth: 1_920,
          outputHeight: 1_080,
          showsCursor: true,
          dynamicSizePolicy: "fail_on_change",
          capturesSystemAudio: true,
        },
      },
    });
  });

  it("delivers exact native sequence and PTS into the common sink", async () => {
    const fake = new FakeTransport();
    const { backend: capture, submit } = makeBackend(fake);
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-2", request: input });
    await fake.packet?.({
      kind: "video",
      sequence: 1,
      nativePtsUs: 10_000,
      width: 1_920,
      height: 1_080,
      stride: 1_920 * 4,
      format: 1,
      flags: 0n,
      bytes: new Uint8Array(1_920 * 1_080 * 4),
    });
    expect(submit).toHaveBeenCalledWith({
      sourceSequence: 1,
      nativePtsUs: 10_000,
      pixels: expect.any(Uint8Array),
    });
  });

  it("preserves native system-audio PTS on the separate packet path", async () => {
    const fake = new FakeTransport();
    const systemAudioPacket = vi.fn(async () => undefined);
    const capture = new MacOSScreenCaptureBackend({
      target: { kind: "display", displayID: 7 },
      helperPath: "/helper",
      preflight: { storage, encodeThroughputRatio: 2, gpuIdentity: "gpu" },
      sink: { submit: async () => undefined, systemAudioPacket },
      transportFactory: (_path, onPacket, onFailure) => {
        fake.packet = onPacket;
        fake.failure = onFailure;
        return fake;
      },
    });
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-audio", request: input });
    const packet: MacScreenCapturePacket = {
      kind: "system_audio",
      sequence: 1,
      nativePtsUs: 25_000,
      width: 48_000,
      height: 2,
      stride: 8,
      format: 1_816_301_296,
      flags: 0n,
      bytes: new Uint8Array(128),
    };
    await fake.packet?.(packet);
    expect(systemAudioPacket).toHaveBeenCalledWith(packet);
  });

  it("rejects sequence gaps instead of hiding native backpressure", async () => {
    const fake = new FakeTransport();
    const { backend: capture } = makeBackend(fake);
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-gap", request: input });
    const makeFrame = (sequence: number, nativePtsUs: number): MacScreenCapturePacket => ({
      kind: "video",
      sequence,
      nativePtsUs,
      width: 1_920,
      height: 1_080,
      stride: 1_920 * 4,
      format: 1,
      flags: 0n,
      bytes: new Uint8Array(1_920 * 1_080 * 4),
    });
    await fake.packet?.(makeFrame(1, 10_000));
    await expect(fake.packet?.(makeFrame(3, 43_334))).rejects.toMatchObject({
      code: "source_sequence_gap",
    });
  });

  it("keeps pause/resume/stop idempotency ordered at the native boundary", async () => {
    const fake = new FakeTransport();
    const { backend: capture } = makeBackend(fake);
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-3", request: input });
    await capture.pause();
    await capture.resume();
    await capture.stop();
    await capture.stop();
    expect(fake.requests.map((entry) => entry.command)).toEqual([
      "probe",
      "start",
      "pause",
      "resume",
      "stop",
      "shutdown",
    ]);
  });

  it("fails closed when helper target identity changes on resume", async () => {
    const fake = new FakeTransport();
    const { backend: capture } = makeBackend(fake);
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-4", request: input });
    await capture.pause();
    fake.resumeFailure = "target_changed";
    await expect(capture.resume()).rejects.toMatchObject({ code: "target_changed" });
  });

  it("reports permission loss and helper crash without claiming Strict eligibility", async () => {
    const denied = new FakeTransport();
    denied.probeFailure = "permission_denied";
    const deniedBackend = makeBackend(denied).backend;
    const deniedResult = await deniedBackend.probe(request());
    expect(deniedResult.strict_eligible).toBe(false);
    expect(deniedResult.failure_codes).toContain("permission_denied");

    const crashed = new FakeTransport();
    const failed = vi.fn();
    const capture = new MacOSScreenCaptureBackend({
      target: { kind: "display", displayID: 8 },
      helperPath: "/helper",
      preflight: { storage, encodeThroughputRatio: 2, gpuIdentity: "gpu" },
      sink: { submit: async () => undefined, failed },
      transportFactory: (_path, onPacket, onFailure) => {
        crashed.packet = onPacket;
        crashed.failure = onFailure;
        return crashed;
      },
    });
    const input = request();
    await capture.probe(input);
    await capture.start({ session_id: "take-5", request: input });
    crashed.failure?.("backend_unavailable", "crashed");
    expect(failed).toHaveBeenCalledWith("backend_unavailable", "crashed");
  });
});

describe("ScreenCaptureKit packaging contract", () => {
  it("resolves only the build output or packaged extra-resource path", () => {
    expect(
      resolveMacScreenCaptureHelperPath({
        isPackaged: true,
        resourcesPath: "/App/Contents/Resources",
        appPath: "/App/Contents/Resources/app.asar",
      }),
    ).toBe("/App/Contents/Resources/native/macos/storycapture-screen-capture-helper");
    expect(
      resolveMacScreenCaptureHelperPath({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath: "/repo/apps/desktop",
      }),
    ).toContain("native/macos-screen-capture/.build/release/storycapture-screen-capture-helper");
  });

  it("uses ScreenCaptureKit raw BGRA and excludes thumbnail/PNG polling paths", () => {
    const source = [
      "native/macos-screen-capture/Sources/ScreenCaptureCore/CaptureEngine.swift",
      "native/macos-screen-capture/Sources/StoryCaptureScreenCaptureHelper/main.swift",
    ]
      .map((relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"))
      .join("\n");
    expect(source).toContain("import ScreenCaptureKit");
    expect(source).toContain("kCVPixelFormatType_32BGRA");
    expect(source).toContain("minimumFrameInterval = CMTime(value: 1, timescale: 60)");
    expect(source).toContain("onScreenWindowsOnly: false");
    expect(source).toContain("attachments.first?[.displayTime]");
    expect(source).toContain("NSWorkspace.screensDidSleepNotification");
    expect(source).not.toMatch(/desktopCapturer|capturePage|\.png|PNG/);
  });
});
