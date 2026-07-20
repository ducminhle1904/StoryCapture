import type {
  RecordingCertifiedTier,
  RecordingPreflightV2Request,
} from "@storycapture/shared-types/recording-v2";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getGPUInfo: vi.fn(async () => ({ gpu: "test" })) },
  BrowserWindow: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("ffmpeg-static", () => ({ default: null }));

import {
  BrowserCaptureBackendV2,
  BrowserHighResolutionClock,
  type BrowserPaintListener,
  type BrowserRecordingMasterSink,
  type BrowserRecordingSurface,
  type BrowserRecordingSurfacePlan,
  browserRecordingSurfacePlan,
} from "./browser-capture-backend-v2";
import type { RecordingFrameInput } from "./recording-frame-ring";
import type { PcmWavInput } from "./recording-master";

const PHYSICAL_WIDTH = 1_920;
const PHYSICAL_HEIGHT = 1_080;
const FRAME_BYTES = PHYSICAL_WIDTH * PHYSICAL_HEIGHT * 4;

class FakeBrowserSurface implements BrowserRecordingSurface {
  readonly automationContents = {} as never;
  readonly plans: BrowserRecordingSurfacePlan[] = [];
  readonly frames = Buffer.alloc(FRAME_BYTES);
  readonly contents = {
    setFrameRate: vi.fn((fps: number) => {
      this.frameRate = fps;
    }),
    invalidate: vi.fn(() => {
      this.invalidations += 1;
      if (this.automaticPaintLimit === null || this.emittedFrames < this.automaticPaintLimit) {
        queueMicrotask(() => this.emitPaint());
      }
    }),
  };
  frameRate = 0;
  invalidations = 0;
  emittedFrames = 0;
  releasedTextures = 0;
  automaticPaintLimit: number | null = null;
  destroyed = false;
  private paintListener: BrowserPaintListener | null = null;
  private targetLostListener: ((reason: string) => void) | null = null;
  private loadListener: (() => void) | null = null;

  async loadURL(_url: string): Promise<void> {
    this.loadListener?.();
  }

  onPaint(listener: BrowserPaintListener): void {
    this.paintListener = listener;
  }

  offPaint(listener: BrowserPaintListener): void {
    if (this.paintListener === listener) this.paintListener = null;
  }

  onTargetLost(listener: (reason: string) => void): void {
    this.targetLostListener = listener;
  }

  onLoadCommitted(listener: () => void): void {
    this.loadListener = listener;
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  emitPaint(options: { texture?: boolean; firstByte?: number } = {}): void {
    if (!this.paintListener) return;
    this.emittedFrames += 1;
    this.frames[0] = options.firstByte ?? this.emittedFrames % 256;
    const texture =
      options.texture === false ? undefined : { release: () => (this.releasedTextures += 1) };
    this.paintListener(
      { texture },
      { x: 0, y: 0, width: PHYSICAL_WIDTH, height: PHYSICAL_HEIGHT },
      {
        getSize: () => ({ width: PHYSICAL_WIDTH, height: PHYSICAL_HEIGHT }),
        toBitmap: () => this.frames,
      },
    );
  }

  reload(): void {
    this.loadListener?.();
  }

  loseTarget(reason = "renderer crashed"): void {
    this.targetLostListener?.(reason);
  }
}

class FakeMasterSink implements BrowserRecordingMasterSink {
  readonly frames: Array<RecordingFrameInput & { firstByte: number }> = [];
  readonly audio: Array<{ role: "microphone" | "system"; input: PcmWavInput }> = [];
  submitImplementation: (frame: RecordingFrameInput) => Promise<void> = async () => undefined;
  finalize = vi.fn(async () => ({ status: "completed" }) as never);

  async submit(frame: RecordingFrameInput): Promise<void> {
    this.frames.push({ ...frame, pixels: frame.pixels, firstByte: frame.pixels[0] });
    await this.submitImplementation(frame);
  }

