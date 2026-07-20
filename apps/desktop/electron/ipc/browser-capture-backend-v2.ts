import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import type {
  CaptureBackendV2,
  CaptureBackendV2Capabilities,
  CaptureBackendV2Frame,
  CaptureBackendV2SessionStart,
  RecordingCadenceEvidenceV2,
  RecordingPlatform,
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
  RecordingResultV2,
  RecordingSourceRateProbeV2,
} from "@storycapture/shared-types/recording-v2";
import { app, BrowserWindow, type Rectangle, type WebContents } from "electron";
import {
  CaptureBackendV2Error,
  CaptureBackendV2Guard,
  validateCaptureBackendV2Request,
} from "./capture-backend-v2-guard";
import type { RecordingStoragePreflight } from "./recording-bundle";
import { recordingStoragePreflight } from "./recording-bundle";
import { recordingCertificationTierMatches } from "./recording-certification-catalog";
import type { RecordingFrameInput } from "./recording-frame-ring";
import type { PcmWavInput } from "./recording-master";
import {
  type StrictRecordingFinalizeInput,
  StrictRecordingMasterPipeline,
  type StrictRecordingMasterPipelineOptions,
} from "./recording-master-pipeline";
import { measureRecordingMasterThroughput } from "./recording-throughput-probe";

const FRAME_RATE = 60;
const FRAME_INTERVAL_US = 1_000_000 / FRAME_RATE;
const DEFAULT_PROBE_PRESENTATIONS = 60;
const DEFAULT_READINESS_TIMEOUT_MS = 8_000;
export const BROWSER_CAPTURE_BACKEND_ID = "electron_offscreen_shared_texture_bitmap_copy";

export type BrowserRecordingReadinessState =
  | "source_ready"
  | "first_frame_committed"
  | "pre_input_frame_committed";

export interface BrowserPaintDetails {
  texture?: { release(): void };
}

export interface BrowserPaintImage {
  getSize(): { width: number; height: number };
  toBitmap(options?: { scaleFactor?: number }): Buffer;
}

export type BrowserPaintListener = (
  details: BrowserPaintDetails,
  dirtyRect: Rectangle,
  image: BrowserPaintImage,
) => void;

