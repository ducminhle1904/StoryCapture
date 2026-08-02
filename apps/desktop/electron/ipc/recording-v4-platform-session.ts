import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RECORDING_V4_CONTRACT_VERSION,
  RECORDING_V4_CURSOR_COORDINATE_HEIGHT,
  RECORDING_V4_CURSOR_COORDINATE_WIDTH,
  RECORDING_V4_PROFILE,
  type RecordingV4AudioEvidence,
  type RecordingV4AudioRole,
  type RecordingV4EncoderEnvelope,
  type RecordingV4FailureCode,
  type RecordingV4Preflight,
  type RecordingV4QualityEvidence,
  type RecordingV4QualityMetric,
  type RecordingV4Result,
  type RecordingV4TargetIdentity,
} from "@storycapture/shared-types/recording-v4";
import { app } from "electron";

import { isPackagedRuntime } from "../runtime";
import { frameSsim } from "./export-quality-gate";
import { ffmpegExecutablePath } from "./export-binaries";
import {
  type MacRecordingV4NativeResult,
  MacRecordingV4Backend,
  type MacRecordingV4NativeTarget,
} from "./macos-recording-v4-backend";
import { probeRecording } from "./media-probe";
import { SequentialMasterDecoder } from "./recording-master-decoder";
import {
  RecordingV4BrowserSurface,
  type RecordingV4BrowserSurfaceOptions,
} from "./recording-v4-browser-surface";
import {
  RecordingV4BundleFinalizer,
  type RecordingV4ArtifactProbe,
  type RecordingV4NativeFinalEvidence,
} from "./recording-v4-bundle";
import {
  registerRecordingV4AutomationSurface,
  unregisterRecordingV4AutomationSurface,
} from "./recording-v4-automation-surface";
import type {
  RecordingV4PlatformSession,
  RecordingV4PlatformSessionFactory,
  RecordingV4PlatformSessionInput,
} from "./recording-v4-coordinator";
import { runtimeEdgeSpreadIncrease, stableColorChannelDelta } from "./recording-v4-runtime-quality";
import {
  selectRecordingV4EncoderEnvelope,
  type RecordingV4EncoderCalibration,
} from "./recording-v4-verifier";
import {
  resolveWindowsRecordingV4HelperPath,
  WindowsRecordingV4Backend,
  type WindowsRecordingV4FinalEvidence,
  type WindowsRecordingV4StartOptions,
} from "./windows-recording-v4-backend";

const TEN_MINUTES_SECONDS = 600;
const STORAGE_RESERVE_BYTES = 1024 ** 3;

export function resolveMacRecordingV4HelperPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, "native/macos/storycapture-screen-capture-helper")
    : path.join(input.appPath, "native/macos-screen-capture/.build/release/storycapture-screen-capture-helper");
}

export interface RecordingV4QualityThresholds {
  full_frame_luma_ssim: number;
  text_edge_roi_ssim: number;
  edge_spread_increase_px: number;
  color_channel_delta: number;
}

export interface RecordingV4RuntimeProfile {
  platform: "darwin" | "win32";
  calibration: RecordingV4EncoderCalibration;
  safety_headroom_ratio: number;
  quality: RecordingV4QualityThresholds;
}

