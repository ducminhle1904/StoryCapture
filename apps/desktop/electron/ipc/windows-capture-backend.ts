import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import type {
  CaptureBackendV2,
  CaptureBackendV2Capabilities,
  CaptureBackendV2SessionStart,
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
} from "@storycapture/shared-types/recording-v2";
import type { RecordingV3FailureCode } from "@storycapture/shared-types/recording-v3";
import { CaptureBackendV2Guard, validateCaptureBackendV2Request } from "./capture-backend-v2-guard";
import { recordingStoragePreflight } from "./recording-bundle";
import { recordingCertificationTierMatches } from "./recording-certification-catalog";
import { measureRecordingMasterThroughput } from "./recording-throughput-probe";
import {
  encodeWindowsCaptureCommand,
  encodeWindowsNativeCaptureCommand,
  parseWindowsCaptureEvent,
  parseWindowsNativeCaptureEvent,
  validateWindowsCaptureTarget,
  WINDOWS_CAPTURE_BACKEND_ID,
  WINDOWS_CAPTURE_BACKEND_VERSION,
  WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
  type WindowsCaptureFrameCommit,
  type WindowsCaptureHelperCommand,
  type WindowsCaptureHelperEvent,
  type WindowsCaptureHelperTransport,
  type WindowsCaptureProbeResult,
  WindowsCaptureProtocolError,
  type WindowsCaptureSessionOptions,
  type WindowsCaptureTarget,
  type WindowsNativeCaptureCapabilities,
  type WindowsNativeCaptureEvidence,
  type WindowsNativeCaptureHelperCommand,
  type WindowsNativeCaptureHelperEvent,
  type WindowsNativeCaptureHelperTransport,
  WindowsNativeCaptureProtocolError,
  type WindowsNativeCaptureStartOptions,
  type WindowsNativeFrameSink,
  windowsProbeToPreflight,
} from "./windows-capture-protocol";

const HELPER_START_TIMEOUT_MS = 5_000;
const HELPER_COMMAND_TIMEOUT_MS = 10_000;
const SOURCE_PROBE_DURATION_MS = 2_000;
const WINDOWS_GRAPHICS_CAPTURE_CAPABILITIES: CaptureBackendV2Capabilities = {
  version: 2,
  backend_id: WINDOWS_CAPTURE_BACKEND_ID,
  backend_version: WINDOWS_CAPTURE_BACKEND_VERSION,
  target_classes: ["display", "window"],
  supports_native_timestamps: true,
  supports_source_sequences: true,
  supports_physical_pixels: true,
  supports_cursor_policy: true,
  supports_pause_resume: true,
};

export type WindowsCaptureBackendState =
  | "idle"
  | "probing"
  | "ready"
  | "starting"
  | "capturing"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export interface WindowsCaptureProbeContext {
  certificationMatch: boolean;
  encodeThroughputRatio: number;
  estimatedBytesPerSecond: number;
  requiredBytesForTenMinutes: number;
  availableBytes: number;
  reserveBytes: number;
}

export interface WindowsGraphicsCaptureBackendOptions {
  target: WindowsCaptureTarget;
  cursorPolicy: "include" | "exclude";
  dynamicSizePolicy: "fail";
  ownershipToken: string;
  nativeFrameSink: WindowsNativeFrameSink;
  probeContext: (
    request: RecordingPreflightV2Request,
    nativeResult: WindowsCaptureProbeResult,
  ) => Promise<WindowsCaptureProbeContext>;
  transport?: WindowsCaptureHelperTransport;
  helperPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  onFailure?: (error: WindowsCaptureProtocolError) => void;
  onClockAnchor?: (anchor: { qpcTimestampUs: number; audioSampleRate: 48_000 }) => void;
}

export function windowsCertificationMatches(
  request: RecordingPreflightV2Request,
  result: WindowsCaptureProbeResult,
  arch: string,
): boolean {
  return recordingCertificationTierMatches(request.desired_tier, {
    platform: "win32",
    arch,
    hardwareFingerprint: result.hardware_fingerprint,
    targetClass: request.target_class,
    capabilities: WINDOWS_GRAPHICS_CAPTURE_CAPABILITIES,
    outputWidth: request.dimensions.requested_output_width,
    outputHeight: request.dimensions.requested_output_height,
  });
}

