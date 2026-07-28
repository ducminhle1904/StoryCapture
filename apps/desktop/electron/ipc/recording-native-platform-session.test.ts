import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  macConstructor: vi.fn(),
  macProbe: vi.fn(),
  macStart: vi.fn(),
  macStop: vi.fn(),
  windowsCapabilities: vi.fn(),
  windowsStart: vi.fn(),
  windowsStop: vi.fn(),
  windowsShutdown: vi.fn(),
}));

vi.mock("./macos-screen-capture-backend", () => ({
  MacOSNativeMasterBackend: class {
    constructor(options: unknown) {
      mocks.macConstructor(options);
    }
    probeCapabilities = mocks.macProbe;
    start = mocks.macStart;
    pause = vi.fn();
    resume = vi.fn();
    stop = mocks.macStop;
    close = vi.fn();
  },
}));

vi.mock("./windows-capture-backend", () => ({
  WindowsNativeMp4CaptureSession: class {
    capabilities = mocks.windowsCapabilities;
    start = mocks.windowsStart;
    pause = vi.fn();
    resume = vi.fn();
    stop = mocks.windowsStop;
    shutdown = mocks.windowsShutdown;
  },
}));

import { createRecordingNativePlatformSession } from "./recording-native-platform-session";

const dimensions = {
  logical_width: 1920,
  logical_height: 1080,
  capture_dpr: 1,
  physical_width: 1920,
  physical_height: 1080,
  requested_output_width: 1920,
  requested_output_height: 1080,
};

const surface = {
  macTarget: () => ({ kind: "window", windowID: 42, mediaSourceID: "window:42:0" }),
  windowsTarget: () => ({
    kind: "window",
    hwnd: "42",
    process_id: 10,
    executable_path: "StoryCapture.exe",
    class_name: "Chrome_WidgetWin_1",
  }),
};

describe("recording native platform session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.macProbe.mockResolvedValue({ encoder: { id: "videotoolbox-h264" } });
    mocks.macStop.mockResolvedValue({ artifact_path: "/tmp/master.mp4" });
    mocks.windowsCapabilities.mockResolvedValue({ encoder_id: "mf-h264" });
    mocks.windowsStop.mockResolvedValue({
      artifact_path: "C:\\master.mp4",
      codec: "h264",
      pixel_format: "nv12",
      width: 1920,
      height: 1080,
      source_frames: 60,
      output_frames: 60,
      held_frames: 0,
      encoder_dropped_frames: 0,
      backpressure_events: 0,
      unresolved_backpressure_events: 0,
      pts_gaps: 0,
      pts_duplicates: 0,
      pts_non_monotonic: 0,
      started_monotonic_us: 1,
      ended_monotonic_us: 1_000_001,
      finalized_duration_us: 1_000_000,
      encoder_id: "mf-h264",
      finalized: true,
      failure_codes: [],
    });
  });

  it("starts macOS against the exact Electron window target", async () => {
    const session = createRecordingNativePlatformSession({
      platform: "darwin",
      helperPath: "/helper",
      sessionId: "take-1",
      artifactPath: "/tmp/master.mp4",
      dimensions,
      surface: surface as never,
    });
    await session.start();

    expect(mocks.macConstructor).toHaveBeenCalledWith({
      helperPath: "/helper",
      target: surface.macTarget(),
    });
    expect(mocks.macStart).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPath: "/tmp/master.mp4",
        outputWidth: 1920,
        outputHeight: 1080,
        fps: { numerator: 60, denominator: 1 },
      }),
    );
  });

  it("maps Windows native finalization metadata without raw frame transport", async () => {
    const session = createRecordingNativePlatformSession({
      platform: "win32",
      helperPath: "C:\\helper.exe",
      sessionId: "take-2",
      artifactPath: "C:\\master.mp4",
      dimensions,
      surface: surface as never,
    });
    await session.start();
    const evidence = await session.stop();

    expect(mocks.windowsStart).toHaveBeenCalledWith(
      expect.objectContaining({
        target: surface.windowsTarget(),
        requested_fps: { numerator: 60, denominator: 1 },
      }),
    );
    expect(evidence).toMatchObject({
      source_updates: 60,
      output_frames: 60,
      encoder: { id: "mf-h264", hardware_accelerated: true },
      artifact: { full_decode_succeeded: false, decoded_frames: 0 },
    });
  });
});
