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
import { CaptureBackendV2Guard, validateCaptureBackendV2Request } from "./capture-backend-v2-guard";
import { recordingStoragePreflight } from "./recording-bundle";
import { recordingCertificationTierMatches } from "./recording-certification-catalog";
import { measureRecordingMasterThroughput } from "./recording-throughput-probe";
import {
  encodeWindowsCaptureCommand,
  parseWindowsCaptureEvent,
  validateWindowsCaptureTarget,
  WINDOWS_CAPTURE_BACKEND_ID,
  WINDOWS_CAPTURE_BACKEND_VERSION,
  type WindowsCaptureFrameCommit,
  type WindowsCaptureHelperCommand,
  type WindowsCaptureHelperEvent,
  type WindowsCaptureHelperTransport,
  type WindowsCaptureProbeResult,
  WindowsCaptureProtocolError,
  type WindowsCaptureSessionOptions,
  type WindowsCaptureTarget,
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