export interface BrowserRecordingSurface {
  readonly automationContents: WebContents;
  readonly contents: {
    setFrameRate(fps: number): void;
    invalidate(): void;
  };
  loadURL(url: string): Promise<void>;
  onPaint(listener: BrowserPaintListener): void;
  offPaint(listener: BrowserPaintListener): void;
  onTargetLost(listener: (reason: string) => void): void;
  onLoadCommitted(listener: () => void): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface BrowserRecordingSurfacePlan {
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  captureDpr: number;
  frameRate: 60;
  partition: string;
  useSharedTexture: true;
  backgroundThrottling: false;
}

export interface BrowserRecordingMasterSink {
  submit(frame: RecordingFrameInput): Promise<void>;
  finalize(input: StrictRecordingFinalizeInput): Promise<RecordingResultV2>;
  writeAudioSidecar?(role: "microphone" | "system", input: PcmWavInput): Promise<void>;
  writeAudioFileSidecar?(role: "microphone" | "system", inputPath: string): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserCapturePreviewFrame {
  frame: CaptureBackendV2Frame;
  pixels: Uint8Array;
}

export interface BrowserCaptureBackendV2Options {
  exportsDir: string;
  bundleName: string;
  url: string;
  partition?: string;
  platform?: RecordingPlatform;
  arch?: string;
  backendVersion?: string;
  gpuIdentity?: () => Promise<string | null>;
  hardwareFingerprint?: (gpuIdentity: string | null) => string;
  measureEncodeThroughput?: (request: RecordingPreflightV2Request) => Promise<number>;
  probeStorage?: (request: RecordingPreflightV2Request) => Promise<RecordingStoragePreflight>;
  probeSourceRate?: (request: RecordingPreflightV2Request) => Promise<RecordingSourceRateProbeV2>;
  surfaceFactory?: (plan: BrowserRecordingSurfacePlan) => BrowserRecordingSurface;
  masterSinkFactory?: (
    options: StrictRecordingMasterPipelineOptions,
  ) => Promise<BrowserRecordingMasterSink>;
  nowNanoseconds?: () => bigint;
  readinessTimeoutMs?: number;
  expectedFrameCount?: number;
  onPreviewFrame?: (frame: BrowserCapturePreviewFrame) => void | Promise<void>;
  onReadiness?: (state: BrowserRecordingReadinessState) => void;
}

export interface BrowserCaptureMetrics {
  source_presentations: number;
  submitted_frames: number;
  encoder_acked_frames: number;
  source_sequence_gaps: number;
  stale_reuses: number;
  skipped_slots: number;
  dropped_frames: number;
  deadline_misses: number;
  ring_overflows: number;
  backpressure_events: number;
}

interface FrameWaiter {
  frameCount: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function browserRecordingSurfacePlan(
  request: RecordingPreflightV2Request,
  partition = `storycapture-v2-${randomUUID()}`,
): BrowserRecordingSurfacePlan {
  const dimensions = request.dimensions;
  if (
    Math.round(dimensions.logical_width * dimensions.capture_dpr) !== dimensions.physical_width ||
    Math.round(dimensions.logical_height * dimensions.capture_dpr) !== dimensions.physical_height
  ) {
    throw new CaptureBackendV2Error(
      "contract_mismatch",
      "browser logical size and DPR do not produce the requested physical backing",
    );
  }
  if (partition.startsWith("persist:")) {
    throw new CaptureBackendV2Error(
      "contract_mismatch",
      "strict browser capture requires an isolated non-persistent partition",
    );
  }
  return {
    logicalWidth: dimensions.logical_width,
    logicalHeight: dimensions.logical_height,
    physicalWidth: dimensions.physical_width,
    physicalHeight: dimensions.physical_height,
    captureDpr: dimensions.capture_dpr,
    frameRate: FRAME_RATE,
    partition,
    useSharedTexture: true,
    backgroundThrottling: false,
  };
}

export function createElectronBrowserRecordingSurface(
  plan: BrowserRecordingSurfacePlan,
): BrowserRecordingSurface {
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: plan.logicalWidth,
    height: plan.logicalHeight,
    webPreferences: {
      partition: plan.partition,
      offscreen: {
        useSharedTexture: true,
        sharedTexturePixelFormat: "argb",
        deviceScaleFactor: plan.captureDpr,
      },
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  return {
    automationContents: window.webContents,
    contents: window.webContents,
    loadURL: (url) => window.loadURL(url),
    onPaint: (listener) => window.webContents.on("paint", listener),
    offPaint: (listener) => window.webContents.off("paint", listener),
    onTargetLost: (listener) => {
      window.webContents.on("render-process-gone", (_event, details) => {
        listener(`browser render process exited: ${details.reason}`);
      });
      window.webContents.on("destroyed", () => listener("browser web contents was destroyed"));
      window.on("unresponsive", () => listener("browser recording surface became unresponsive"));
    },
    onLoadCommitted: (listener) => window.webContents.on("did-finish-load", listener),
    destroy: () => window.destroy(),
    isDestroyed: () => window.isDestroyed(),
  };
}

export class BrowserHighResolutionClock {
  private originNs: bigint | null = null;
  private pausedAtNs: bigint | null = null;
  private pausedNs = 0n;

  constructor(private readonly nowNanoseconds: () => bigint = process.hrtime.bigint) {}

  start(): void {
    if (this.originNs !== null) throw new Error("browser presentation clock already started");
    this.originNs = this.nowNanoseconds();
  }

  pause(): void {
    if (this.originNs === null || this.pausedAtNs !== null) {
      throw new Error("browser presentation clock cannot pause in its current state");
    }
    this.pausedAtNs = this.nowNanoseconds();
  }

  resume(): void {
    if (this.pausedAtNs === null) {
      throw new Error("browser presentation clock is not paused");
    }
    const now = this.nowNanoseconds();
    this.pausedNs += now - this.pausedAtNs;
    this.pausedAtNs = null;
  }

  activeTimestampUs(): number {
    if (this.originNs === null) throw new Error("browser presentation clock has not started");
    const now = this.pausedAtNs ?? this.nowNanoseconds();
    return Number((now - this.originNs - this.pausedNs) / 1_000n);
  }
}

function defaultPlatform(): RecordingPlatform {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  throw new CaptureBackendV2Error(
    "backend_unavailable",
    `browser CaptureBackendV2 is not certified on ${process.platform}`,
  );
}

function certificationMatches(
  request: RecordingPreflightV2Request,
  capabilities: CaptureBackendV2Capabilities,
  platform: RecordingPlatform,
  arch: string,
  hardwareFingerprint: string,
): boolean {
  return recordingCertificationTierMatches(request.desired_tier, {
    platform,
    arch,
    hardwareFingerprint,
    targetClass: "browser",
    capabilities,
    outputWidth: request.dimensions.requested_output_width,
    outputHeight: request.dimensions.requested_output_height,
  });
}

function defaultHardwareFingerprint(
  capabilities: CaptureBackendV2Capabilities,
  platform: RecordingPlatform,
  arch: string,
  gpuIdentity: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backend_id: capabilities.backend_id,
        backend_version: capabilities.backend_version,
        platform,
        arch,
        gpu_identity: gpuIdentity,
      }),
    )
    .digest("hex");
}

async function electronGpuIdentity(): Promise<string | null> {
  try {
    return JSON.stringify(await app.getGPUInfo("basic"));
  } catch {
    return null;
  }
}

export class BrowserCaptureBackendV2 implements CaptureBackendV2 {
  readonly capabilities: CaptureBackendV2Capabilities;
  readonly guard: CaptureBackendV2Guard;

