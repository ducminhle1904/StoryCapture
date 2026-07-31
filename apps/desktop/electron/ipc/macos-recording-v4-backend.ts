import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  RecordingV4AudioEvidence,
  RecordingV4AudioRole,
  RecordingV4CadenceEvidence,
  RecordingV4EncoderEnvelope,
  RecordingV4EncoderEvidence,
  RecordingV4FailureCode,
  RecordingV4TargetIdentity,
} from "@storycapture/shared-types/recording-v4";

export const MACOS_RECORDING_V4_PROTOCOL_VERSION = 4 as const;
export const MACOS_RECORDING_V4_BACKEND_ID = "screen-capture-kit" as const;
export const MACOS_RECORDING_V4_BACKEND_VERSION = "4.0.0" as const;

type MacRecordingV4Command =
  | "hello"
  | "warmup"
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "cancel"
  | "shutdown";

export interface MacRecordingV4HelperResponse {
  version: number;
  request_id?: string;
  event: string;
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export class MacRecordingV4Error extends Error {
  constructor(
    readonly code: RecordingV4FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MacRecordingV4Error";
  }
}

export interface MacRecordingV4NativeTarget {
  identity: RecordingV4TargetIdentity;
  windowId: number;
  ownerBundleId: string;
  mediaSourceId: string;
  logicalWidth: number;
  logicalHeight: number;
}

export interface MacRecordingV4Capability {
  version: 4;
  backend_id: typeof MACOS_RECORDING_V4_BACKEND_ID;
  backend_version: typeof MACOS_RECORDING_V4_BACKEND_VERSION;
  platform: "darwin";
  arch: string;
  profile: "verified_1080p60";
  supports_monotonic_60hz_scheduler: true;
  supports_frame_ledger: true;
  supports_encoder_envelope: true;
  supports_terminal_backpressure: true;
  supports_shared_audio_clock: true;
  supported_audio_roles: RecordingV4AudioRole[];
}

export interface MacRecordingV4WarmupInput {
  target: MacRecordingV4NativeTarget;
  requestedAudioRoles: RecordingV4AudioRole[];
  encoderEnvelope: RecordingV4EncoderEnvelope;
}

export interface MacRecordingV4WarmupEvidence {
  permission_granted: true;
  target_identity: string;
  physical_width: 1920;
  physical_height: 1080;
  requested_audio_roles: RecordingV4AudioRole[];
  available_audio_roles: RecordingV4AudioRole[];
  encoder_envelope: RecordingV4EncoderEnvelope;
  encoder: RecordingV4EncoderEvidence;
}

export interface MacRecordingV4StartInput extends MacRecordingV4WarmupInput {
  sessionId: string;
  artifactPath: string;
  showsCursor?: boolean;
}

export interface MacRecordingV4NativeResult {
  version: 4;
  profile: "verified_1080p60";
  artifact_path: string;
  artifact_bytes: number;
  finalized: true;
  artifact: {
    finalized: true;
    full_decode_succeeded: true;
    decoded_frames: number;
  };
  cadence: RecordingV4CadenceEvidence;
  encoder_evidence: RecordingV4EncoderEvidence;
  audio_evidence: RecordingV4AudioEvidence[];
  audio_track_roles: RecordingV4AudioRole[];
}

export interface MacRecordingV4Transport {
  request(
    command: MacRecordingV4Command,
    options?: { sessionId?: string; payload?: Record<string, unknown> },
  ): Promise<MacRecordingV4HelperResponse>;
  close(): void;
}

const V4_FAILURE_CODES = new Set<RecordingV4FailureCode>([
  "contract_mismatch",
  "illegal_transition",
  "helper_unavailable",
  "helper_protocol_mismatch",
  "helper_crashed",
  "permission_denied",
  "target_missing",
  "target_ambiguous",
  "target_changed",
  "target_lost",
  "surface_not_1080p",
  "storage_probe_failed",
  "storage_insufficient",
  "write_throughput_insufficient",
  "hardware_encoder_unavailable",
  "encoder_warmup_failed",
  "encoder_rejected_frame",
  "encoder_backpressure",
  "frame_slot_missing",
  "frame_ledger_invalid",
  "output_frame_count_mismatch",
  "output_pts_invalid",
  "artifact_finalize_failed",
  "artifact_probe_failed",
  "artifact_decode_failed",
  "quality_checkpoint_failed",
  "bitrate_outside_envelope",
  "audio_device_unavailable",
  "audio_format_invalid",
  "audio_continuity_failed",
  "audio_sync_failed",
  "journal_invalid",
  "journal_recovery_failed",
  "verification_timeout",
  "publication_failed",
]);

function asFailureCode(value: unknown, fallback: RecordingV4FailureCode): RecordingV4FailureCode {
  return typeof value === "string" && V4_FAILURE_CODES.has(value as RecordingV4FailureCode)
    ? (value as RecordingV4FailureCode)
    : fallback;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MacRecordingV4Error("helper_protocol_mismatch", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new MacRecordingV4Error("helper_protocol_mismatch", `${field} must be a positive integer`);
  }
  return value as number;
}

function assertExactTarget(target: MacRecordingV4NativeTarget): void {
  if (
    !Number.isSafeInteger(target.windowId) ||
    target.windowId <= 0 ||
    target.identity.process_id <= 0 ||
    target.ownerBundleId.length === 0 ||
    target.mediaSourceId !== `window:${target.windowId}:0` ||
    target.logicalWidth <= 0 ||
    target.logicalHeight <= 0
  ) {
    throw new MacRecordingV4Error("contract_mismatch", "native window identity is incomplete");
  }
}

function helperTarget(target: MacRecordingV4NativeTarget): Record<string, unknown> {
  assertExactTarget(target);
  return {
    kind: "window",
    windowID: target.windowId,
    ownerPID: target.identity.process_id,
    ownerBundleID: target.ownerBundleId,
    expectedIdentity: target.identity.stable_id,
    mediaSourceID: target.mediaSourceId,
  };
}

function helperPayload(input: MacRecordingV4WarmupInput): Record<string, unknown> {
  return {
    target: helperTarget(input.target),
    outputWidth: 1_920,
    outputHeight: 1_080,
    expectedLogicalWidth: input.target.logicalWidth,
    expectedLogicalHeight: input.target.logicalHeight,
    expectedPhysicalWidth: 1_920,
    expectedPhysicalHeight: 1_080,
    fpsNumerator: 60,
    fpsDenominator: 1,
    dynamicSizePolicy: "fail_on_change",
    requestedAudioRoles: [...new Set(input.requestedAudioRoles)].sort(),
    encoderEnvelope: input.encoderEnvelope,
  };
}

class MacRecordingV4HelperProcess implements MacRecordingV4Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: MacRecordingV4HelperResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextRequestId = 0;
  private closed = false;