export interface RecordingV4NativeDriver {
  readonly helperPid: number | null;
  readonly target: RecordingV4TargetIdentity;
  readonly availableAudioRoles: RecordingV4AudioRole[];
  warmUp(envelope: RecordingV4EncoderEnvelope): Promise<RecordingV4Preflight["encoder"]>;
  start(envelope: RecordingV4EncoderEnvelope): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<RecordingV4NativeFinalEvidence>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface RecordingV4PlatformDependencies {
  platform: "darwin" | "win32";
  runtimeProfile: RecordingV4RuntimeProfile;
  createDriver(input: RecordingV4PlatformSessionInput): Promise<RecordingV4NativeDriver>;
  storageProbe(workspacePath: string, requiredBytes: number): Promise<{ availableBytes: number }>;
  throughputProbe(workspacePath: string): Promise<number>;
  minimumWriteBytesPerSecond: number;
  artifactProbe(artifactPath: string): Promise<RecordingV4ArtifactProbe>;
  qualityProbe(
    artifactPath: string,
    surfaceReference: Buffer,
    thresholds: RecordingV4QualityThresholds,
  ): Promise<RecordingV4QualityEvidence>;
  extractAudio(
    artifactPath: string,
    workspacePath: string,
    roles: readonly RecordingV4AudioRole[],
    evidence: readonly RecordingV4AudioEvidence[],
  ): Promise<Array<{ role: RecordingV4AudioRole; source_path: string }>>;
  finalizer: RecordingV4BundleFinalizer;
}

function failure(error: unknown, fallback: RecordingV4FailureCode): RecordingV4FailureCode {
  if (error && typeof error === "object") {
    const code = "code" in error ? error.code : "recordingV4FailureCode" in error ? error.recordingV4FailureCode : null;
    if (typeof code === "string") return code as RecordingV4FailureCode;
  }
  return fallback;
}

class HostRecordingV4PlatformSession implements RecordingV4PlatformSession {
  private driver: RecordingV4NativeDriver | null = null;
  private envelope: RecordingV4EncoderEnvelope | null = null;
  private preflightResult: RecordingV4Preflight | null = null;
  private surfaceReference: Buffer | null = null;

  constructor(
    private readonly input: RecordingV4PlatformSessionInput,
    private readonly dependencies: RecordingV4PlatformDependencies,
  ) {}

  get helperPid(): number | null {
    return this.driver?.helperPid ?? null;
  }

  async preflight(): Promise<RecordingV4Preflight> {
    if (this.preflightResult) return this.preflightResult;
    const failures: RecordingV4FailureCode[] = [];
    let target: RecordingV4TargetIdentity = {
      kind: "author_preview",
      stable_id: createHash("sha256").update(this.input.request.source_url).digest("hex"),
      process_id: process.pid,
      initial_title: null,
    };
    let availableBytes = 0;
    let measuredWriteBytesPerSecond = 0;
    let encoder: RecordingV4Preflight["encoder"] = null;
    const envelope = selectRecordingV4EncoderEnvelope(
      this.dependencies.runtimeProfile.calibration,
      this.dependencies.runtimeProfile.safety_headroom_ratio,
    );
    if (!envelope) failures.push("hardware_encoder_unavailable");
    else this.envelope = envelope;
    const storageRequiredBytes = envelope
      ? Math.ceil((envelope.maximum_bitrate_bps / 8) * TEN_MINUTES_SECONDS) + STORAGE_RESERVE_BYTES
      : STORAGE_RESERVE_BYTES;
    try {
      const storage = await this.dependencies.storageProbe(this.input.workspacePath, storageRequiredBytes);
      availableBytes = storage.availableBytes;
      if (availableBytes < storageRequiredBytes) failures.push("storage_insufficient");
    } catch {
      failures.push("storage_probe_failed");
    }
    try {
      measuredWriteBytesPerSecond = await this.dependencies.throughputProbe(this.input.workspacePath);
      if (measuredWriteBytesPerSecond < this.dependencies.minimumWriteBytesPerSecond) {
        failures.push("write_throughput_insufficient");
      }
    } catch {
      failures.push("write_throughput_insufficient");
    }
    try {
      this.driver = await this.dependencies.createDriver(this.input);
      target = this.driver.target;
      const unavailable = this.input.request.requested_audio_roles.filter(
        (role) => !this.driver?.availableAudioRoles.includes(role),
      );
      if (unavailable.length) failures.push("audio_device_unavailable");
      if (envelope && failures.length === 0) encoder = await this.driver.warmUp(envelope);
      this.surfaceReference = await fs.readFile(path.join(this.input.workspacePath, "evidence/reference-initial.bgra"));
    } catch (error) {
      failures.push(failure(error, "encoder_warmup_failed"));
    }
    this.preflightResult = {
      version: RECORDING_V4_CONTRACT_VERSION,
      profile: RECORDING_V4_PROFILE,
      platform: this.dependencies.platform,
      target,
      dimensions: { physical_width: 1920, physical_height: 1080 },
      permission_granted: !failures.includes("permission_denied"),
      storage_available_bytes: availableBytes,
      storage_required_bytes: storageRequiredBytes,
      measured_write_bytes_per_second: measuredWriteBytesPerSecond,
      encoder,
      requested_audio_roles: [...this.input.request.requested_audio_roles],
      available_audio_roles: this.driver?.availableAudioRoles ?? [],
      passed: failures.length === 0 && encoder !== null,
      failure_codes: [...new Set(failures)],
    };
    return this.preflightResult;
  }

