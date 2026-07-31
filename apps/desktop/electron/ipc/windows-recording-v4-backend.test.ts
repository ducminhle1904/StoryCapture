import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  encodeWindowsRecordingV4Command,
  parseWindowsRecordingV4Event,
  resolveWindowsRecordingV4HelperPath,
  WINDOWS_RECORDING_V4_PROTOCOL_VERSION,
  WindowsRecordingV4Backend,
  WindowsRecordingV4ProtocolError,
  type WindowsRecordingV4Command,
  type WindowsRecordingV4Event,
  type WindowsRecordingV4Transport,
} from "./windows-recording-v4-backend";

const envelope = {
  source: "live_calibration" as const,
  encoder_id: "Intel Quick Sync H.264 Encoder MFT",
  minimum_bitrate_bps: 10_000_000,
  target_bitrate_bps: 20_000_000,
  maximum_bitrate_bps: 30_000_000,
  safety_headroom_ratio: 0.25,
};

const startOptions = {
  session_id: "session-v4",
  output_path: "C:\\recording\\master.mp4",
  target: {
    kind: "window" as const,
    hwnd: "0x123",
    process_id: 42,
    executable_path: "C:\\App\\app.exe",
    class_name: "AppWindow",
  },
  target_identity: {
    kind: "window" as const,
    stable_id: "window-42",
    process_id: 42,
    initial_title: "App",
  },
  include_cursor: true,
  requested_audio_roles: ["system" as const],
  encoder_envelope: envelope,
};

function capabilitiesEvent(): WindowsRecordingV4Event {
  return {
    version: 4,
    type: "capabilities",
    capabilities: {
      backend_id: "windows-graphics-capture",
      backend_version: "1.0.0",
      platform: "win32",
      arch: "x64",
      codec: "h264",
      pixel_format: "nv12",
      exact_fps: { numerator: 60, denominator: 1 },
      physical_width: 1_920,
      physical_height: 1_080,
      hardware_accelerated: true,
      keeps_surfaces_native: true,
      supports_pause_resume: true,
      supports_microphone: true,
      supports_system_audio: true,
      encoder_id: envelope.encoder_id,
    },
  };
}

class FakeTransport implements WindowsRecordingV4Transport {
  readonly commands: WindowsRecordingV4Command[] = [];
  private readonly events = new EventEmitter();

  async start(): Promise<void> {}

  async send(command: WindowsRecordingV4Command): Promise<void> {
    this.commands.push(command);
    queueMicrotask(() => {
      if (command.type === "capabilities") this.events.emit("event", capabilitiesEvent());
      else if (command.type === "start" || command.type === "pause" || command.type === "resume") {
        this.events.emit("event", { version: 4, type: command.type === "start" ? "started" :
          command.type === "pause" ? "paused" : "resumed", session_id: command.session_id });
      } else if (command.type === "cancel") {
        this.events.emit("event", { version: 4, type: "cancelled", session_id: command.session_id });
      }
    });
  }