  constructor(helperPath: string) {
    this.child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.failPending("helper_unavailable", error.message));
    this.child.once("exit", (code, signal) => {
      this.failPending("helper_crashed", `macOS V4 helper exited (${code ?? signal ?? "unknown"})`);
    });
  }

  request(
    command: MacRecordingV4Command,
    options: { sessionId?: string; payload?: Record<string, unknown> } = {},
  ): Promise<MacRecordingV4HelperResponse> {
    if (this.closed) {
      return Promise.reject(new MacRecordingV4Error("helper_crashed", "helper transport is closed"));
    }
    const requestId = `mac-v4-${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MacRecordingV4Error("verification_timeout", `${command} timed out`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({
          version: MACOS_RECORDING_V4_PROTOCOL_VERSION,
          request_id: requestId,
          command,
          session_id: options.sessionId,
          payload: options.payload,
        })}\n`,
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.failPending("helper_crashed", "helper transport closed");
  }

  private handleLine(line: string): void {
    let response: MacRecordingV4HelperResponse;
    try {
      response = JSON.parse(line) as MacRecordingV4HelperResponse;
    } catch {
      this.failPending("helper_protocol_mismatch", "helper emitted malformed JSON");
      return;
    }
    if (response.version !== MACOS_RECORDING_V4_PROTOCOL_VERSION) {
      this.failPending("helper_protocol_mismatch", "helper response version is not V4");
      return;
    }
    if (!response.request_id) return;
    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.request_id);
    if (!response.ok) {
      pending.reject(
        new MacRecordingV4Error(
          asFailureCode(response.code, "helper_protocol_mismatch"),
          response.message ?? "macOS V4 helper rejected the request",
        ),
      );
      return;
    }
    pending.resolve(response);
  }

  private failPending(code: RecordingV4FailureCode, message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new MacRecordingV4Error(code, message));
    }
    this.pending.clear();
  }
}