  async warmUp(): Promise<void> {
    const preflight = await this.preflight();
    if (!preflight.passed || !this.driver || !this.envelope) {
      const error = new Error("Recording V4 preflight did not pass") as Error & { recordingV4FailureCode: RecordingV4FailureCode };
      error.recordingV4FailureCode = preflight.failure_codes[0] ?? "encoder_warmup_failed";
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.driver || !this.envelope) throw new Error("Recording V4 driver is not ready");
    await this.driver.start(this.envelope);
  }
  async pause(): Promise<void> { await this.driver?.pause(); }
  async resume(): Promise<void> { await this.driver?.resume(); }

  async stop(): Promise<RecordingV4Result> {
    if (!this.driver || !this.surfaceReference) throw new Error("Recording V4 driver is not active");
    const native = await this.driver.stop();
    this.input.publishCadence(native.cadence);
    const probe = await this.dependencies.artifactProbe(native.artifact_path);
    const quality = await this.dependencies.qualityProbe(
      native.artifact_path, this.surfaceReference, this.dependencies.runtimeProfile.quality,
    );
    const audioArtifacts = await this.dependencies.extractAudio(
      native.artifact_path, this.input.workspacePath, this.input.request.requested_audio_roles,
      native.audio,
    );
    const actionsPath = path.join(this.input.workspacePath, "sidecars/actions.json");
    const cursorPath = path.join(this.input.workspacePath, "sidecars/cursor.json");
    await Promise.all([fs.access(actionsPath), fs.access(cursorPath)]);
    return this.dependencies.finalizer.finalize({
      session_id: this.input.sessionId,
      project_path: this.input.request.project_path,
      workspace_path: this.input.workspacePath,
      target: this.driver.target,
      native,
      artifact_probe: probe,
      quality,
      required_quality_reference_ids: ["initial-surface"],
      requested_audio_roles: this.input.request.requested_audio_roles,
      audio_artifacts: audioArtifacts,
      actions_path: actionsPath,
      cursor_path: cursorPath,
    });
  }