  async writeAudioSidecar(role: "microphone" | "system", input: PcmWavInput): Promise<void> {
    this.audio.push({ role, input });
  }
}

function tier(): RecordingCertifiedTier {
  return {
    version: 2,
    id: "browser-test",
    stage: "certified",
    target_class: "browser",
    platform: "darwin",
    arch: "arm64",
    backend_id: "electron_offscreen_shared_texture_bitmap_copy",
    backend_version: "test",
    hardware_fingerprint: "hardware-test",
    exact_fps: { numerator: 60, denominator: 1 },
    output_width: PHYSICAL_WIDTH,
    output_height: PHYSICAL_HEIGHT,
  };
}

function request(): RecordingPreflightV2Request {
  return {
    version: 2,
    delivery_policy: "strict",
    target_class: "browser",
    requested_fps: { numerator: 60, denominator: 1 },
    dimensions: {
      logical_width: 960,
      logical_height: 540,
      capture_dpr: 2,
      physical_width: PHYSICAL_WIDTH,
      physical_height: PHYSICAL_HEIGHT,
      requested_output_width: PHYSICAL_WIDTH,
      requested_output_height: PHYSICAL_HEIGHT,
    },
    audio_roles: [],
    desired_tier: tier(),
  };
}

function nanosecondClock(step = 16_667_000n): () => bigint {
  let value = -step;
  return () => {
    value += step;
    return value;
  };
}

function backendFixture(
  input: {
    expectedFrameCount?: number;
    automaticPaintLimit?: number | null;
    onPreviewFrame?: () => void | Promise<void>;
    nowNanoseconds?: () => bigint;
  } = {},
) {
  const surface = new FakeBrowserSurface();
  surface.automaticPaintLimit = input.automaticPaintLimit ?? null;
  const sink = new FakeMasterSink();
  let surfacePlan: BrowserRecordingSurfacePlan | null = null;
  const readiness: string[] = [];
  const backend = new BrowserCaptureBackendV2({
    exportsDir: "/tmp/storycapture-browser-v2",
    bundleName: "browser-test",
    url: "https://example.test",
    platform: "darwin",
    arch: "arm64",
    backendVersion: "test",
    gpuIdentity: async () => "gpu-test",
    hardwareFingerprint: () => "hardware-test",
    measureEncodeThroughput: async () => 1.75,
    probeSourceRate: async () => ({
      measured_fps: { numerator: 60, denominator: 1 },
      source_presentations: 120,
      sequence_gaps: 0,
      stale_reuses: 0,
      probe_duration_ms: 2_000,
    }),
    probeStorage: async () => ({
      estimated_bytes_per_second: 1_000,
      required_bytes_for_ten_minutes: 600_000,
      available_bytes: 2_000_000,
      reserve_bytes: 1_000_000,
      eligible: true,
    }),
    surfaceFactory: (plan) => {
      surfacePlan = plan;
      return surface;
    },
    masterSinkFactory: async () => sink,
    nowNanoseconds: input.nowNanoseconds ?? nanosecondClock(),
    expectedFrameCount: input.expectedFrameCount,
    readinessTimeoutMs: 100,
    onPreviewFrame: input.onPreviewFrame,
    onReadiness: (state) => readiness.push(state),
  });
  return { backend, surface, sink, readiness, surfacePlan: () => surfacePlan };
}

async function startFixture(fixture: ReturnType<typeof backendFixture>): Promise<void> {
  const preflight = await fixture.backend.probe(request());
  expect(preflight).toMatchObject({ strict_eligible: true, failure_codes: [] });
  await fixture.backend.start({ session_id: "browser-session", request: request() });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserCaptureBackendV2", () => {
  it("plans an isolated hidden 1080p surface with DPR, shared texture, and no throttling", () => {
    expect(browserRecordingSurfacePlan(request(), "storycapture-test")).toEqual({
      logicalWidth: 960,
      logicalHeight: 540,
      physicalWidth: PHYSICAL_WIDTH,
      physicalHeight: PHYSICAL_HEIGHT,
      captureDpr: 2,
      frameRate: 60,
      partition: "storycapture-test",
      useSharedTexture: true,
      backgroundThrottling: false,
    });
    expect(() => browserRecordingSurfacePlan(request(), "persist:recording")).toThrow(
      /non-persistent/,
    );
  });

  it("delivers exactly 300 new static source presentations for five seconds", async () => {
    const fixture = backendFixture({ expectedFrameCount: 300 });
    await startFixture(fixture);
    await fixture.backend.waitForCommittedFrames(300);
    await fixture.backend.stop();

    expect(fixture.surfacePlan()).toMatchObject({
      logicalWidth: 960,
      logicalHeight: 540,
      physicalWidth: PHYSICAL_WIDTH,
      physicalHeight: PHYSICAL_HEIGHT,
      captureDpr: 2,
      useSharedTexture: true,
      backgroundThrottling: false,
    });
    expect(fixture.surface.frameRate).toBe(60);
    expect(fixture.sink.frames).toHaveLength(300);
    expect(fixture.sink.frames[0]).toMatchObject({ sourceSequence: 1 });
    expect(fixture.sink.frames.at(-1)).toMatchObject({ sourceSequence: 300 });
    expect(fixture.surface.releasedTextures).toBe(300);
    expect(fixture.backend.metrics()).toEqual({
      source_presentations: 300,
      submitted_frames: 300,
      encoder_acked_frames: 300,
      source_sequence_gaps: 0,
      stale_reuses: 0,
      skipped_slots: 0,
      dropped_frames: 0,
      deadline_misses: 0,
      ring_overflows: 0,
      backpressure_events: 0,
    });
    expect(fixture.backend.cadenceEvidence()).toMatchObject({
      active_duration_us: 5_000_000,
      expected_slots: 300,
      source_presentations: 300,
      verdict: "passed",
      failure_codes: [],
    });
  });

  it("preserves high-motion pixels, source sequence, and native PTS", async () => {
    const fixture = backendFixture({ expectedFrameCount: 3 });
    await startFixture(fixture);
    await fixture.backend.waitForCommittedFrames(3);

    expect(fixture.sink.frames.map((frame) => frame.firstByte)).toEqual([1, 2, 3]);
    expect(fixture.sink.frames.map((frame) => frame.sourceSequence)).toEqual([1, 2, 3]);
    expect(fixture.sink.frames.map((frame) => frame.nativePtsUs)).toEqual([16_667, 33_334, 50_001]);
    await fixture.backend.stop();
  });

  it("does not let a slow preview mirror throttle authoritative capture", async () => {
    const previewNeverCompletes = new Promise<void>(() => undefined);
    const preview = vi.fn(() => previewNeverCompletes);
    const fixture = backendFixture({
      expectedFrameCount: 5,
      onPreviewFrame: preview,
    });
    await startFixture(fixture);
    await fixture.backend.waitForCommittedFrames(5);

    expect(fixture.sink.frames).toHaveLength(5);
    expect(fixture.backend.metrics().backpressure_events).toBe(0);
    await fixture.backend.stop();
  });

  it("pauses source delivery, resumes on a new presentation, and writes PCM audio", async () => {
    const fixture = backendFixture({ automaticPaintLimit: 1 });
    await startFixture(fixture);
    await fixture.backend.pause();
    fixture.surface.emitPaint();
    expect(fixture.backend.metrics().source_presentations).toBe(1);

    await fixture.backend.resume();
    fixture.surface.emitPaint();
    await fixture.backend.waitForCommittedFrames(2);
    await fixture.backend.writeAudioSidecar("microphone", {
      sampleRate: 48_000,
      channels: 1,
      samples: new Int16Array([1, 2, 3]),
    });

    expect(fixture.backend.metrics().source_presentations).toBe(2);
    expect(fixture.sink.audio).toHaveLength(1);
    await fixture.backend.stop();
  });

  it("requires a new committed frame immediately before input", async () => {
    const fixture = backendFixture({ automaticPaintLimit: 1 });
    await startFixture(fixture);
    const barrier = fixture.backend.waitForReadiness("pre_input_frame_committed");
    fixture.surface.emitPaint();
    await barrier;

    expect(fixture.readiness).toEqual([
      "source_ready",
      "first_frame_committed",
      "pre_input_frame_committed",
    ]);
    expect(fixture.backend.metrics().encoder_acked_frames).toBe(2);
    expect(fixture.backend.recordingContents()).toBe(fixture.surface.automationContents);
    await fixture.backend.stop();
  });

  it("continues with fresh callbacks across reload and stops idempotently", async () => {
    const fixture = backendFixture({ automaticPaintLimit: 1 });
    await startFixture(fixture);
    fixture.surface.reload();
    fixture.surface.emitPaint();
    await fixture.backend.waitForCommittedFrames(2);

    await Promise.all([fixture.backend.stop(), fixture.backend.stop()]);
    expect(fixture.surface.destroyed).toBe(true);
    expect(fixture.sink.frames.map((frame) => frame.sourceSequence)).toEqual([1, 2]);
    await fixture.backend.finalize({} as never);
    expect(fixture.sink.finalize).toHaveBeenCalledTimes(1);
  });

  it("fails closed on target loss without a capturePage or stale-image fallback", async () => {
    const fixture = backendFixture({ automaticPaintLimit: 1 });
    await startFixture(fixture);
    fixture.surface.loseTarget();

    await expect(fixture.backend.waitForCommittedFrames(2)).rejects.toMatchObject({
      code: "target_lost",
    });
    expect(fixture.backend.guard.lifecycle).toBe("failed");
    await fixture.backend.stop();
  });

  it("fails closed when GPU shared texture delivery disappears", async () => {
    const fixture = backendFixture({ automaticPaintLimit: 1 });
    await startFixture(fixture);
    fixture.surface.emitPaint({ texture: false });

    expect(fixture.backend.guard.stickyFailure).toMatchObject({
      code: "backend_capability_mismatch",
    });
    await fixture.backend.stop();
  });

  it("records deadline pressure and makes encoder ring backpressure sticky", async () => {
    const timestamps = [0n, 16_667_000n, 100_000_000n, 116_667_000n];
    const fixture = backendFixture({
      automaticPaintLimit: 1,
      nowNanoseconds: () => timestamps.shift() ?? 133_334_000n,
    });
    await startFixture(fixture);
    let submission = 0;
    let resolveBackpressured: () => void = () => undefined;
    fixture.sink.submitImplementation = () => {
      submission += 1;
      if (submission === 1) {
        return new Promise<void>((resolve) => {
          resolveBackpressured = resolve;
        });
      }
      return Promise.reject(new Error("frame ring overflow"));
    };
    fixture.surface.emitPaint();
    fixture.surface.emitPaint();
    await vi.waitFor(() => {
      expect(fixture.backend.guard.stickyFailure).toMatchObject({
        code: "frame_ring_overflow",
      });
    });

    expect(fixture.backend.metrics()).toMatchObject({
      source_presentations: 3,
      deadline_misses: 1,
      backpressure_events: 1,
      dropped_frames: 1,
      ring_overflows: 1,
    });
    resolveBackpressured();
    await fixture.backend.stop();
  });
});

describe("BrowserHighResolutionClock", () => {
  it("excludes paused time from native presentation timestamps", () => {
    const timestamps = [0n, 16_667_000n, 20_000_000n, 120_000_000n, 136_667_000n];
    const clock = new BrowserHighResolutionClock(() => {
      const timestamp = timestamps.shift();
      if (timestamp === undefined) throw new Error("test clock exhausted");
      return timestamp;
    });
    clock.start();
    expect(clock.activeTimestampUs()).toBe(16_667);
    clock.pause();
    clock.resume();
    expect(clock.activeTimestampUs()).toBe(36_667);
  });
});