export function createWindowsCaptureProbeContextProvider(
  exportsDir: string,
  arch: string,
): WindowsGraphicsCaptureBackendOptions["probeContext"] {
  return async (request, nativeResult) => {
    const [encodeThroughputRatio, storage] = await Promise.all([
      measureRecordingMasterThroughput(exportsDir, request),
      recordingStoragePreflight(exportsDir, {
        width: request.dimensions.physical_width,
        height: request.dimensions.physical_height,
        fps: 60,
      }),
    ]);
    return {
      certificationMatch: windowsCertificationMatches(request, nativeResult, arch),
      encodeThroughputRatio,
      estimatedBytesPerSecond: storage.estimated_bytes_per_second,
      requiredBytesForTenMinutes: storage.required_bytes_for_ten_minutes,
      availableBytes: storage.available_bytes,
      reserveBytes: storage.reserve_bytes,
    };
  };
}

export interface WindowsCaptureHelperPathInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  arch: string;
}

export function resolveWindowsCaptureHelperPath(input: WindowsCaptureHelperPathInput): string {
  if (input.arch !== "x64" && input.arch !== "arm64") {
    throw new WindowsCaptureProtocolError(
      "backend_capability_mismatch",
      `Windows Graphics Capture helper does not support ${input.arch}`,
    );
  }
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "windows", input.arch, "storycapture-wgc.exe")
    : path.join(
        input.appPath,
        "native",
        "windows-capture",
        "bin",
        input.arch,
        "storycapture-wgc.exe",
      );
}

export class SpawnedWindowsCaptureHelper implements WindowsCaptureHelperTransport {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";