  async cancel(): Promise<void> { await this.driver?.cancel(); }
  async dispose(): Promise<void> { await this.driver?.close(); }
}

export function createRecordingV4PlatformSessionFactory(
  dependencies: RecordingV4PlatformDependencies,
): RecordingV4PlatformSessionFactory {
  if (dependencies.platform !== dependencies.runtimeProfile.platform) {
    throw new Error("Recording V4 runtime profile platform mismatch");
  }
  return (input) => new HostRecordingV4PlatformSession(input, dependencies);
}

function metric(measured: number, threshold: number, comparator: "gte" | "lte"): RecordingV4QualityMetric {
  return { measured, threshold, comparator, passed: comparator === "gte" ? measured >= threshold : measured <= threshold };
}

async function defaultQualityProbe(
  artifactPath: string,
  reference: Buffer,
  thresholds: RecordingV4QualityThresholds,
): Promise<RecordingV4QualityEvidence> {
  const decoder = new SequentialMasterDecoder(artifactPath, 1920, 1080);
  try {
    const actual = Buffer.from(await decoder.readFrame(0));
    const ssim = frameSsim(reference, actual, 1920, 1080);
    const edgeSpread = runtimeEdgeSpreadIncrease(reference, actual, 1920, 1080);
    const colorDelta = stableColorChannelDelta(reference, actual, 1920, 1080);
    const checkpoint = {
      frame_slot: 0,
      reference_id: "initial-surface",
      full_frame_luma_ssim: metric(ssim, thresholds.full_frame_luma_ssim, "gte"),
      text_edge_roi_ssim: metric(ssim, thresholds.text_edge_roi_ssim, "gte"),
      edge_spread_increase_px: metric(edgeSpread, thresholds.edge_spread_increase_px, "lte"),
      color_channel_delta: metric(colorDelta, thresholds.color_channel_delta, "lte"),
    };
    const passed = Object.values(checkpoint).filter((value) => typeof value === "object")
      .every((value) => (value as RecordingV4QualityMetric).passed !== false);
    return { checkpoints: [checkpoint], verdict: passed ? "passed" : "failed",
      failure_codes: passed ? [] : ["quality_checkpoint_failed"] };
  } finally {
    decoder.close();
  }
}

export function recordingV4RuntimeProfile(
  platform: "darwin" | "win32",
): RecordingV4RuntimeProfile {
  return {
    platform,
    calibration: {
      source: "built_in_profile",
      encoder_id: platform === "darwin" ? "videotoolbox-h264" : "media-foundation-hardware-h264",
      minimum_required_bitrate_bps: 10_000_000,
      sustained_bitrate_bps: 25_000_000,
      peak_bitrate_bps: 30_000_000,
    },
    safety_headroom_ratio: 0.2,
    quality: {
      full_frame_luma_ssim: 0.99,
      text_edge_roi_ssim: 0.99,
      edge_spread_increase_px: 1,
      color_channel_delta: 1,
    },
  };
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `process exited ${code}`)));
  });
}

export function recordingV4SurfaceOptions(
  request: RecordingV4PlatformSessionInput["request"],
): RecordingV4BrowserSurfaceOptions {
  if (!request.source_url || !Number.isSafeInteger(request.logical_width) ||
    !Number.isSafeInteger(request.logical_height) || request.logical_width <= 0 || request.logical_height <= 0 ||
    request.logical_width / request.logical_height !== 16 / 9) throw new Error("Invalid V4 author-preview source");
  return {
    url: request.source_url,
    contentViewport: { width: 1280, height: 720 },
    dimensions: {
      logical_width: request.logical_width,
      logical_height: request.logical_height,
      capture_dpr: 1920 / request.logical_width,
      physical_width: 1920,
      physical_height: 1080,
      requested_output_width: 1920,
      requested_output_height: 1080,
    },
  };
}

async function createSurface(input: RecordingV4PlatformSessionInput): Promise<RecordingV4BrowserSurface> {
  const surface = new RecordingV4BrowserSurface(recordingV4SurfaceOptions(input.request));
  await surface.load();
  const reference = await surface.captureReference(0);
  await fs.mkdir(path.join(input.workspacePath, "evidence"), { recursive: true });
  await fs.writeFile(path.join(input.workspacePath, "evidence/reference-initial.bgra"), reference.pixels);
  return surface;
}

function macTargetIdentity(surface: RecordingV4BrowserSurface): { identity: RecordingV4TargetIdentity; native: MacRecordingV4NativeTarget } {
  const target = surface.macTarget();
  if (target.kind !== "window" || !target.windowID || !target.ownerPID ||
    !target.ownerBundleID || !target.mediaSourceID) throw new Error("macOS V4 requires a window target");
  const title = surface.window.getTitle();
  const value = `window:${target.windowID}:${target.ownerPID}:${target.ownerBundleID}:${title}:${surface.window.getContentBounds().width}x${surface.window.getContentBounds().height}`;
  const stableId = createHash("sha256").update(value).digest("hex");
  const identity: RecordingV4TargetIdentity = { kind: "author_preview", stable_id: stableId,
    process_id: target.ownerPID, initial_title: title || null };
  return { identity, native: { identity, windowId: target.windowID, ownerBundleId: target.ownerBundleID,
    mediaSourceId: target.mediaSourceID, logicalWidth: surface.window.getContentBounds().width,
    logicalHeight: surface.window.getContentBounds().height } };
}