  private readonly platform: RecordingPlatform;
  private readonly arch: string;
  private readonly clock: BrowserHighResolutionClock;
  private readonly readinessTimeoutMs: number;
  private readonly metricsValue: BrowserCaptureMetrics = {
    source_presentations: 0,
    submitted_frames: 0,
    encoder_acked_frames: 0,
    source_sequence_gaps: 0,
    stale_reuses: 0,
    skipped_slots: 0,
    dropped_frames: 0,
    deadline_misses: 0,
    ring_overflows: 0,
    backpressure_events: 0,
  };
  private surface: BrowserRecordingSurface | null = null;
  private sink: BrowserRecordingMasterSink | null = null;
  private paintListener: BrowserPaintListener | null = null;
  private acceptingFrames = false;
  private sourceReady = false;
  private firstFrameCommitted = false;
  private stopPromise: Promise<void> | null = null;
  private outstandingSubmissions = new Set<Promise<void>>();
  private waiters = new Set<FrameWaiter>();
  private previousPtsUs: number | null = null;
  private stoppedAtActiveUs: number | null = null;

  constructor(private readonly options: BrowserCaptureBackendV2Options) {
    this.platform = options.platform ?? defaultPlatform();
    this.arch = options.arch ?? os.arch();
    this.capabilities = {
      version: 2,
      backend_id: BROWSER_CAPTURE_BACKEND_ID,
      backend_version: options.backendVersion ?? process.versions.electron ?? "unknown",
      target_classes: ["browser"],
      supports_native_timestamps: true,
      supports_source_sequences: true,
      supports_physical_pixels: true,
      supports_cursor_policy: true,
      supports_pause_resume: true,
    };
    this.guard = new CaptureBackendV2Guard(this.capabilities);
    this.clock = new BrowserHighResolutionClock(options.nowNanoseconds);
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  }