export class MacRecordingV4Backend {
  private readonly transport: MacRecordingV4Transport;
  private capability: MacRecordingV4Capability | null = null;
  private warmupSignature: string | null = null;
  private requestedAudioRoles: RecordingV4AudioRole[] = [];
  private state: "idle" | "ready" | "capturing" | "paused" | "terminal" = "idle";

  constructor(
    helperPath: string,
    transportFactory: (helperPath: string) => MacRecordingV4Transport = (path) =>
      new MacRecordingV4HelperProcess(path),
  ) {
    this.transport = transportFactory(helperPath);
  }

  async hello(): Promise<MacRecordingV4Capability> {
    const response = await this.transport.request("hello");
    this.assertV4(response);
    const data = record(response.data, "hello.data");
    const roles = data.supported_audio_roles;
    if (
      data.backend_id !== MACOS_RECORDING_V4_BACKEND_ID ||
      data.backend_version !== MACOS_RECORDING_V4_BACKEND_VERSION ||
      data.platform !== "darwin" ||
      data.profile !== "verified_1080p60" ||
      typeof data.arch !== "string" ||
      data.supports_monotonic_60hz_scheduler !== true ||
      data.supports_frame_ledger !== true ||
      data.supports_encoder_envelope !== true ||
      data.supports_terminal_backpressure !== true ||
      data.supports_shared_audio_clock !== true ||
      !Array.isArray(roles) ||
      !roles.includes("microphone") ||
      !roles.includes("system")
    ) {
      throw new MacRecordingV4Error("helper_protocol_mismatch", "helper V4 capability is incomplete");
    }
    this.capability = {
      version: 4,
      backend_id: MACOS_RECORDING_V4_BACKEND_ID,
      backend_version: MACOS_RECORDING_V4_BACKEND_VERSION,
      platform: "darwin",
      arch: data.arch,
      profile: "verified_1080p60",
      supports_monotonic_60hz_scheduler: true,
      supports_frame_ledger: true,
      supports_encoder_envelope: true,
      supports_terminal_backpressure: true,
      supports_shared_audio_clock: true,
      supported_audio_roles: ["microphone", "system"],
    };
    return this.capability;
  }