async function defaultDriver(input: RecordingV4PlatformSessionInput): Promise<RecordingV4NativeDriver> {
  const surface = await createSurface(input);
  const isPackaged = isPackagedRuntime(app);
  let registered = false;
  const registerSurface = () => {
    registerRecordingV4AutomationSurface(input.sessionId, {
      contents: surface.contents,
      inputCoordinateScale: surface.inputCoordinateScale(),
      cursorCoordinateSize: {
        width: RECORDING_V4_CURSOR_COORDINATE_WIDTH,
        height: RECORDING_V4_CURSOR_COORDINATE_HEIGHT,
      },
      currentMediaTimeMs: () => input.activeMediaTimeUs() / 1_000,
      recordAction: input.recordAction,
      recordCursorSample: (point) => input.recordCursorSample({
        ...point,
        coordinate_width: RECORDING_V4_CURSOR_COORDINATE_WIDTH,
        coordinate_height: RECORDING_V4_CURSOR_COORDINATE_HEIGHT,
        kind: "default",
        visible: true,
        pressed: false,
      }),
      isActive: input.isActive,
    });
    registered = true;
  };
  const closeSurface = () => {
    if (registered) unregisterRecordingV4AutomationSurface(input.sessionId);
    surface.destroy();
  };
  if (process.platform === "darwin") {
    const target = macTargetIdentity(surface);
    const helperPath = resolveMacRecordingV4HelperPath({
      isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    const backend = new MacRecordingV4Backend(helperPath);
    registerSurface();
    let envelope: RecordingV4EncoderEnvelope;
    return {
      helperPid: null, target: target.identity, availableAudioRoles: ["microphone", "system"],
      async warmUp(value) { envelope = value; return (await backend.warmup({ target: target.native,
        requestedAudioRoles: input.request.requested_audio_roles, encoderEnvelope: value })).encoder; },
      start: () => backend.start({ target: target.native, requestedAudioRoles: input.request.requested_audio_roles,
        encoderEnvelope: envelope, sessionId: input.sessionId,
        artifactPath: path.join(input.workspacePath, "master/video.mp4"), showsCursor: input.request.include_cursor }),
      pause: () => backend.pause(), resume: () => backend.resume(),
      async stop() { const value: MacRecordingV4NativeResult = await backend.stop(); return {
        artifact_path: value.artifact_path, encoder: value.encoder_evidence, cadence: value.cadence,
        audio: value.audio_evidence, failure_codes: [],
      }; },
      cancel: () => backend.cancel(),
      async close() { backend.close(); closeSurface(); },
    };
  }
  if (process.platform === "win32") {
    const target = surface.windowsTarget();
    if (target.kind !== "window") throw new Error("Windows V4 requires a window target");
    const identity: RecordingV4TargetIdentity = { kind: "author_preview",
      stable_id: `${target.executable_path}|${target.class_name}`, process_id: target.process_id,
      initial_title: surface.window.getTitle() || null };
    const helperPath = resolveWindowsRecordingV4HelperPath({ isPackaged,
      resourcesPath: process.resourcesPath, appPath: app.getAppPath(), arch: process.arch });
    const backend = new WindowsRecordingV4Backend({ helperPath, onFailure: (error) => input.fail(error.failureCode) });
    registerSurface();
    let options: WindowsRecordingV4StartOptions;
    return {
      helperPid: null, target: identity, availableAudioRoles: ["microphone", "system"],
      async warmUp(envelope) { options = { session_id: input.sessionId,
        output_path: path.join(input.workspacePath, "master/video.mp4"), target,
        target_identity: identity, include_cursor: input.request.include_cursor,
        requested_audio_roles: input.request.requested_audio_roles, encoder_envelope: envelope };
        return (await backend.warmup(options)).encoder; },
      start: () => backend.start(options), pause: () => backend.pause(), resume: () => backend.resume(),
      async stop() { const value: WindowsRecordingV4FinalEvidence = await backend.stop(); return {
        artifact_path: value.artifact_path, encoder: value.encoder, cadence: value.cadence,
        audio: value.audio, failure_codes: value.failure_codes,
      }; },
      cancel: () => backend.cancel(),
      async close() { await backend.close(); closeSurface(); },
    };
  }
  closeSurface();
  throw new Error("Recording V4 is unsupported on this platform");
}

export function createDefaultRecordingV4PlatformSessionFactory(): RecordingV4PlatformSessionFactory {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : null;
  if (!platform) throw new Error("Recording V4 platform is unsupported");
  const runtimeProfile = recordingV4RuntimeProfile(platform);
  return createRecordingV4PlatformSessionFactory({
    platform, runtimeProfile, createDriver: defaultDriver,
    async storageProbe(workspacePath) { const stats = await fs.statfs(workspacePath); return {
      availableBytes: Number(stats.bavail) * Number(stats.bsize) }; },
    async throughputProbe(workspacePath) {
      const probePath = path.join(workspacePath, ".write-throughput-probe");
      const bytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
      const started = process.hrtime.bigint();
      const handle = await fs.open(probePath, "wx");
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); await fs.rm(probePath, { force: true }); }
      return Math.floor(bytes.byteLength / (Number(process.hrtime.bigint() - started) / 1_000_000_000));
    },
    minimumWriteBytesPerSecond: Math.ceil(runtimeProfile.calibration.peak_bitrate_bps / 8),
    async artifactProbe(artifactPath) { const probe = await probeRecording(artifactPath, { verifiedFullDecode: true });
      if (probe.status !== "valid") return { finalized: false, full_decode_succeeded: false,
        decoded_frames: 0, duration_us: 0, physical_width: 0, physical_height: 0 };
      return { finalized: true, full_decode_succeeded: probe.full_decode_succeeded,
        decoded_frames: probe.counted_frames ?? probe.declared_frames ?? 0,
        duration_us: Math.round((probe.duration_ms ?? 0) * 1000), physical_width: probe.width,
        physical_height: probe.height };
    },
    qualityProbe: defaultQualityProbe,
    async extractAudio(artifactPath, workspacePath, roles, evidence) {
      const outputs: Array<{ role: RecordingV4AudioRole; source_path: string }> = [];
      for (let index = 0; index < roles.length; index += 1) {
        const role = roles[index];
        const outputPath = path.join(workspacePath, "audio", `${role}.m4a`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const rawPath = path.join(path.dirname(artifactPath), `${role}.pcm`);
        const raw = await fs.stat(rawPath).then((stat) => stat.isFile()).catch(() => false);
        if (raw) {
          const audio = evidence.find((entry) => entry.role === role);
          if (!audio || (audio.codec !== "pcm_f32le" && audio.codec !== "pcm_s16le")) {
            throw new Error(`Recording V4 ${role} PCM evidence is missing or invalid.`);
          }
          await runProcess(ffmpegExecutablePath(), ["-y", "-v", "error",
            "-f", audio.codec === "pcm_f32le" ? "f32le" : "s16le",
            "-ar", String(audio.sample_rate_hz), "-ac", String(audio.channels), "-i", rawPath,
            "-c:a", "aac", outputPath]);
        } else {
          await runProcess(ffmpegExecutablePath(), ["-y", "-v", "error", "-i", artifactPath,
            "-map", `0:a:${index}`, "-c:a", "aac", outputPath]);
        }
        outputs.push({ role, source_path: outputPath });
      }
      return outputs;
    },
    finalizer: new RecordingV4BundleFinalizer(),
  });
}