  async probe(request: RecordingPreflightV2Request): Promise<RecordingPreflightV2Dto> {
    const platform = this.platform;
    const arch = this.arch;
    const gpuIdentity = await (this.options.gpuIdentity ?? electronGpuIdentity)();
    const hardwareFingerprint = this.options.hardwareFingerprint
      ? this.options.hardwareFingerprint(gpuIdentity)
      : defaultHardwareFingerprint(this.capabilities, platform, arch, gpuIdentity);
    const requestFailures = validateCaptureBackendV2Request(this.capabilities, request);
    const sourceRate = await (this.options.probeSourceRate
      ? this.options.probeSourceRate(request)
      : this.probeBrowserSourceRate(request));
    const encodeThroughputRatio = await (
      this.options.measureEncodeThroughput?.(request) ??
      measureRecordingMasterThroughput(this.options.exportsDir, request)
    ).catch(() => 0);
    const storageProbe = await (this.options.probeStorage
      ? this.options.probeStorage(request)
      : fs.mkdir(this.options.exportsDir, { recursive: true }).then(() =>
          recordingStoragePreflight(this.options.exportsDir, {
            width: request.dimensions.physical_width,
            height: request.dimensions.physical_height,
            fps: FRAME_RATE,
          }),
        )
    ).catch(() => null);
    const certificationMatch = certificationMatches(
      request,
      this.capabilities,
      platform,
      arch,
      hardwareFingerprint,
    );
    const failureCodes = [...requestFailures];
    const fail = (code: RecordingQualityFailureCode) => {
      if (!failureCodes.includes(code)) failureCodes.push(code);
    };
    if (!sourceRate.measured_fps) fail("source_rate_mismatch");
    if (!storageProbe) fail("storage_estimate_failed");
    if (encodeThroughputRatio < 1.5) fail("backend_capability_mismatch");
    if (!certificationMatch) fail("uncertified_tier");
    const storage = storageProbe ?? {
      estimated_bytes_per_second: 0,
      required_bytes_for_ten_minutes: Number.MAX_SAFE_INTEGER,
      available_bytes: 0,
      reserve_bytes: 0,
      eligible: false,
    };
    if (!storage.eligible) fail("storage_reserve_exhausted");

    return this.guard.acceptProbe(request, {
      version: 2,
      backend_id: this.capabilities.backend_id,
      backend_version: this.capabilities.backend_version,
      platform,
      arch,
      gpu_identity: gpuIdentity,
      hardware_fingerprint: hardwareFingerprint,
      certification: certificationMatch ? request.desired_tier : null,
      certification_match: certificationMatch,
      source_rate: sourceRate,
      encode_throughput_ratio: encodeThroughputRatio,
      storage: {
        estimated_bytes_per_second: storage.estimated_bytes_per_second,
        required_bytes_for_ten_minutes: storage.required_bytes_for_ten_minutes,
        available_bytes: storage.available_bytes,
        reserve_bytes: storage.reserve_bytes,
      },
      permissions_granted: true,
      strict_eligible: failureCodes.length === 0,
      failure_codes: failureCodes,
    });
  }

  async start(start: CaptureBackendV2SessionStart): Promise<void> {
    this.guard.begin(start);
    const plan = browserRecordingSurfacePlan(start.request, this.options.partition);
    const surfaceFactory = this.options.surfaceFactory ?? createElectronBrowserRecordingSurface;
    try {
      this.sink = await (
        this.options.masterSinkFactory ??
        ((pipelineOptions) => StrictRecordingMasterPipeline.create(pipelineOptions))
      )({
        exportsDir: this.options.exportsDir,
        name: this.options.bundleName,
        width: plan.physicalWidth,
        height: plan.physicalHeight,
        captureContract: {
          exact_fps: start.request.requested_fps,
          dimensions: start.request.dimensions,
        },
        deliveryPolicy: start.request.delivery_policy,
        certifiedTier: start.request.desired_tier,
      });
      const surface = surfaceFactory(plan);
      this.surface = surface;
      surface.contents.setFrameRate(FRAME_RATE);
      this.paintListener = (details, _dirtyRect, image) => {
        this.handlePaint(details, image);
      };
      surface.onPaint(this.paintListener);
      surface.onTargetLost((reason) => {
        if (this.guard.lifecycle === "recording" || this.guard.lifecycle === "paused") {
          this.fail("target_lost", reason);
        }
      });
      surface.onLoadCommitted(() => {
        if (this.acceptingFrames && !surface.isDestroyed()) surface.contents.invalidate();
      });
      this.clock.start();
      await surface.loadURL(this.options.url);
      this.sourceReady = true;
      this.options.onReadiness?.("source_ready");
      this.acceptingFrames = true;
      surface.contents.invalidate();
      await this.waitForReadiness("first_frame_committed");
    } catch (error) {
      this.acceptingFrames = false;
      if (this.surface && this.paintListener) this.surface.offPaint(this.paintListener);
      if (this.surface && !this.surface.isDestroyed()) this.surface.destroy();
      await this.sink?.abort?.().catch(() => undefined);
      this.fail(
        error instanceof CaptureBackendV2Error ? error.code : "backend_unavailable",
        error instanceof Error ? error.message : String(error),
      );
      throw this.guard.stickyFailure;
    }
  }

