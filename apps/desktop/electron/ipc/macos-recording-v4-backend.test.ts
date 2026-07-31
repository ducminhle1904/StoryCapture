import { describe, expect, it } from "vitest";

import type { RecordingV4EncoderEnvelope } from "@storycapture/shared-types/recording-v4";

import {
  MACOS_RECORDING_V4_PROTOCOL_VERSION,
  MacRecordingV4Backend,
  MacRecordingV4Error,
  type MacRecordingV4HelperResponse,
  type MacRecordingV4Transport,
  type MacRecordingV4WarmupInput,
} from "./macos-recording-v4-backend";

const envelope: RecordingV4EncoderEnvelope = {
  source: "live_calibration",
  encoder_id: "videotoolbox-h264",
  minimum_bitrate_bps: 10_000_000,
  target_bitrate_bps: 20_000_000,
  maximum_bitrate_bps: 30_000_000,
  safety_headroom_ratio: 0.25,
};

const warmupInput: MacRecordingV4WarmupInput = {
  target: {
    identity: {
      kind: "author_preview",
      stable_id: "stable-window-42",
      process_id: 99,
      initial_title: "Preview",
    },
    windowId: 42,
    ownerBundleId: "com.storycapture.desktop",
    mediaSourceId: "window:42:0",
    logicalWidth: 1_920,
    logicalHeight: 1_080,
  },
  requestedAudioRoles: ["system", "microphone"],
  encoderEnvelope: envelope,
};

class FakeTransport implements MacRecordingV4Transport {
  readonly requests: Array<{ command: string; options: unknown }> = [];
  helloVersion = 4;
  failure: { command: string; code: string } | null = null;

  async request(
    command: "hello" | "warmup" | "start" | "pause" | "resume" | "stop" | "cancel" | "shutdown",
    options?: { sessionId?: string; payload?: Record<string, unknown> },
  ): Promise<MacRecordingV4HelperResponse> {
    this.requests.push({ command, options });
    if (this.failure?.command === command) {
      throw new MacRecordingV4Error(this.failure.code as "encoder_backpressure", this.failure.code);
    }
    if (command === "hello") {
      return {
        version: this.helloVersion,
        event: "hello",
        ok: true,
        data: {
          backend_id: "screen-capture-kit",
          backend_version: "4.0.0",
          platform: "darwin",
          arch: "arm64",
          profile: "verified_1080p60",
          supports_monotonic_60hz_scheduler: true,
          supports_frame_ledger: true,
          supports_encoder_envelope: true,
          supports_terminal_backpressure: true,
          supports_shared_audio_clock: true,
          supported_audio_roles: ["microphone", "system"],
        },
      };
    }
    if (command === "warmup") {
      return {
        version: 4,
        event: "warmed-up",
        ok: true,
        data: {
          permission_granted: true,
          target_identity: "stable-window-42",
          physical_width: 1_920,
          physical_height: 1_080,
          encoder: {
            encoder_id: "videotoolbox-h264",
            hardware_accelerated: true,
            requested_bitrate_bps: 20_000_000,
            average_bitrate_bps: 19_000_000,
            peak_bitrate_bps: 23_000_000,
            envelope,
          },
        },
      };
    }
    if (command === "stop") {
      return {
        version: 4,
        event: "stopped",
        ok: true,
        data: terminalEvidence(),
      };
    }
    return { version: 4, event: command, ok: true, data: {} };
  }

  close(): void {}
}