  constructor(private readonly executablePath: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.executablePath, ["--stdio-v2"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.events.emit("event", parseWindowsCaptureEvent(line));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.events.emit("event", {
          version: 2,
          type: "failure",
          session_id: null,
          failure_code: "contract_mismatch",
          message,
        } satisfies WindowsCaptureHelperEvent);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      this.events.emit("exit", code, signal);
    });
    child.once("error", (error) => {
      this.events.emit("event", {
        version: 2,
        type: "failure",
        session_id: null,
        failure_code: "backend_unavailable",
        message: `${error.message}${this.stderr ? `: ${this.stderr}` : ""}`,
      } satisfies WindowsCaptureHelperEvent);
    });
  }

  async send(command: WindowsCaptureHelperCommand): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new WindowsCaptureProtocolError(
        "backend_unavailable",
        "Windows capture helper is not running",
      );
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(encodeWindowsCaptureCommand(command), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onEvent(listener: (event: WindowsCaptureHelperEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

function sessionOptions(
  options: WindowsGraphicsCaptureBackendOptions,
  request: RecordingPreflightV2Request,
): WindowsCaptureSessionOptions {
  return {
    ownership_token: options.ownershipToken,
    target: options.target,
    cursor_policy: options.cursorPolicy,
    dynamic_size_policy: options.dynamicSizePolicy,
    audio_roles: request.audio_roles,
    requested_width: request.dimensions.physical_width,
    requested_height: request.dimensions.physical_height,
  };
}

export class WindowsGraphicsCaptureBackend implements CaptureBackendV2 {
  readonly capabilities = WINDOWS_GRAPHICS_CAPTURE_CAPABILITIES;

  private readonly transport: WindowsCaptureHelperTransport;
  private readonly guard = new CaptureBackendV2Guard(this.capabilities);
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private stateValue: WindowsCaptureBackendState = "idle";
  private startedTransport = false;
  private currentSessionId: string | null = null;
  private lastPreflight: RecordingPreflightV2Dto | null = null;
  private lastDeliverySequence = 0;
  private lastNativePtsUs = -1;
  private stickyFailure: WindowsCaptureProtocolError | null = null;
  private frameQueue = Promise.resolve();
  private readonly removeEventListener: () => void;
  private readonly removeExitListener: () => void;

  constructor(private readonly options: WindowsGraphicsCaptureBackendOptions) {
    validateWindowsCaptureTarget(options.target);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    if (!options.transport && !options.helperPath) {
      throw new WindowsCaptureProtocolError(
        "backend_unavailable",
        "Windows capture helper path or transport is required",
      );
    }
    this.transport =
      options.transport ?? new SpawnedWindowsCaptureHelper(options.helperPath as string);
    this.removeEventListener = this.transport.onEvent((event) => this.handleEvent(event));
    this.removeExitListener = this.transport.onExit((code, signal) => {
      if (this.stateValue !== "stopped" && this.stateValue !== "idle") {
        this.fail(
          "backend_unavailable",
          `Windows capture helper exited unexpectedly (${code ?? signal ?? "unknown"})`,
        );
      }
    });
  }

  get state(): WindowsCaptureBackendState {
    return this.stateValue;
  }

  get failure(): WindowsCaptureProtocolError | null {
    return this.stickyFailure;
  }

  async probe(request: RecordingPreflightV2Request): Promise<RecordingPreflightV2Dto> {
    this.assertPlatform();
    this.assertRequest(request);
    this.stateValue = "probing";
    await this.ensureTransport();
    const resultPromise = this.waitForEvent(
      (event): event is Extract<WindowsCaptureHelperEvent, { type: "probe-result" }> =>
        event.type === "probe-result",
      HELPER_COMMAND_TIMEOUT_MS,
    );
    await this.transport.send({
      version: 2,
      type: "probe",
      request,
      options: sessionOptions(this.options, request),
      duration_ms: SOURCE_PROBE_DURATION_MS,
    });
    const result = (await resultPromise).result;
    const context = await this.options.probeContext(request, result);
    const preflight = this.guard.acceptProbe(
      request,
      windowsProbeToPreflight(request, result, { arch: this.arch, ...context }),
    );
    this.lastPreflight = preflight;
    this.stateValue = "ready";
    return preflight;
  }

  async start(start: CaptureBackendV2SessionStart): Promise<void> {
    this.assertPlatform();
    this.assertRequest(start.request);
    if (this.stateValue !== "ready" || !this.lastPreflight) {
      throw new WindowsCaptureProtocolError(
        "preflight_failed",
        "Windows capture preflight is required",
      );
    }
    if (start.request.delivery_policy === "strict" && !this.lastPreflight.strict_eligible) {
      throw new WindowsCaptureProtocolError(
        "preflight_failed",
        "Windows Strict capture preflight failed",
      );
    }
    this.guard.begin(start);
    this.currentSessionId = start.session_id;
    this.lastDeliverySequence = 0;
    this.lastNativePtsUs = -1;
    this.stateValue = "starting";
    try {
      const readyPromise = this.waitForEvent(
        (event): event is Extract<WindowsCaptureHelperEvent, { type: "ready" }> =>
          event.type === "ready" && event.session_id === start.session_id,
        HELPER_COMMAND_TIMEOUT_MS,
      );
      await this.transport.send({
        version: 2,
        type: "start",
        session_id: start.session_id,
        request: start.request,
        options: sessionOptions(this.options, start.request),
      });
      const ready = await readyPromise;
      if (ready.ring.ownership_token !== this.options.ownershipToken) {
        throw new WindowsCaptureProtocolError(
          "contract_mismatch",
          "native frame-ring ownership token mismatch",
        );
      }
      await this.options.nativeFrameSink.open(ready.ring);
      this.stateValue = "capturing";
    } catch (error) {
      await this.transport
        .send({ version: 2, type: "stop", session_id: start.session_id })
        .catch(() => undefined);
      await this.options.nativeFrameSink.close().catch(() => undefined);
      this.currentSessionId = null;
      const failure =
        error instanceof WindowsCaptureProtocolError
          ? error
          : new WindowsCaptureProtocolError(
              "backend_unavailable",
              error instanceof Error ? error.message : String(error),
            );
      throw this.fail(failure.failureCode, failure.message);
    }
  }

  async pause(): Promise<void> {
    this.assertState("capturing");
    const sessionId = this.requireSession();
    const paused = this.waitForEvent(
      (event): event is Extract<WindowsCaptureHelperEvent, { type: "paused" }> =>
        event.type === "paused" && event.session_id === sessionId,
      HELPER_COMMAND_TIMEOUT_MS,
    );
    await this.transport.send({ version: 2, type: "pause", session_id: sessionId });
    await paused;
    this.guard.pause();
    this.stateValue = "paused";
  }

  async resume(): Promise<void> {
    this.assertState("paused");
    const sessionId = this.requireSession();
    const resumed = this.waitForEvent(
      (event): event is Extract<WindowsCaptureHelperEvent, { type: "resumed" }> =>
        event.type === "resumed" && event.session_id === sessionId,
      HELPER_COMMAND_TIMEOUT_MS,
    );
    await this.transport.send({ version: 2, type: "resume", session_id: sessionId });
    await resumed;
    this.guard.resume();
    this.stateValue = "capturing";
  }

  async stop(): Promise<void> {
    if (this.stateValue === "stopped" || this.stateValue === "idle") return;
    const sessionId = this.currentSessionId;
    this.stateValue = "stopping";
    if (sessionId && !this.stickyFailure) {
      const stopped = this.waitForEvent(
        (event): event is Extract<WindowsCaptureHelperEvent, { type: "stopped" }> =>
          event.type === "stopped" && event.session_id === sessionId,
        HELPER_COMMAND_TIMEOUT_MS,
      );
      await this.transport.send({ version: 2, type: "stop", session_id: sessionId });
      await stopped;
    } else if (sessionId) {
      await this.transport
        .send({ version: 2, type: "stop", session_id: sessionId })
        .catch(() => undefined);
    }
    await this.frameQueue;
    await this.options.nativeFrameSink.close();
    if (this.guard.lifecycle !== "stopped") this.guard.stop();
    this.currentSessionId = null;
    this.stateValue = this.stickyFailure ? "failed" : "stopped";
  }

  async shutdown(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.transport
      .send({ version: 2, type: "shutdown", session_id: this.currentSessionId })
      .catch(() => undefined);
    await this.transport.close();
    this.removeEventListener();
    this.removeExitListener();
  }

  private async ensureTransport(): Promise<void> {
    if (this.startedTransport) return;
    const hello = this.waitForEvent(
      (event): event is Extract<WindowsCaptureHelperEvent, { type: "hello" }> =>
        event.type === "hello",
      HELPER_START_TIMEOUT_MS,
    );
    await this.transport.start();
    await hello;
    this.startedTransport = true;
  }

  private handleEvent(event: WindowsCaptureHelperEvent): void {
    if (event.type === "failure") {
      this.fail(event.failure_code, event.message);
      return;
    }
    if (event.type === "target-lost") {
      this.fail(event.failure_code, "Windows capture target was lost or changed");
      return;
    }
    if (event.type === "format-changed") {
      this.fail(
        "target_changed",
        `Windows capture target changed size to ${event.width}x${event.height}`,
      );
      return;
    }
    if (event.type === "clock-anchor") {
      if (event.session_id === this.currentSessionId) {
        this.options.onClockAnchor?.({
          qpcTimestampUs: event.qpc_timestamp_us,
          audioSampleRate: event.audio_sample_rate,
        });
      }
      return;
    }
    if (event.type !== "frame-committed") return;
    if (event.session_id !== this.currentSessionId) {
      this.fail("contract_mismatch", "native helper emitted a frame for another session");
      return;
    }
    this.frameQueue = this.frameQueue
      .then(() => this.commitFrame(event))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.fail("submitted_frame_dropped", message);
      });
  }

  private async commitFrame(frame: WindowsCaptureFrameCommit): Promise<void> {
    if (this.stickyFailure) return;
    if (frame.ownership_token !== this.options.ownershipToken) {
      throw new WindowsCaptureProtocolError("contract_mismatch", "frame ownership token mismatch");
    }
    if (frame.delivery_sequence !== this.lastDeliverySequence + 1) {
      throw new WindowsCaptureProtocolError(
        "source_sequence_gap",
        "frame delivery sequence is not contiguous",
      );
    }
    if (frame.native_pts_us <= this.lastNativePtsUs) {
      throw new WindowsCaptureProtocolError(
        frame.native_pts_us === this.lastNativePtsUs
          ? "artifact_pts_duplicate"
          : "artifact_pts_gap",
        "native frame timestamp is not strictly monotonic",
      );
    }
    this.guard.acceptFrame({
      source_sequence: frame.delivery_sequence,
      native_pts_us: frame.native_pts_us,
      width: frame.width,
      height: frame.height,
      stride: frame.stride,
      pixel_format: frame.pixel_format,
    });
    await this.options.nativeFrameSink.commit(frame);
    this.lastDeliverySequence = frame.delivery_sequence;
    this.lastNativePtsUs = frame.native_pts_us;
  }

  private waitForEvent<T extends WindowsCaptureHelperEvent>(
    predicate: (event: WindowsCaptureHelperEvent) => event is T,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remove = this.transport.onEvent((event) => {
        if (event.type === "failure") {
          clearTimeout(timeout);
          remove();
          reject(new WindowsCaptureProtocolError(event.failure_code, event.message));
          return;
        }
        if (!predicate(event)) return;
        clearTimeout(timeout);
        remove();
        resolve(event);
      });
      const timeout = setTimeout(() => {
        remove();
        reject(
          new WindowsCaptureProtocolError(
            "verification_timeout",
            "native helper command timed out",
          ),
        );
      }, timeoutMs);
    });
  }

  private fail(code: RecordingQualityFailureCode, message: string): WindowsCaptureProtocolError {
    if (!this.stickyFailure) {
      this.guard.fail(code, message);
      this.stickyFailure = new WindowsCaptureProtocolError(code, message);
      this.stateValue = "failed";
      this.options.onFailure?.(this.stickyFailure);
    }
    return this.stickyFailure;
  }

  private assertPlatform(): void {
    if (this.platform !== "win32") {
      throw new WindowsCaptureProtocolError(
        "backend_unavailable",
        "Windows Graphics Capture is available only on Windows",
      );
    }
  }

  private assertRequest(request: RecordingPreflightV2Request): void {
    const expectedTargetClass = this.options.target.kind === "display" ? "display" : "window";
    const failures = validateCaptureBackendV2Request(this.capabilities, request);
    if (request.target_class !== expectedTargetClass || failures.length > 0) {
      throw new WindowsCaptureProtocolError(
        "contract_mismatch",
        "capture request does not match Windows backend",
      );
    }
  }

  private assertState(expected: WindowsCaptureBackendState): void {
    if (this.stickyFailure) throw this.stickyFailure;
    if (this.stateValue !== expected) {
      throw new WindowsCaptureProtocolError(
        "contract_mismatch",
        `Windows capture backend is ${this.stateValue}; expected ${expected}`,
      );
    }
  }

  private requireSession(): string {
    if (!this.currentSessionId) {
      throw new WindowsCaptureProtocolError(
        "contract_mismatch",
        "Windows capture session is missing",
      );
    }
    return this.currentSessionId;
  }
}