  async pause(): Promise<void> {
    this.guard.pause();
    this.acceptingFrames = false;
    this.clock.pause();
    await Promise.all([...this.outstandingSubmissions]);
  }

  async resume(): Promise<void> {
    this.guard.resume();
    this.clock.resume();
    this.acceptingFrames = true;
    this.surface?.contents.invalidate();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  async waitForReadiness(state: BrowserRecordingReadinessState): Promise<void> {
    if (state === "source_ready") {
      if (!this.sourceReady) {
        throw new CaptureBackendV2Error("target_missing", "browser source is not ready");
      }
      return;
    }
    if (state === "first_frame_committed") {
      if (!this.firstFrameCommitted) await this.waitForFrameCount(1);
      return;
    }
    await this.commitPreInputFrame();
  }

  async waitForCommittedFrames(frameCount: number): Promise<void> {
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
      throw new CaptureBackendV2Error(
        "contract_mismatch",
        "committed browser frame count must be a positive integer",
      );
    }
    await this.waitForFrameCount(frameCount);
  }

  async commitPreInputFrame(): Promise<void> {
    if (this.guard.lifecycle !== "recording" || !this.acceptingFrames) {
      throw new CaptureBackendV2Error(
        "contract_mismatch",
        "pre-input frame barrier requires an active browser source",
      );
    }
    const requiredCount = this.metricsValue.encoder_acked_frames + 1;
    this.surface?.contents.invalidate();
    await this.waitForFrameCount(requiredCount);
    this.options.onReadiness?.("pre_input_frame_committed");
  }

  async writeAudioSidecar(role: "microphone" | "system", input: PcmWavInput): Promise<void> {
    if (!this.sink?.writeAudioSidecar) {
      throw new CaptureBackendV2Error(
        "backend_capability_mismatch",
        "recording master sink does not support PCM audio sidecars",
      );
    }
    await this.sink.writeAudioSidecar(role, input);
  }

  async writeAudioFileSidecar(role: "microphone" | "system", inputPath: string): Promise<void> {
    if (!this.sink?.writeAudioFileSidecar) {
      throw new CaptureBackendV2Error(
        "backend_capability_mismatch",
        "recording master sink does not support streamed audio sidecars",
      );
    }
    await this.sink.writeAudioFileSidecar(role, inputPath);
  }

  async finalize(input: StrictRecordingFinalizeInput): Promise<RecordingResultV2> {
    if (this.guard.lifecycle !== "stopped" || !this.sink) {
      throw new CaptureBackendV2Error(
        "contract_mismatch",
        "browser master can finalize only after capture has stopped",
      );
    }
    return this.sink.finalize(input);
  }

  metrics(): BrowserCaptureMetrics {
    return { ...this.metricsValue };
  }

  recordingClockMs(): number {
    return this.activeDurationUs() / 1_000;
  }