  onEvent(listener: (event: WindowsRecordingV4Event) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async close(): Promise<void> {}
}

describe("Windows Recording V4 helper protocol", () => {
  it("rejects non-V4 and surplus protocol fields fail-closed", () => {
    expect(() => parseWindowsRecordingV4Event(JSON.stringify({
      ...capabilitiesEvent(),
      version: 3,
    }))).toThrow(WindowsRecordingV4ProtocolError);
    expect(() => parseWindowsRecordingV4Event(JSON.stringify({
      ...capabilitiesEvent(),
      pixels: "forbidden",
    }))).toThrow(/fields/);
  });

  it("requires exact verified 1080p60 native capability evidence", () => {
    expect(parseWindowsRecordingV4Event(JSON.stringify(capabilitiesEvent()))).toEqual(capabilitiesEvent());
    const invalid = capabilitiesEvent();
    if (invalid.type !== "capabilities") throw new Error("unexpected fixture");
    invalid.capabilities.physical_width = 1_280 as 1920;
    expect(() => parseWindowsRecordingV4Event(JSON.stringify(invalid))).toThrow(/capabilities/);
  });

  it("validates exact cadence, hold, submit, and acknowledgement evidence", () => {
    const finalized = {
      version: 4,
      type: "finalized",
      session_id: "session-v4",
      evidence: {
        artifact_path: "C:\\recording\\master.mp4",
        encoder: {
          encoder_id: envelope.encoder_id,
          hardware_accelerated: true,
          requested_bitrate_bps: 20_000_000,
          average_bitrate_bps: 19_000_000,
          peak_bitrate_bps: 25_000_000,
          envelope,
        },
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
            { slot: 0, pts_us: 0, source_sequence: 1, source_timestamp_us: 2_000,
              held_from_slot: null, submitted_at_us: 2_100, acknowledged_at_us: 2_200 },
            { slot: 1, pts_us: 16_667, source_sequence: 1, source_timestamp_us: 2_000,
              held_from_slot: 0, submitted_at_us: 18_800, acknowledged_at_us: 18_900 },
          ],
          verdict: "passed",
          failure_codes: [],
        },
        audio: [{
          role: "system",
          requested: true,
          status: "captured",
          codec: "pcm_f32le",
          sample_rate_hz: 48_000,
          channels: 2,
          started_offset_us: 2_000,
          duration_us: 33_333,
          end_drift_us: 0,
          sync_tolerance_us: 20_000,
          pause_mapping_valid: true,
          continuity_gaps: 0,
          ledger: [
            { sequence: 0, pts_us: 0, duration_us: 10_000, frames: 480 },
            { sequence: 1, pts_us: 10_000, duration_us: 10_000, frames: 480 },
          ],
          failure_codes: [],
        }],
        finalized: true,
        failure_codes: [],
      },
    };
    expect(parseWindowsRecordingV4Event(JSON.stringify(finalized))).toMatchObject({
      type: "finalized",
      evidence: { cadence: { held_frames: 1, acknowledged_frames: 2 } },
    });
    finalized.evidence.cadence.ledger[1]!.acknowledged_at_us = 18_700;
    expect(() => parseWindowsRecordingV4Event(JSON.stringify(finalized))).toThrow(/ledger/);
    finalized.evidence.cadence.ledger[1]!.acknowledged_at_us = 18_900;
    finalized.evidence.audio[0]!.end_drift_us = 20_001;
    expect(() => parseWindowsRecordingV4Event(JSON.stringify(finalized))).toThrow(/continuity or sync/);
    finalized.evidence.audio[0]!.end_drift_us = 0;
    finalized.evidence.encoder.peak_bitrate_bps = 18_000_000;
    expect(() => parseWindowsRecordingV4Event(JSON.stringify(finalized))).toThrow(/Encoder evidence/);
  });

  it("encodes V4 commands and drives lifecycle through an injected transport", async () => {
    const transport = new FakeTransport();
    const backend = new WindowsRecordingV4Backend({ transport, platform: "win32" });
    expect((await backend.capabilities()).physical_width).toBe(1_920);
    await backend.start(startOptions);
    await backend.pause();
    await backend.resume();
    await backend.cancel();
    expect(transport.commands.map((command) => command.type)).toEqual([
      "capabilities", "start", "pause", "resume", "cancel",
    ]);
    expect(JSON.parse(encodeWindowsRecordingV4Command({ version: 4, type: "capabilities" }))).toEqual({
      version: WINDOWS_RECORDING_V4_PROTOCOL_VERSION,
      type: "capabilities",
    });
  });

  it("resolves only supported packaged architectures", () => {
    expect(resolveWindowsRecordingV4HelperPath({ isPackaged: true, resourcesPath: "C:\\resources",
      appPath: "C:\\app", arch: "arm64" })).toMatch(/native[\\/]windows[\\/]arm64[\\/]storycapture-wgc\.exe$/);
    expect(() => resolveWindowsRecordingV4HelperPath({ isPackaged: false, resourcesPath: "x",
      appPath: "x", arch: "ia32" })).toThrow(/architecture/);
  });
});
