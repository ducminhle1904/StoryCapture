import type {
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it, vi } from "vitest";
import {
  resolveWindowsCaptureHelperPath,
  WindowsGraphicsCaptureBackend,
  WindowsNativeMp4CaptureSession,
  windowsCertificationMatches,
} from "./windows-capture-backend";
import type {
  WindowsCaptureFrameCommit,
  WindowsCaptureHelperCommand,
  WindowsCaptureHelperEvent,
  WindowsCaptureHelperTransport,
  WindowsCaptureProbeResult,
  WindowsCaptureRingDescriptor,
  WindowsNativeCaptureHelperCommand,
  WindowsNativeCaptureHelperEvent,
  WindowsNativeCaptureHelperTransport,
  WindowsNativeFrameSink,
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
  audio_roles: ["microphone", "system"],
  desired_tier: {
    version: 2,
    id: "windows-display-tier",
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

const nativeProbe: WindowsCaptureProbeResult = {
  backend_id: "windows-graphics-capture",
  backend_version: "1.0.0",
  gpu_identity: "Test Adapter",
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

const ring: WindowsCaptureRingDescriptor = {
  mapping_name: "Local\\StoryCaptureWgcRing-session-1-owner-1",
  frame_event_name: "Local\\StoryCaptureWgcFrame-session-1-owner-1",
  ownership_token: "owner-1",
  capacity: 8,
  width: 2_560,
  height: 1_440,
  stride: 10_240,
  pixel_format: "bgra",
};

class FakeTransport implements WindowsCaptureHelperTransport {
  readonly commands: WindowsCaptureHelperCommand[] = [];
  closed = false;
  private readonly eventListeners = new Set<(event: WindowsCaptureHelperEvent) => void>();
  private readonly exitListeners = new Set<
    (exitCode: number | null, signal: NodeJS.Signals | null) => void
  >();

  async start(): Promise<void> {
    this.emit({
      version: 2,
      type: "hello",
      backend_id: "windows-graphics-capture",
      backend_version: "1.0.0",
      process_id: 123,
    });
  }

  async send(command: WindowsCaptureHelperCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "probe") {
      this.emit({ version: 2, type: "probe-result", result: nativeProbe });
    } else if (command.type === "start") {
      this.emit({
        version: 2,
        type: "clock-anchor",
        session_id: command.session_id,
        qpc_timestamp_us: 4_200,
        audio_sample_rate: 48_000,
      });
      this.emit({ version: 2, type: "ready", session_id: command.session_id, ring });
    } else if (command.type === "pause") {
      this.emit({ version: 2, type: "paused", session_id: command.session_id as string });
    } else if (command.type === "resume") {
      this.emit({ version: 2, type: "resumed", session_id: command.session_id as string });
    } else if (command.type === "stop") {
      this.emit({ version: 2, type: "stopped", session_id: command.session_id as string });
    }
  }

  onEvent(listener: (event: WindowsCaptureHelperEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(event: WindowsCaptureHelperEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  exit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code, null);
  }
}

class FakeNativeSink implements WindowsNativeFrameSink {
  descriptor: WindowsCaptureRingDescriptor | null = null;
  readonly frames: WindowsCaptureFrameCommit[] = [];
  closed = false;
  failCode: RecordingQualityFailureCode | null = null;

  async open(descriptor: WindowsCaptureRingDescriptor): Promise<void> {
    this.descriptor = descriptor;
  }

  async commit(frame: WindowsCaptureFrameCommit): Promise<void> {
    if (this.failCode) throw new Error(this.failCode);
    this.frames.push(frame);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeNativeMp4Transport implements WindowsNativeCaptureHelperTransport {
  readonly commands: WindowsNativeCaptureHelperCommand[] = [];
  private readonly listeners = new Set<(event: WindowsNativeCaptureHelperEvent) => void>();
  private pendingStartedSessionId: string | null = null;

  constructor(private readonly deferStarted = false) {}

  async start(): Promise<void> {
    this.emit({
      version: 3,
      type: "hello",
      backend_id: "windows-graphics-capture",
      backend_version: "1.0.0",
      process_id: 123,
    });
  }

  async send(command: WindowsNativeCaptureHelperCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "capabilities") {
      this.emit({
        version: 3,
        type: "capabilities",
        capabilities: {
          backend_id: "windows-graphics-capture",
          backend_version: "1.0.0",
          platform: "win32",
          arch: "x64",
          target_classes: ["display", "window"],
          codec: "h264",
          pixel_format: "nv12",
          exact_fps: { numerator: 60, denominator: 1 },
          hardware_accelerated: true,
          supports_pause_resume: true,
          keeps_surfaces_native: true,
          encoder_id: "hardware-h264",
          gpu_identity: null,
          adapter_luid: null,
        },
      });
    } else if (command.type === "start") {
      if (this.deferStarted) this.pendingStartedSessionId = command.session_id;
      else this.emit({ version: 3, type: "started", session_id: command.session_id });
    } else if (command.type === "pause" || command.type === "resume") {
      this.emit({
        version: 3,
        type: `${command.type}d` as "paused" | "resumed",
        session_id: command.session_id,
      });
    } else if (command.type === "stop") {
      this.emit({
        version: 3,
        type: "finalized",
        session_id: command.session_id,
        evidence: {
          artifact_path: "/tmp/master.mp4",
          codec: "h264",
          pixel_format: "nv12",
          width: 1_920,
          height: 1_080,
          exact_fps: { numerator: 60, denominator: 1 },
          source_frames: 3,
          output_frames: 6,
          held_frames: 3,
          encoder_dropped_frames: 0,
          backpressure_events: 0,
          unresolved_backpressure_events: 0,
          pts_gaps: 0,
          pts_duplicates: 0,
          pts_non_monotonic: 0,
          initial_surface_received: true,
          started_monotonic_us: 1,
          ended_monotonic_us: 100_001,
          finalized_duration_us: 100_000,
          encoder_id: "hardware-h264",
          hardware_accelerated: true,
          finalized: true,
          failure_codes: [],
        },
      });
    }
  }

  onEvent(listener: (event: WindowsNativeCaptureHelperEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {}

  releaseStarted(): void {
    if (!this.pendingStartedSessionId) throw new Error("no pending native start");
    this.emit({ version: 3, type: "started", session_id: this.pendingStartedSessionId });
    this.pendingStartedSessionId = null;
  }

  private emit(event: WindowsNativeCaptureHelperEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function frame(
  deliverySequence: number,
  sourceFrameIndex: number,
  nativePtsUs: number,
): WindowsCaptureHelperEvent {
  return {
    version: 2,
    type: "frame-committed",
    session_id: "session-1",
    delivery_sequence: deliverySequence,
    source_frame_index: sourceFrameIndex,
    native_pts_us: nativePtsUs,
    duration_us: deliverySequence === 1 ? 16_667 : nativePtsUs - (nativePtsUs - 16_667),
    slot_index: (deliverySequence - 1) % 8,
    width: 2_560,
    height: 1_440,
    stride: 10_240,
    pixel_format: "bgra",
    ownership_token: "owner-1",
  };
}

function createBackend(
  input: {
    transport?: FakeTransport;
    sink?: FakeNativeSink;
    onFailure?: (error: Error) => void;
    onClockAnchor?: (anchor: { qpcTimestampUs: number; audioSampleRate: 48_000 }) => void;
    platform?: NodeJS.Platform;
  } = {},
) {
  const transport = input.transport ?? new FakeTransport();
  const sink = input.sink ?? new FakeNativeSink();
  const backend = new WindowsGraphicsCaptureBackend({
    target: { kind: "display", device_path: "\\\\?\\DISPLAY#TEST" },
    cursorPolicy: "include",
    dynamicSizePolicy: "fail",
    ownershipToken: "owner-1",
    nativeFrameSink: sink,
    transport,
    platform: input.platform ?? "win32",
    arch: "x64",
    onFailure: input.onFailure,
    onClockAnchor: input.onClockAnchor,
    probeContext: async () => ({
      certificationMatch: true,
      encodeThroughputRatio: 1.5,
      estimatedBytesPerSecond: 100,
      requiredBytesForTenMinutes: 60_000,
      availableBytes: 80_000,
      reserveBytes: 10_000,
    }),
  });
  return { backend, transport, sink };
}

describe("Windows Graphics Capture backend", () => {
  it("probes through the common guard and preserves a larger physical master", async () => {
    const { backend } = createBackend();
    await expect(backend.probe(request)).resolves.toMatchObject({
      backend_id: "windows-graphics-capture",
      strict_eligible: true,
      source_rate: { measured_fps: { numerator: 60, denominator: 1 } },
    });
    expect(backend.state).toBe("ready");
  });

  it("runs start, frame, pause, resume, audio-clock, and idempotent stop semantics", async () => {
    const clock = vi.fn();
    const { backend, transport, sink } = createBackend({ onClockAnchor: clock });
    await backend.probe(request);
    await backend.start({ session_id: "session-1", request });
    expect(sink.descriptor).toEqual(ring);
    expect(clock).toHaveBeenCalledWith({ qpcTimestampUs: 4_200, audioSampleRate: 48_000 });

    transport.emit(frame(1, 10, 0));
    transport.emit(frame(2, 11, 16_667));
    await vi.waitFor(() => {
      expect(sink.frames.map((value) => value.delivery_sequence)).toEqual([1, 2]);
    });

    await backend.pause();
    expect(backend.state).toBe("paused");
    await backend.resume();
    expect(backend.state).toBe("capturing");
    transport.emit(frame(3, 100, 33_334));
    await vi.waitFor(() => {
      expect(sink.frames.at(-1)?.source_frame_index).toBe(100);
    });

    await backend.stop();
    await backend.stop();
    expect(backend.state).toBe("stopped");
    expect(sink.closed).toBe(true);
    expect(transport.commands.filter((command) => command.type === "stop")).toHaveLength(1);
  });

  it("fails closed on resize, target loss, helper exit, sequence gaps, and sink rejection", async () => {
    for (const event of [
      {
        version: 2,
        type: "format-changed",
        session_id: "session-1",
        width: 2_000,
        height: 1_000,
      } as const,
      {
        version: 2,
        type: "target-lost",
        session_id: "session-1",
        failure_code: "target_lost",
      } as const,
    ]) {
      const failure = vi.fn();
      const { backend, transport } = createBackend({ onFailure: failure });
      await backend.probe(request);
      await backend.start({ session_id: "session-1", request });
      transport.emit(event);
      expect(backend.state).toBe("failed");
      expect(failure).toHaveBeenCalledOnce();
    }

    const exited = createBackend();
    await exited.backend.probe(request);
    await exited.backend.start({ session_id: "session-1", request });
    exited.transport.exit(70);
    expect(exited.backend.failure?.failureCode).toBe("backend_unavailable");

    const sequenceGap = createBackend();
    await sequenceGap.backend.probe(request);
    await sequenceGap.backend.start({ session_id: "session-1", request });
    sequenceGap.transport.emit(frame(2, 2, 16_667));
    await vi.waitFor(() => {
      expect(sequenceGap.backend.failure?.failureCode).toBe("submitted_frame_dropped");
    });

    const sink = new FakeNativeSink();
    sink.failCode = "frame_ring_overflow";
    const rejected = createBackend({ sink });
    await rejected.backend.probe(request);
    await rejected.backend.start({ session_id: "session-1", request });
    rejected.transport.emit(frame(1, 1, 0));
    await vi.waitFor(() => {
      expect(rejected.backend.failure?.failureCode).toBe("submitted_frame_dropped");
    });
  });

  it("rejects unsupported platforms before spawning the helper", async () => {
    const { backend, transport } = createBackend({ platform: "darwin" });
    await expect(backend.probe(request)).rejects.toMatchObject({
      failureCode: "backend_unavailable",
    });
    expect(transport.commands).toHaveLength(0);
  });

  it("resolves deterministic development and packaged helper paths", () => {
    expect(windowsCertificationMatches(request, nativeProbe, "x64")).toBe(true);
    vi.stubEnv("STORYCAPTURE_DISABLE_RECORDING_TIER_IDS", "windows-display-tier");
    expect(windowsCertificationMatches(request, nativeProbe, "x64")).toBe(false);
    vi.unstubAllEnvs();
    expect(
      windowsCertificationMatches(
        request,
        { ...nativeProbe, hardware_fingerprint: "another-gpu" },
        "x64",
      ),
    ).toBe(false);
    expect(
      resolveWindowsCaptureHelperPath({
        isPackaged: true,
        resourcesPath: "C:\\StoryCapture\\resources",
        appPath: "C:\\StoryCapture\\app",
        arch: "x64",
      }),
    ).toBe("C:\\StoryCapture\\resources/native/windows/x64/storycapture-wgc.exe");
    expect(
      resolveWindowsCaptureHelperPath({
        isPackaged: false,
        resourcesPath: "C:\\StoryCapture\\resources",
        appPath: "C:\\StoryCapture\\app",
        arch: "arm64",
      }),
    ).toBe("C:\\StoryCapture\\app/native/windows-capture/bin/arm64/storycapture-wgc.exe");
  });
});

describe("Windows native MP4 capture session", () => {
  it("does not resolve start before the helper confirms the first encoded surface", async () => {
    const transport = new FakeNativeMp4Transport(true);
    const session = new WindowsNativeMp4CaptureSession({ transport, platform: "win32" });
    await session.capabilities();
    const start = session.start({
      session_id: "session-ready",
      output_path: "/tmp/master.mp4",
      target: { kind: "display", device_path: "\\\\?\\DISPLAY#TEST" },
      cursor_policy: "include",
      dynamic_size_policy: "fail",
      requested_width: 1_920,
      requested_height: 1_080,
      requested_fps: { numerator: 60, denominator: 1 },
    });
    await Promise.resolve();
    expect(session.state).toBe("starting");
    transport.releaseStarted();
    await start;
    expect(session.state).toBe("capturing");
  });

  it("runs capability, exact HWND start, pause/resume, and stop-finalize", async () => {
    const transport = new FakeNativeMp4Transport();
    const session = new WindowsNativeMp4CaptureSession({ transport, platform: "win32" });
    await expect(session.capabilities()).resolves.toMatchObject({
      codec: "h264",
      hardware_accelerated: true,
      keeps_surfaces_native: true,
    });
    await session.start({
      session_id: "session-3",
      output_path: "/tmp/master.mp4",
      target: {
        kind: "window",
        hwnd: "0x123",
        process_id: 42,
        executable_path: "C:\\StoryCapture\\StoryCapture.exe",
        class_name: "Chrome_WidgetWin_1",
      },
      cursor_policy: "include",
      dynamic_size_policy: "fail",
      requested_width: 1_920,
      requested_height: 1_080,
      requested_fps: { numerator: 60, denominator: 1 },
    });
    await session.pause();
    await session.resume();
    await expect(session.stop()).resolves.toMatchObject({
      artifact_path: "/tmp/master.mp4",
      output_frames: 6,
      held_frames: 3,
      finalized: true,
    });
    expect(transport.commands.map((command) => command.type)).toEqual([
      "capabilities",
      "start",
      "pause",
      "resume",
      "stop",
    ]);
  });
});