  cadenceEvidence(
    artifactDecodedFrames = this.metricsValue.encoder_acked_frames,
    fullDecodeSucceeded = true,
  ): RecordingCadenceEvidenceV2 {
    const activeDurationUs = this.activeDurationUs();
    const expectedSlots = Math.ceil((activeDurationUs * FRAME_RATE) / 1_000_000);
    const failures: RecordingQualityFailureCode[] = [];
    const fail = (code: RecordingQualityFailureCode) => {
      if (!failures.includes(code)) failures.push(code);
    };
    if (this.metricsValue.source_presentations !== expectedSlots) fail("source_sequence_missing");
    if (this.metricsValue.source_sequence_gaps > 0) fail("source_sequence_gap");
    if (this.metricsValue.stale_reuses > 0) fail("source_stale_reuse");
    if (
      this.metricsValue.submitted_frames !== expectedSlots ||
      this.metricsValue.skipped_slots > 0
    ) {
      fail("scheduled_slot_skipped");
    }
    if (
      this.metricsValue.encoder_acked_frames !== this.metricsValue.submitted_frames ||
      this.metricsValue.dropped_frames > 0
    ) {
      fail("submitted_frame_dropped");
    }
    if (this.metricsValue.deadline_misses > 0) fail("encoder_deadline_missed");
    if (this.metricsValue.ring_overflows > 0) fail("frame_ring_overflow");
    if (artifactDecodedFrames !== this.metricsValue.encoder_acked_frames) {
      fail("artifact_frame_count_mismatch");
    }
    if (!fullDecodeSucceeded) fail("artifact_decode_failed");
    if (this.guard.stickyFailure) fail(this.guard.stickyFailure.code);
    return {
      version: 2,
      requested_fps: { numerator: 60, denominator: 1 },
      source_fps: { numerator: 60, denominator: 1 },
      stream_time_base: null,
      active_duration_us: activeDurationUs,
      expected_slots: expectedSlots,
      source_presentations: this.metricsValue.source_presentations,
      submitted_frames: this.metricsValue.submitted_frames,
      encoder_acked_frames: this.metricsValue.encoder_acked_frames,
      artifact_decoded_frames: artifactDecodedFrames,
      source_sequence_gaps: this.metricsValue.source_sequence_gaps,
      stale_reuses: this.metricsValue.stale_reuses,
      skipped_slots: this.metricsValue.skipped_slots,
      dropped_frames: this.metricsValue.dropped_frames,
      deadline_misses: this.metricsValue.deadline_misses,
      ring_overflows: this.metricsValue.ring_overflows,
      backpressure_events: this.metricsValue.backpressure_events,
      pts_gaps: 0,
      pts_duplicates: 0,
      full_decode_succeeded: fullDecodeSucceeded,
      verdict: failures.length === 0 ? "passed" : "failed",
      failure_codes: failures,
    };
  }

  masterSink(): BrowserRecordingMasterSink {
    if (!this.sink) throw new Error("browser recording master sink has not started");
    return this.sink;
  }

  /** Authoritative hidden WebContents used by the browser automation coordinator. */
  recordingContents(): WebContents {
    if (!this.surface || this.surface.isDestroyed()) {
      throw new CaptureBackendV2Error("target_lost", "browser recording surface is unavailable");
    }
    return this.surface.automationContents;
  }