export class SpawnedWindowsNativeCaptureHelper implements WindowsNativeCaptureHelperTransport {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";

  constructor(private readonly executablePath: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.executablePath, ["--stdio-v3"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.events.emit("event", parseWindowsNativeCaptureEvent(line));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.events.emit("event", {
          version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
          type: "failure",
          session_id: null,
          failure_code: "contract_mismatch",
          message,
        } satisfies WindowsNativeCaptureHelperEvent);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      this.events.emit("exit", code, signal);
    });
    child.once("error", (error) => {
      this.events.emit("event", {
        version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
        type: "failure",
        session_id: null,
        failure_code: "backend_unavailable",
        message: `${error.message}${this.stderr ? `: ${this.stderr}` : ""}`,
      } satisfies WindowsNativeCaptureHelperEvent);
    });
  }

  async send(command: WindowsNativeCaptureHelperCommand): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new WindowsNativeCaptureProtocolError(
        "backend_unavailable",
        "Windows native capture helper is not running",
      );
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(encodeWindowsNativeCaptureCommand(command), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onEvent(listener: (event: WindowsNativeCaptureHelperEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export interface WindowsNativeMp4CaptureSessionOptions {
  helperPath?: string;
  transport?: WindowsNativeCaptureHelperTransport;
  platform?: NodeJS.Platform;
  onFailure?: (error: WindowsNativeCaptureProtocolError) => void;
}

export type WindowsNativeMp4CaptureState =
  | "idle"
  | "ready"
  | "starting"
  | "capturing"
  | "paused"
  | "finalizing"
  | "stopped"
  | "failed";

export class WindowsNativeMp4CaptureSession {
  private readonly transport: WindowsNativeCaptureHelperTransport;
  private readonly platform: NodeJS.Platform;
  private stateValue: WindowsNativeMp4CaptureState = "idle";
  private currentSessionId: string | null = null;
  private startOptions: WindowsNativeCaptureStartOptions | null = null;
  private startedTransport = false;
  private stickyFailure: WindowsNativeCaptureProtocolError | null = null;
  private readonly removeEventListener: () => void;
  private readonly removeExitListener: () => void;

  constructor(private readonly options: WindowsNativeMp4CaptureSessionOptions) {
    if (!options.transport && !options.helperPath) {
      throw new WindowsNativeCaptureProtocolError(
        "backend_unavailable",
        "Windows native capture helper path or transport is required",
      );
    }
    this.platform = options.platform ?? process.platform;
    this.transport =
      options.transport ?? new SpawnedWindowsNativeCaptureHelper(options.helperPath as string);
    this.removeEventListener = this.transport.onEvent((event) => {
      if (event.type === "failure") this.fail(event.failure_code, event.message);
    });
    this.removeExitListener = this.transport.onExit((code, signal) => {
      if (this.stateValue !== "idle" && this.stateValue !== "stopped") {
        this.fail(
          "backend_unavailable",
          `Windows native capture helper exited unexpectedly (${code ?? signal ?? "unknown"})`,
        );
      }
    });
  }

  get state(): WindowsNativeMp4CaptureState {
    return this.stateValue;
  }

  get failure(): WindowsNativeCaptureProtocolError | null {
    return this.stickyFailure;
  }

  async capabilities(): Promise<WindowsNativeCaptureCapabilities> {
    this.assertPlatform();
    await this.ensureTransport();
    const response = this.waitForEvent(
      (event): event is Extract<WindowsNativeCaptureHelperEvent, { type: "capabilities" }> =>
        event.type === "capabilities",
      HELPER_COMMAND_TIMEOUT_MS,
    );
    await this.transport.send({
      version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
      type: "capabilities",
    });
    const capabilities = (await response).capabilities;
    this.stateValue = "ready";
    return capabilities;
  }

  async start(options: WindowsNativeCaptureStartOptions): Promise<void> {
    this.assertPlatform();
    if (this.stateValue !== "ready") {
      throw new WindowsNativeCaptureProtocolError(
        "preflight_failed",
        "Windows native capabilities must be accepted before start",
      );
    }
    validateWindowsCaptureTarget(options.target);
    if (
      !options.session_id ||
      !path.isAbsolute(options.output_path) ||
      options.requested_width <= 0 ||
      options.requested_height <= 0 ||
      options.requested_fps.numerator !== 60 ||
      options.requested_fps.denominator !== 1
    ) {
      throw new WindowsNativeCaptureProtocolError(
        "contract_mismatch",
        "invalid Windows native capture start options",
      );
    }
    this.stateValue = "starting";
    this.currentSessionId = options.session_id;
    this.startOptions = options;
    const started = this.waitForSessionEvent("started", options.session_id);
    await this.transport.send({
      version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
      type: "start",
      ...options,
    });
    await started;
    this.stateValue = "capturing";
  }

  async pause(): Promise<void> {
    this.assertState("capturing");
    const sessionId = this.requireSession();
    const paused = this.waitForSessionEvent("paused", sessionId);
    await this.transport.send({
      version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
      type: "pause",
      session_id: sessionId,
    });
    await paused;
    this.stateValue = "paused";
  }

  async resume(): Promise<void> {
    this.assertState("paused");
    const sessionId = this.requireSession();
    const resumed = this.waitForSessionEvent("resumed", sessionId);
    await this.transport.send({
      version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
      type: "resume",
      session_id: sessionId,
    });
    await resumed;
    this.stateValue = "capturing";
  }

  async stop(): Promise<WindowsNativeCaptureEvidence> {
    if (this.stickyFailure) throw this.stickyFailure;
    if (this.stateValue !== "capturing" && this.stateValue !== "paused") {
      throw new WindowsNativeCaptureProtocolError(
        "contract_mismatch",
        `Windows native capture session is ${this.stateValue}`,
      );
    }
    const sessionId = this.requireSession();
    this.stateValue = "finalizing";
    const finalized = this.waitForEvent(
      (event): event is Extract<WindowsNativeCaptureHelperEvent, { type: "finalized" }> =>
        event.type === "finalized" && event.session_id === sessionId,
      HELPER_COMMAND_TIMEOUT_MS,
    );
    await this.transport.send({
      version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
      type: "stop",
      session_id: sessionId,
    });
    const evidence = (await finalized).evidence;
    const startOptions = this.startOptions;
    if (
      !startOptions ||
      path.normalize(evidence.artifact_path) !== path.normalize(startOptions.output_path) ||
      evidence.width !== startOptions.requested_width ||
      evidence.height !== startOptions.requested_height
    ) {
      throw this.fail(
        "contract_mismatch",
        "Windows native artifact evidence does not match the start contract",
      );
    }
    this.currentSessionId = null;
    this.startOptions = null;
    this.stateValue = "stopped";
    return evidence;
  }

  async shutdown(): Promise<void> {
    await this.transport
      .send({
        version: WINDOWS_CAPTURE_NATIVE_PROTOCOL_VERSION,
        type: "shutdown",
        session_id: this.currentSessionId,
      })
      .catch(() => undefined);
    await this.transport.close();
    this.removeEventListener();
    this.removeExitListener();
  }

  private async ensureTransport(): Promise<void> {
    if (this.startedTransport) return;
    const hello = this.waitForEvent(
      (event): event is Extract<WindowsNativeCaptureHelperEvent, { type: "hello" }> =>
        event.type === "hello",
      HELPER_START_TIMEOUT_MS,
    );
    await this.transport.start();
    await hello;
    this.startedTransport = true;
  }

  private waitForSessionEvent<T extends "started" | "paused" | "resumed">(
    type: T,
    sessionId: string,
  ): Promise<Extract<WindowsNativeCaptureHelperEvent, { type: T }>> {
    return this.waitForEvent(
      (event): event is Extract<WindowsNativeCaptureHelperEvent, { type: T }> =>
        event.type === type && event.session_id === sessionId,
      HELPER_COMMAND_TIMEOUT_MS,
    );
  }

  private waitForEvent<T extends WindowsNativeCaptureHelperEvent>(
    predicate: (event: WindowsNativeCaptureHelperEvent) => event is T,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remove = this.transport.onEvent((event) => {
        if (event.type === "failure") {
          clearTimeout(timeout);
          remove();
          reject(new WindowsNativeCaptureProtocolError(event.failure_code, event.message));
          return;
        }
        if (!predicate(event)) return;
        clearTimeout(timeout);
        remove();
        resolve(event);
      });
      const timeout = setTimeout(() => {
        remove();
        reject(
          new WindowsNativeCaptureProtocolError(
            "verification_timeout",
            "Windows native helper command timed out",
          ),
        );
      }, timeoutMs);
    });
  }

  private fail(code: RecordingV3FailureCode, message: string): WindowsNativeCaptureProtocolError {
    if (!this.stickyFailure) {
      this.stickyFailure = new WindowsNativeCaptureProtocolError(code, message);
      this.stateValue = "failed";
      this.options.onFailure?.(this.stickyFailure);
    }
    return this.stickyFailure;
  }

  private assertPlatform(): void {
    if (this.platform !== "win32") {
      throw new WindowsNativeCaptureProtocolError(
        "backend_unavailable",
        "Windows Graphics Capture is available only on Windows",
      );
    }
  }

  private assertState(expected: WindowsNativeMp4CaptureState): void {
    if (this.stickyFailure) throw this.stickyFailure;
    if (this.stateValue !== expected) {
      throw new WindowsNativeCaptureProtocolError(
        "contract_mismatch",
        `Windows native capture session is ${this.stateValue}; expected ${expected}`,
      );
    }
  }

  private requireSession(): string {
    if (!this.currentSessionId) {
      throw new WindowsNativeCaptureProtocolError(
        "contract_mismatch",
        "Windows native capture session is missing",
      );
    }
    return this.currentSessionId;
  }
}