function terminalEvidence(): Record<string, unknown> {
  return {
    version: 4,
    profile: "verified_1080p60",
    artifact_path: "/take/master/video.mp4",
    artifact_bytes: 42_000,
    finalized: true,
    artifact: { finalized: true, full_decode_succeeded: true, decoded_frames: 2 },
    cadence: {
      version: 4,
      frame_rate: { numerator: 60, denominator: 1 },
      active_duration_us: 33_333,
      expected_output_frames: 2,
      output_frames: 2,
      source_updates: 1,
      held_frames: 1,
      submitted_frames: 2,
      acknowledged_frames: 2,
      ring_high_water_mark: 1,
      pause_intervals: [],
      ledger: [
        {
          slot: 0,
          pts_us: 0,
          source_sequence: 1,
          source_timestamp_us: 0,
          held_from_slot: null,
          submitted_at_us: 1,
          acknowledged_at_us: 2,
        },
        {
          slot: 1,
          pts_us: 16_667,
          source_sequence: 1,
          source_timestamp_us: 0,
          held_from_slot: 0,
          submitted_at_us: 3,
          acknowledged_at_us: 4,
        },
      ],
      verdict: "passed",
      failure_codes: [],
    },
    encoder_evidence: {
      encoder_id: "videotoolbox-h264",
      hardware_accelerated: true,
      requested_bitrate_bps: 20_000_000,
      average_bitrate_bps: 19_000_000,
      peak_bitrate_bps: 23_000_000,
      envelope,
    },
    audio_evidence: [
      {
        role: "microphone",
        requested: true,
        status: "captured",
        codec: "pcm_f32le",
        sample_rate_hz: 48_000,
        channels: 2,
        started_offset_us: 0,
        duration_us: 33_333,
        end_drift_us: 0,
        sync_tolerance_us: 50_000,
        pause_mapping_valid: true,
        continuity_gaps: 0,
        ledger: [{ sequence: 0, pts_us: 0, duration_us: 33_333, frames: 1_600 }],
        failure_codes: [],
      },
      {
        role: "system",
        requested: true,
        status: "captured",
        codec: "aac",
        sample_rate_hz: 48_000,
        channels: 2,
        started_offset_us: 0,
        duration_us: 33_333,
        end_drift_us: 0,
        sync_tolerance_us: 50_000,
        pause_mapping_valid: true,
        continuity_gaps: 0,
        ledger: [{ sequence: 0, pts_us: 0, duration_us: 33_333, frames: 1_600 }],
        failure_codes: [],
      },
    ],
    audio_track_roles: ["microphone", "system"],
  };
}

describe("MacRecordingV4Backend", () => {
  it("uses only V4 and sends exact target/audio/envelope warmup evidence", async () => {
    const fake = new FakeTransport();
    const backend = new MacRecordingV4Backend("/helper", () => fake);
    await backend.warmup(warmupInput);
    expect(fake.requests.map((request) => request.command)).toEqual(["hello", "warmup"]);
    expect(fake.requests[1]).toMatchObject({
      options: {
        payload: {
          outputWidth: 1_920,
          outputHeight: 1_080,
          fpsNumerator: 60,
          fpsDenominator: 1,
          requestedAudioRoles: ["microphone", "system"],
          encoderEnvelope: envelope,
          target: {
            kind: "window",
            windowID: 42,
            ownerPID: 99,
            expectedIdentity: "stable-window-42",
          },
        },
      },
    });
    expect(MACOS_RECORDING_V4_PROTOCOL_VERSION).toBe(4);
  });

  it("rejects incomplete or downgraded helper capabilities", async () => {
    const fake = new FakeTransport();
    fake.helloVersion = 3;
    const backend = new MacRecordingV4Backend("/helper", () => fake);
    await expect(backend.hello()).rejects.toMatchObject({ code: "helper_protocol_mismatch" });
  });

  it("runs warmup, start, pause, resume and validates terminal evidence", async () => {
    const fake = new FakeTransport();
    const backend = new MacRecordingV4Backend("/helper", () => fake);
    await backend.warmup(warmupInput);
    await backend.start({
      ...warmupInput,
      sessionId: "take-v4",
      artifactPath: "/take/master/video.mp4",
    });
    await backend.pause();
    await backend.resume();
    const result = await backend.stop();
    expect(result).toMatchObject({
      version: 4,
      profile: "verified_1080p60",
      finalized: true,
      cadence: { verdict: "passed" },
      encoder_evidence: { hardware_accelerated: true },
    });
  });

  it("preserves terminal encoder backpressure without fallback", async () => {
    const fake = new FakeTransport();
    const backend = new MacRecordingV4Backend("/helper", () => fake);
    await backend.warmup(warmupInput);
    await backend.start({
      ...warmupInput,
      sessionId: "take-v4",
      artifactPath: "/take/master/video.mp4",
    });
    fake.failure = { command: "stop", code: "encoder_backpressure" };
    await expect(backend.stop()).rejects.toMatchObject({ code: "encoder_backpressure" });
  });
});