  private async probeBrowserSourceRate(
    request: RecordingPreflightV2Request,
  ): Promise<RecordingSourceRateProbeV2> {
    const plan = browserRecordingSurfacePlan(request, this.options.partition);
    const surface = (this.options.surfaceFactory ?? createElectronBrowserRecordingSurface)(plan);
    const samples: bigint[] = [];
    const now = this.options.nowNanoseconds ?? process.hrtime.bigint;
    let accepting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      surface.contents.setFrameRate(FRAME_RATE);
      await new Promise<void>((resolve, reject) => {
        const listener: BrowserPaintListener = (details) => {
          details.texture?.release();
          if (!accepting || !details.texture) return;
          samples.push(now());
          if (samples.length >= DEFAULT_PROBE_PRESENTATIONS) {
            surface.offPaint(listener);
            resolve();
            return;
          }
          surface.contents.invalidate();
        };
        surface.onPaint(listener);
        timer = setTimeout(() => {
          surface.offPaint(listener);
          reject(
            new CaptureBackendV2Error(
              "verification_timeout",
              "browser source-rate probe timed out",
            ),
          );
        }, this.readinessTimeoutMs);
        timer.unref?.();
        void surface
          .loadURL(this.options.url)
          .then(() => {
            accepting = true;
            surface.contents.invalidate();
          })
          .catch(reject);
      });
    } catch {
      const firstSample = samples[0] ?? 0n;
      const lastSample = samples.at(-1) ?? firstSample;
      return {
        measured_fps: null,
        source_presentations: samples.length,
        sequence_gaps: 0,
        stale_reuses: 0,
        probe_duration_ms: samples.length > 1 ? Number(lastSample - firstSample) / 1_000_000 : 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (!surface.isDestroyed()) surface.destroy();
    }
    const firstSample = samples[0] ?? 0n;
    const elapsedNs = (samples.at(-1) ?? firstSample) - firstSample;
    const measuredFps =
      elapsedNs > 0n ? ((samples.length - 1) * 1_000_000_000) / Number(elapsedNs) : 0;
    const is60Fps = Math.abs(measuredFps - FRAME_RATE) / FRAME_RATE <= 0.02;
    return {
      measured_fps: is60Fps ? { numerator: 60, denominator: 1 } : null,
      source_presentations: samples.length,
      sequence_gaps: 0,
      stale_reuses: 0,
      probe_duration_ms: Number(elapsedNs) / 1_000_000,
    };
  }