  async warmup(input: MacRecordingV4WarmupInput): Promise<MacRecordingV4WarmupEvidence> {
    if (!this.capability) await this.hello();
    if (this.state !== "idle") {
      throw new MacRecordingV4Error("illegal_transition", "warmup requires idle state");
    }
    const response = await this.transport.request("warmup", { payload: helperPayload(input) });
    this.assertV4(response);
    const data = record(response.data, "warmup.data");
    const encoder = record(data.encoder, "warmup.data.encoder");
    const emittedEnvelope = record(encoder.envelope, "warmup.data.encoder.envelope");
    if (
      data.permission_granted !== true ||
      typeof data.target_identity !== "string" ||
      data.target_identity !== input.target.identity.stable_id ||
      data.physical_width !== 1_920 ||
      data.physical_height !== 1_080 ||
      encoder.encoder_id !== input.encoderEnvelope.encoder_id ||
      encoder.hardware_accelerated !== true ||
      encoder.requested_bitrate_bps !== input.encoderEnvelope.target_bitrate_bps ||
      !Number.isSafeInteger(encoder.average_bitrate_bps) ||
      (encoder.average_bitrate_bps as number) < input.encoderEnvelope.minimum_bitrate_bps ||
      (encoder.average_bitrate_bps as number) > input.encoderEnvelope.maximum_bitrate_bps ||
      !Number.isSafeInteger(encoder.peak_bitrate_bps) ||
      (encoder.peak_bitrate_bps as number) < (encoder.average_bitrate_bps as number) ||
      (encoder.peak_bitrate_bps as number) > input.encoderEnvelope.maximum_bitrate_bps ||
      emittedEnvelope.source !== input.encoderEnvelope.source ||
      emittedEnvelope.encoder_id !== input.encoderEnvelope.encoder_id ||
      emittedEnvelope.minimum_bitrate_bps !== input.encoderEnvelope.minimum_bitrate_bps ||
      emittedEnvelope.target_bitrate_bps !== input.encoderEnvelope.target_bitrate_bps ||
      emittedEnvelope.maximum_bitrate_bps !== input.encoderEnvelope.maximum_bitrate_bps ||
      emittedEnvelope.safety_headroom_ratio !== input.encoderEnvelope.safety_headroom_ratio
    ) {
      throw new MacRecordingV4Error("helper_protocol_mismatch", "warmup evidence is invalid");
    }
    this.warmupSignature = JSON.stringify(helperPayload(input));
    this.requestedAudioRoles = [...new Set(input.requestedAudioRoles)].sort();
    this.state = "ready";
    return {
      permission_granted: true,
      target_identity: data.target_identity,
      physical_width: 1_920,
      physical_height: 1_080,
      requested_audio_roles: [...new Set(input.requestedAudioRoles)].sort(),
      available_audio_roles: ["microphone", "system"],
      encoder_envelope: input.encoderEnvelope,
      encoder: encoder as unknown as RecordingV4EncoderEvidence,
    };
  }

  async start(input: MacRecordingV4StartInput): Promise<void> {
    if (this.state !== "ready" || this.warmupSignature !== JSON.stringify(helperPayload(input))) {
      throw new MacRecordingV4Error("illegal_transition", "start requires the accepted warmup input");
    }
    if (!input.sessionId || !input.artifactPath) {
      throw new MacRecordingV4Error("contract_mismatch", "session and artifact paths are required");
    }
    const response = await this.transport.request("start", {
      sessionId: input.sessionId,
      payload: {
        ...helperPayload(input),
        artifactPath: input.artifactPath,
        showsCursor: input.showsCursor ?? true,
      },
    });
    this.assertV4(response);
    this.state = "capturing";
  }

  async pause(): Promise<void> {
    if (this.state !== "capturing") throw new MacRecordingV4Error("illegal_transition", "pause requires capture");
    this.assertV4(await this.transport.request("pause"));
    this.state = "paused";
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") throw new MacRecordingV4Error("illegal_transition", "resume requires pause");
    this.assertV4(await this.transport.request("resume"));
    this.state = "capturing";
  }

  async stop(): Promise<MacRecordingV4NativeResult> {
    if (this.state !== "capturing" && this.state !== "paused") {
      throw new MacRecordingV4Error("illegal_transition", "stop requires an active capture");
    }
    const response = await this.transport.request("stop");
    this.assertV4(response);
    this.state = "terminal";
    const data = record(response.data, "stop.data");
    const artifact = record(data.artifact, "stop.data.artifact");
    const cadence = record(data.cadence, "stop.data.cadence");
    const encoder = record(data.encoder_evidence, "stop.data.encoder_evidence");
    const frameRate = record(cadence.frame_rate, "stop.data.cadence.frame_rate");
    const cadenceLedger = cadence.ledger;
    const outputFrames = cadence.output_frames;
    const audioEvidence = data.audio_evidence;
    const audioTrackRoles = data.audio_track_roles;
    const evidenceRoles = Array.isArray(audioEvidence)
      ? audioEvidence.map((value) => record(value, "audio_evidence entry").role).sort()
      : [];
    const audioValid = Array.isArray(audioEvidence) && audioEvidence.every((value) => {
      const audio = record(value, "audio_evidence entry");
      const tolerance = audio.sync_tolerance_us;
      const startOffset = audio.started_offset_us;
      const endDrift = audio.end_drift_us;
      const captured = audio.status === "captured";
      return (
        (audio.role === "microphone" || audio.role === "system") &&
        audio.requested === true &&
        (captured || audio.status === "failed") &&
        Number.isSafeInteger(tolerance) &&
        (tolerance as number) > 0 &&
        Number.isSafeInteger(startOffset) &&
        Number.isSafeInteger(endDrift) &&
        typeof audio.pause_mapping_valid === "boolean" &&
        Number.isSafeInteger(audio.continuity_gaps) &&
        (audio.continuity_gaps as number) >= 0 &&
        Array.isArray(audio.ledger) &&
        (audio.duration_us === 0 || audio.ledger.length > 0) &&
        Array.isArray(audio.failure_codes) &&
        (!captured ||
          (audio.pause_mapping_valid === true &&
            audio.continuity_gaps === 0 &&
            Math.abs(startOffset as number) <= (tolerance as number) &&
            Math.abs(endDrift as number) <= (tolerance as number) &&
            audio.failure_codes.length === 0))
      );
    });
    if (
      data.version !== 4 ||
      data.profile !== "verified_1080p60" ||
      typeof data.artifact_path !== "string" ||
      positiveInteger(data.artifact_bytes, "artifact_bytes") <= 0 ||
      data.finalized !== true ||
      artifact.finalized !== true ||
      artifact.full_decode_succeeded !== true ||
      !Number.isSafeInteger(artifact.decoded_frames) ||
      cadence.version !== 4 ||
      frameRate.numerator !== 60 ||
      frameRate.denominator !== 1 ||
      cadence.verdict !== "passed" ||
      !Number.isSafeInteger(outputFrames) ||
      (outputFrames as number) <= 0 ||
      !Array.isArray(cadenceLedger) ||
      cadenceLedger.length !== outputFrames ||
      encoder.hardware_accelerated !== true ||
      !Number.isSafeInteger(encoder.average_bitrate_bps) ||
      !Number.isSafeInteger(encoder.peak_bitrate_bps) ||
      (encoder.peak_bitrate_bps as number) < (encoder.average_bitrate_bps as number) ||
      !Array.isArray(audioEvidence) ||
      !Array.isArray(audioTrackRoles) ||
      JSON.stringify(evidenceRoles) !== JSON.stringify(this.requestedAudioRoles) ||
      JSON.stringify([...audioTrackRoles].sort()) !== JSON.stringify(this.requestedAudioRoles) ||
      !audioValid
    ) {
      throw new MacRecordingV4Error("helper_protocol_mismatch", "terminal V4 evidence is invalid");
    }
    return data as unknown as MacRecordingV4NativeResult;
  }

  async cancel(): Promise<void> {
    if (this.state === "terminal") return;
    this.assertV4(await this.transport.request("cancel"));
    this.state = "terminal";
  }

  close(): void {
    this.transport.close();
  }

  private assertV4(response: MacRecordingV4HelperResponse): void {
    if (response.version !== MACOS_RECORDING_V4_PROTOCOL_VERSION) {
      throw new MacRecordingV4Error("helper_protocol_mismatch", "helper response version is not V4");
    }
  }
}