  private handlePaint(details: BrowserPaintDetails, image: BrowserPaintImage): void {
    const texture = details.texture;
    if (!texture) {
      if (this.acceptingFrames) {
        this.fail("backend_capability_mismatch", "browser paint did not provide a shared texture");
      }
      return;
    }
    try {
      if (!this.acceptingFrames || this.guard.lifecycle !== "recording") return;
      const sink = this.sink;
      if (!sink) {
        this.fail("contract_mismatch", "browser recording master sink is missing");
        return;
      }
      if (
        this.options.expectedFrameCount &&
        this.metricsValue.source_presentations >= this.options.expectedFrameCount
      ) {
        return;
      }
      const size = image.getSize();
      const request = this.preflightRequest();
      const pixels = image.toBitmap({ scaleFactor: 1 });
      const expectedBytes =
        request.dimensions.physical_width * request.dimensions.physical_height * 4;
      if (
        size.width !== request.dimensions.physical_width ||
        size.height !== request.dimensions.physical_height ||
        pixels.byteLength !== expectedBytes
      ) {
        this.fail(
          "contract_mismatch",
          `browser physical frame ${size.width}x${size.height}/${pixels.byteLength} did not match ${request.dimensions.physical_width}x${request.dimensions.physical_height}/${expectedBytes}`,
        );
        return;
      }
      const nativePtsUs = this.clock.activeTimestampUs();
      const frame: CaptureBackendV2Frame = {
        source_sequence: this.metricsValue.source_presentations + 1,
        native_pts_us: nativePtsUs,
        width: size.width,
        height: size.height,
        stride: size.width * 4,
        pixel_format: "bgra",
      };
      try {
        this.guard.acceptFrame(frame);
      } catch (error) {
        if (error instanceof CaptureBackendV2Error) {
          if (error.code === "source_sequence_gap") this.metricsValue.source_sequence_gaps += 1;
          if (error.code === "source_stale_reuse") this.metricsValue.stale_reuses += 1;
        }
        throw error;
      }
      if (
        this.previousPtsUs !== null &&
        nativePtsUs - this.previousPtsUs > FRAME_INTERVAL_US * 1.5
      ) {
        this.metricsValue.deadline_misses += 1;
      }
      this.previousPtsUs = nativePtsUs;
      this.metricsValue.source_presentations += 1;
      if (this.outstandingSubmissions.size > 0) this.metricsValue.backpressure_events += 1;
      this.metricsValue.submitted_frames += 1;
      let submission: Promise<void>;
      try {
        submission = sink.submit({
          sourceSequence: frame.source_sequence,
          nativePtsUs: frame.native_pts_us,
          pixels,
        });
      } catch (error) {
        this.metricsValue.dropped_frames += 1;
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes("ring") ? "frame_ring_overflow" : "submitted_frame_dropped";
        if (code === "frame_ring_overflow") this.metricsValue.ring_overflows += 1;
        this.fail(code, message);
        return;
      }
      this.outstandingSubmissions.add(submission);
      void submission
        .then(() => {
          this.outstandingSubmissions.delete(submission);
          this.metricsValue.encoder_acked_frames += 1;
          if (!this.firstFrameCommitted) {
            this.firstFrameCommitted = true;
            this.options.onReadiness?.("first_frame_committed");
          }
          this.resolveFrameWaiters();
          if (this.options.onPreviewFrame) {
            setImmediate(
              () =>
                void Promise.resolve(
                  this.options.onPreviewFrame?.({ frame: { ...frame }, pixels }),
                ).catch(() => undefined),
            );
          }
          if (
            this.acceptingFrames &&
            (!this.options.expectedFrameCount ||
              this.metricsValue.source_presentations < this.options.expectedFrameCount)
          ) {
            this.surface?.contents.invalidate();
          }
        })
        .catch((error) => {
          this.outstandingSubmissions.delete(submission);
          this.metricsValue.dropped_frames += 1;
          const message = error instanceof Error ? error.message : String(error);
          const code = message.includes("ring") ? "frame_ring_overflow" : "submitted_frame_dropped";
          if (code === "frame_ring_overflow") this.metricsValue.ring_overflows += 1;
          this.fail(code, message);
        });
    } catch (error) {
      this.fail(
        error instanceof CaptureBackendV2Error ? error.code : "submitted_frame_dropped",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      texture.release();
    }
  }

  private preflightRequest(): RecordingPreflightV2Request {
    const request = this.guard.request;
    if (!request) throw new Error("browser capture preflight request is unavailable");
    return request;
  }

  private waitForFrameCount(frameCount: number): Promise<void> {
    if (this.guard.stickyFailure) return Promise.reject(this.guard.stickyFailure);
    if (this.metricsValue.encoder_acked_frames >= frameCount) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: FrameWaiter = {
        frameCount,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            this.fail(
              "verification_timeout",
              `browser readiness timed out waiting for committed frame ${frameCount}`,
            ),
          );
        }, this.readinessTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  private resolveFrameWaiters(): void {
    for (const waiter of this.waiters) {
      if (this.metricsValue.encoder_acked_frames < waiter.frameCount) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectFrameWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private fail(code: RecordingQualityFailureCode, message: string): void {
    const error = this.guard.fail(code, message);
    this.acceptingFrames = false;
    this.rejectFrameWaiters(error);
  }

  private async stopOnce(): Promise<void> {
    const stoppedFromPause = this.guard.lifecycle === "paused";
    if (stoppedFromPause) this.clock.resume();
    this.acceptingFrames = false;
    this.stoppedAtActiveUs = this.activeDurationUs();
    this.guard.stop();
    try {
      await Promise.all([...this.outstandingSubmissions]);
    } finally {
      if (this.surface && this.paintListener) this.surface.offPaint(this.paintListener);
      if (this.surface && !this.surface.isDestroyed()) this.surface.destroy();
    }
  }

  private activeDurationUs(): number {
    if (
      this.options.expectedFrameCount &&
      this.metricsValue.source_presentations >= this.options.expectedFrameCount
    ) {
      return Math.floor((this.options.expectedFrameCount * 1_000_000) / FRAME_RATE);
    }
    return this.stoppedAtActiveUs ?? this.clock.activeTimestampUs();
  }
}
