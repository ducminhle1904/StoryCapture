import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import type {
  RecordingV4AudioEvidence,
  RecordingV4AudioRole,
  RecordingV4CadenceEvidence,
  RecordingV4EncoderEnvelope,
  RecordingV4EncoderEvidence,
  RecordingV4FailureCode,
  RecordingV4TargetIdentity,
} from "@storycapture/shared-types/recording-v4";
import type { WindowsCaptureTarget } from "./windows-capture-protocol";

export const WINDOWS_RECORDING_V4_PROTOCOL_VERSION = 4 as const;
export const WINDOWS_RECORDING_V4_BACKEND_ID = "windows-graphics-capture" as const;

export interface WindowsRecordingV4Capabilities {
  backend_id: typeof WINDOWS_RECORDING_V4_BACKEND_ID;
  backend_version: string;
  platform: "win32";
  arch: "x64" | "arm64";
  codec: "h264";
  pixel_format: "nv12";
  exact_fps: { numerator: 60; denominator: 1 };
  physical_width: 1920;
  physical_height: 1080;
  hardware_accelerated: true;
  keeps_surfaces_native: true;
  supports_pause_resume: true;
  supports_microphone: boolean;
  supports_system_audio: boolean;
  encoder_id: string;
}

export interface WindowsRecordingV4StartOptions {
  session_id: string;
  output_path: string;
  target: WindowsCaptureTarget;
  target_identity: RecordingV4TargetIdentity;
  include_cursor: boolean;
  requested_audio_roles: RecordingV4AudioRole[];
  encoder_envelope: RecordingV4EncoderEnvelope;
}

export type WindowsRecordingV4Command =
  | { version: 4; type: "capabilities" }
  | ({ version: 4; type: "warmup"; duration_ms: number } & WindowsRecordingV4StartOptions)
  | ({ version: 4; type: "start" } & WindowsRecordingV4StartOptions)
  | { version: 4; type: "pause" | "resume" | "stop" | "cancel"; session_id: string }
  | { version: 4; type: "shutdown"; session_id: string | null };

export interface WindowsRecordingV4FinalEvidence {
  artifact_path: string;
  encoder: RecordingV4EncoderEvidence;
  cadence: RecordingV4CadenceEvidence;
  audio: RecordingV4AudioEvidence[];
  finalized: true;
  failure_codes: RecordingV4FailureCode[];
}

export type WindowsRecordingV4Event =
  | { version: 4; type: "hello"; backend_id: string; backend_version: string; process_id: number }
  | { version: 4; type: "capabilities"; capabilities: WindowsRecordingV4Capabilities }
  | {
      version: 4;
      type: "warmup-result";
      session_id: string;
      passed: boolean;
      encoder: RecordingV4EncoderEvidence | null;
      available_audio_roles: RecordingV4AudioRole[];
      failure_codes: RecordingV4FailureCode[];
    }
  | { version: 4; type: "started" | "paused" | "resumed" | "cancelled"; session_id: string }
  | { version: 4; type: "finalized"; session_id: string; evidence: WindowsRecordingV4FinalEvidence }
  | {
      version: 4;
      type: "failure";
      session_id: string | null;
      failure_code: RecordingV4FailureCode;
      message: string;
    };

const FAILURE_CODES = new Set<RecordingV4FailureCode>([
  "contract_mismatch", "illegal_transition", "helper_unavailable", "helper_protocol_mismatch",
  "helper_crashed", "permission_denied", "target_missing", "target_ambiguous", "target_changed",
  "target_lost", "surface_not_1080p", "storage_probe_failed", "storage_insufficient",
  "write_throughput_insufficient", "hardware_encoder_unavailable", "encoder_warmup_failed",
  "encoder_rejected_frame", "encoder_backpressure", "frame_slot_missing", "frame_ledger_invalid",
  "output_frame_count_mismatch", "output_pts_invalid", "artifact_finalize_failed", "artifact_probe_failed",
  "artifact_decode_failed", "quality_checkpoint_failed", "bitrate_outside_envelope",
  "audio_device_unavailable", "audio_format_invalid", "audio_continuity_failed", "audio_sync_failed",
  "journal_invalid", "journal_recovery_failed", "verification_timeout", "publication_failed",
]);

export class WindowsRecordingV4ProtocolError extends Error {
  constructor(
    readonly failureCode: RecordingV4FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "WindowsRecordingV4ProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Expected an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !(key in value))) {
    throw new WindowsRecordingV4ProtocolError(
      "helper_protocol_mismatch",
      `Invalid ${label} fields`,
    );
  }
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", `Invalid ${label}`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", `Invalid ${label}`);
  }
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", `Invalid ${label}`);
  }
  return value;
}

function failureCodes(value: unknown): RecordingV4FailureCode[] {
  if (!Array.isArray(value) || !value.every((code) => FAILURE_CODES.has(code as RecordingV4FailureCode))) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid failure codes");
  }
  return value as RecordingV4FailureCode[];
}

function audioRoles(value: unknown): RecordingV4AudioRole[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
      !value.every((role) => role === "microphone" || role === "system")) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid audio roles");
  }
  return value as RecordingV4AudioRole[];
}

function parseEnvelope(value: unknown): RecordingV4EncoderEnvelope {
  const envelope = record(value);
  exactKeys(envelope, ["source", "encoder_id", "minimum_bitrate_bps", "target_bitrate_bps",
    "maximum_bitrate_bps", "safety_headroom_ratio"], "encoder envelope");
  if (envelope.source !== "live_calibration" && envelope.source !== "certified_evidence") {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid envelope source");
  }
  const result: RecordingV4EncoderEnvelope = {
    source: envelope.source,
    encoder_id: stringValue(envelope.encoder_id, "encoder id"),
    minimum_bitrate_bps: positiveInteger(envelope.minimum_bitrate_bps, "minimum bitrate"),
    target_bitrate_bps: positiveInteger(envelope.target_bitrate_bps, "target bitrate"),
    maximum_bitrate_bps: positiveInteger(envelope.maximum_bitrate_bps, "maximum bitrate"),
    safety_headroom_ratio: Number(envelope.safety_headroom_ratio),
  };
  if (result.minimum_bitrate_bps > result.target_bitrate_bps ||
      result.target_bitrate_bps > result.maximum_bitrate_bps ||
      !Number.isFinite(result.safety_headroom_ratio) || result.safety_headroom_ratio <= 0 ||
      result.safety_headroom_ratio >= 1) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid encoder envelope");
  }
  return result;
}

function parseEncoder(value: unknown): RecordingV4EncoderEvidence {
  const encoder = record(value);
  exactKeys(encoder, ["encoder_id", "hardware_accelerated", "requested_bitrate_bps",
    "average_bitrate_bps", "peak_bitrate_bps", "envelope"], "encoder evidence");
  const envelope = parseEnvelope(encoder.envelope);
  const result: RecordingV4EncoderEvidence = {
    encoder_id: stringValue(encoder.encoder_id, "encoder id"),
    hardware_accelerated: true,
    requested_bitrate_bps: positiveInteger(encoder.requested_bitrate_bps, "requested bitrate"),
    average_bitrate_bps: positiveInteger(encoder.average_bitrate_bps, "average bitrate"),
    peak_bitrate_bps: positiveInteger(encoder.peak_bitrate_bps, "peak bitrate"),
    envelope,
  };
  if (encoder.hardware_accelerated !== true || result.encoder_id !== envelope.encoder_id ||
      result.requested_bitrate_bps !== envelope.target_bitrate_bps ||
      result.average_bitrate_bps < envelope.minimum_bitrate_bps ||
      result.average_bitrate_bps > envelope.maximum_bitrate_bps ||
      result.peak_bitrate_bps < result.average_bitrate_bps ||
      result.peak_bitrate_bps > envelope.maximum_bitrate_bps) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Encoder evidence is invalid");
  }
  return result;
}

function parseCadence(value: unknown): RecordingV4CadenceEvidence {
  const cadence = record(value);
  exactKeys(cadence, ["version", "frame_rate", "active_duration_us", "expected_output_frames",
    "output_frames", "source_updates", "held_frames", "submitted_frames", "acknowledged_frames",
    "ring_high_water_mark", "pause_intervals", "ledger", "verdict", "failure_codes"], "cadence evidence");
  const frameRate = record(cadence.frame_rate);
  exactKeys(frameRate, ["numerator", "denominator"], "frame rate");
  const outputFrames = nonNegativeInteger(cadence.output_frames, "output frames");
  const activeDurationUs = nonNegativeInteger(cadence.active_duration_us, "active duration");
  const ledger = Array.isArray(cadence.ledger) ? cadence.ledger.map((raw, slot) => {
    const entry = record(raw);
    exactKeys(entry, ["slot", "pts_us", "source_sequence", "source_timestamp_us", "held_from_slot",
      "submitted_at_us", "acknowledged_at_us"], "frame ledger entry");
    const submitted = nonNegativeInteger(entry.submitted_at_us, "submitted time");
    const acknowledged = nonNegativeInteger(entry.acknowledged_at_us, "acknowledged time");
    const held = entry.held_from_slot === null ? null : nonNegativeInteger(entry.held_from_slot, "held slot");
    if (entry.slot !== slot || entry.pts_us !== Math.round((slot * 1_000_000) / 60) ||
        acknowledged < submitted || (held !== null && held >= slot)) {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid frame ledger ordering");
    }
    return {
      slot,
      pts_us: entry.pts_us,
      source_sequence: nonNegativeInteger(entry.source_sequence, "source sequence"),
      source_timestamp_us: nonNegativeInteger(entry.source_timestamp_us, "source timestamp"),
      held_from_slot: held,
      submitted_at_us: submitted,
      acknowledged_at_us: acknowledged,
    };
  }) : null;
  if (!ledger || cadence.version !== 4 || frameRate.numerator !== 60 || frameRate.denominator !== 1 ||
      ledger.length !== outputFrames || cadence.expected_output_frames !== outputFrames ||
      outputFrames !== Math.round((activeDurationUs * 60) / 1_000_000) ||
      cadence.submitted_frames !== outputFrames || cadence.acknowledged_frames !== outputFrames ||
      (cadence.verdict !== "passed" && cadence.verdict !== "failed") || !Array.isArray(cadence.pause_intervals)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid cadence evidence");
  }
  const cadenceFailures = failureCodes(cadence.failure_codes);
  const heldFrames = nonNegativeInteger(cadence.held_frames, "held frames");
  if (heldFrames !== ledger.filter((entry) => entry.held_from_slot !== null).length) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Held-frame count contradicts ledger");
  }
  if ((cadence.verdict === "passed") !== (cadenceFailures.length === 0)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Cadence verdict contradicts failure codes");
  }
  return {
    version: 4,
    frame_rate: { numerator: 60, denominator: 1 },
    active_duration_us: activeDurationUs,
    expected_output_frames: outputFrames,
    output_frames: outputFrames,
    source_updates: nonNegativeInteger(cadence.source_updates, "source updates"),
    held_frames: heldFrames,
    submitted_frames: outputFrames,
    acknowledged_frames: outputFrames,
    ring_high_water_mark: nonNegativeInteger(cadence.ring_high_water_mark, "ring high water mark"),
    pause_intervals: cadence.pause_intervals.map((raw) => {
      const interval = record(raw);
      exactKeys(interval, ["started_monotonic_us", "ended_monotonic_us"], "pause interval");
      const started = nonNegativeInteger(interval.started_monotonic_us, "pause start");
      const ended = nonNegativeInteger(interval.ended_monotonic_us, "pause end");
      if (ended < started) throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid pause interval");
      return { started_monotonic_us: started, ended_monotonic_us: ended };
    }),
    ledger,
    verdict: cadence.verdict,
    failure_codes: cadenceFailures,
  };
}

function parseAudio(value: unknown): RecordingV4AudioEvidence {
  const audio = record(value);
  exactKeys(audio, ["role", "requested", "status", "codec", "sample_rate_hz", "channels",
    "started_offset_us", "duration_us", "end_drift_us", "sync_tolerance_us", "pause_mapping_valid", "continuity_gaps",
    "ledger", "failure_codes"], "audio evidence");
  if ((audio.role !== "microphone" && audio.role !== "system") || audio.requested !== true ||
      (audio.status !== "captured" && audio.status !== "failed") ||
      (audio.codec !== "pcm_f32le" && audio.codec !== "pcm_s16le") ||
      typeof audio.pause_mapping_valid !== "boolean" || !Array.isArray(audio.ledger)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid audio evidence");
  }
  const ledger = audio.ledger.map((raw, sequence) => {
    const entry = record(raw);
    exactKeys(entry, ["sequence", "pts_us", "duration_us", "frames"], "audio ledger entry");
    if (entry.sequence !== sequence) {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid audio ledger sequence");
    }
    return {
      sequence,
      pts_us: nonNegativeInteger(entry.pts_us, "audio pts"),
      duration_us: positiveInteger(entry.duration_us, "audio duration"),
      frames: positiveInteger(entry.frames, "audio frames"),
    };
  });
  const result: RecordingV4AudioEvidence = {
    role: audio.role,
    requested: true,
    status: audio.status,
    codec: audio.codec,
    sample_rate_hz: positiveInteger(audio.sample_rate_hz, "audio sample rate"),
    channels: positiveInteger(audio.channels, "audio channels"),
    started_offset_us: Number(audio.started_offset_us),
    duration_us: nonNegativeInteger(audio.duration_us, "audio duration"),
    end_drift_us: Number(audio.end_drift_us),
    sync_tolerance_us: nonNegativeInteger(audio.sync_tolerance_us, "audio sync tolerance"),
    pause_mapping_valid: audio.pause_mapping_valid,
    continuity_gaps: nonNegativeInteger(audio.continuity_gaps, "audio continuity gaps"),
    ledger,
    failure_codes: failureCodes(audio.failure_codes),
  };
  if (!Number.isSafeInteger(result.started_offset_us) || !Number.isSafeInteger(result.end_drift_us)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid audio clock offsets");
  }
  if (result.status === "captured" && (result.continuity_gaps !== 0 || !result.pause_mapping_valid ||
      Math.abs(result.started_offset_us) > result.sync_tolerance_us ||
      Math.abs(result.end_drift_us) > result.sync_tolerance_us || result.failure_codes.length !== 0)) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Captured audio evidence failed continuity or sync");
  }
  if (result.status === "failed" && result.failure_codes.length === 0) {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Failed audio evidence requires a failure code");
  }
  return result;
}

export function parseWindowsRecordingV4Event(line: string): WindowsRecordingV4Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Helper emitted invalid JSON");
  }
  const event = record(parsed);
  if (event.version !== 4 || typeof event.type !== "string") {
    throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Helper protocol version mismatch");
  }
  if (event.type === "hello") {
    exactKeys(event, ["version", "type", "backend_id", "backend_version", "process_id"], "hello event");
    return { version: 4, type: "hello", backend_id: stringValue(event.backend_id, "backend id"),
      backend_version: stringValue(event.backend_version, "backend version"),
      process_id: positiveInteger(event.process_id, "process id") };
  }
  if (event.type === "capabilities") {
    exactKeys(event, ["version", "type", "capabilities"], "capabilities event");
    const value = record(event.capabilities);
    exactKeys(value, ["backend_id", "backend_version", "platform", "arch", "codec", "pixel_format",
      "exact_fps", "physical_width", "physical_height", "hardware_accelerated", "keeps_surfaces_native",
      "supports_pause_resume", "supports_microphone", "supports_system_audio", "encoder_id"], "capabilities");
    const fps = record(value.exact_fps);
    exactKeys(fps, ["numerator", "denominator"], "capability frame rate");
    if (value.backend_id !== WINDOWS_RECORDING_V4_BACKEND_ID || value.platform !== "win32" ||
        (value.arch !== "x64" && value.arch !== "arm64") || value.codec !== "h264" ||
        value.pixel_format !== "nv12" || fps.numerator !== 60 || fps.denominator !== 1 ||
        value.physical_width !== 1920 || value.physical_height !== 1080 ||
        value.hardware_accelerated !== true || value.keeps_surfaces_native !== true ||
        value.supports_pause_resume !== true || typeof value.supports_microphone !== "boolean" ||
        typeof value.supports_system_audio !== "boolean") {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid V4 capabilities");
    }
    return { version: 4, type: "capabilities", capabilities: value as unknown as WindowsRecordingV4Capabilities };
  }
  if (event.type === "warmup-result") {
    exactKeys(event, ["version", "type", "session_id", "passed", "encoder", "available_audio_roles",
      "failure_codes"], "warmup event");
    if (typeof event.passed !== "boolean") {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid warmup verdict");
    }
    const failures = failureCodes(event.failure_codes);
    const encoder = event.encoder === null ? null : parseEncoder(event.encoder);
    if ((event.passed && (failures.length !== 0 || encoder === null)) || (!event.passed && failures.length === 0)) {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Warmup verdict contradicts evidence");
    }
    return { version: 4, type: "warmup-result", session_id: stringValue(event.session_id, "session id"),
      passed: event.passed, encoder, available_audio_roles: audioRoles(event.available_audio_roles),
      failure_codes: failures };
  }
  if (["started", "paused", "resumed", "cancelled"].includes(event.type)) {
    exactKeys(event, ["version", "type", "session_id"], "lifecycle event");
    return { version: 4, type: event.type as "started" | "paused" | "resumed" | "cancelled",
      session_id: stringValue(event.session_id, "session id") };
  }
  if (event.type === "finalized") {
    exactKeys(event, ["version", "type", "session_id", "evidence"], "finalized event");
    const evidence = record(event.evidence);
    exactKeys(evidence, ["artifact_path", "encoder", "cadence", "audio", "finalized", "failure_codes"],
      "final evidence");
    if (evidence.finalized !== true || !Array.isArray(evidence.audio)) {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid terminal evidence");
    }
    return { version: 4, type: "finalized", session_id: stringValue(event.session_id, "session id"),
      evidence: { artifact_path: stringValue(evidence.artifact_path, "artifact path"),
        encoder: parseEncoder(evidence.encoder), cadence: parseCadence(evidence.cadence),
        audio: evidence.audio.map(parseAudio), finalized: true, failure_codes: failureCodes(evidence.failure_codes) } };
  }
  if (event.type === "failure") {
    exactKeys(event, ["version", "type", "session_id", "failure_code", "message"], "failure event");
    const codes = failureCodes([event.failure_code]);
    if (event.session_id !== null && typeof event.session_id !== "string") {
      throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Invalid failure session id");
    }
    return { version: 4, type: "failure", session_id: event.session_id as string | null,
      failure_code: codes[0] as RecordingV4FailureCode, message: stringValue(event.message, "failure message") };
  }
  throw new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Unknown helper event");
}

export function encodeWindowsRecordingV4Command(command: WindowsRecordingV4Command): string {
  if (command.version !== WINDOWS_RECORDING_V4_PROTOCOL_VERSION) {
    throw new WindowsRecordingV4ProtocolError("contract_mismatch", "V4 command version mismatch");
  }
  return `${JSON.stringify(command)}\n`;
}

export interface WindowsRecordingV4Transport {
  start(): Promise<void>;
  send(command: WindowsRecordingV4Command): Promise<void>;
  onEvent(listener: (event: WindowsRecordingV4Event) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  close(): Promise<void>;
}

export class SpawnedWindowsRecordingV4Helper implements WindowsRecordingV4Transport {
  private readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";

  constructor(private readonly executablePath: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.executablePath, ["--stdio-v4"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.events.emit("event", parseWindowsRecordingV4Event(line));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.events.emit("event", { version: 4, type: "failure", session_id: null,
          failure_code: "helper_protocol_mismatch", message } satisfies WindowsRecordingV4Event);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_192); });
    child.once("exit", (code, signal) => { this.child = null; this.events.emit("exit", code, signal); });
    child.once("error", (error) => {
      this.events.emit("event", { version: 4, type: "failure", session_id: null,
        failure_code: "helper_unavailable", message: `${error.message}${this.stderr ? `: ${this.stderr}` : ""}`
      } satisfies WindowsRecordingV4Event);
    });
    await new Promise<void>((resolve, reject) => {
      const onEvent = (event: WindowsRecordingV4Event) => {
        if (event.type === "failure") {
          cleanup();
          reject(new WindowsRecordingV4ProtocolError(event.failure_code, event.message));
        } else if (event.type === "hello") {
          cleanup();
          if (event.backend_id !== WINDOWS_RECORDING_V4_BACKEND_ID) {
            reject(new WindowsRecordingV4ProtocolError("helper_protocol_mismatch", "Unexpected V4 helper identity"));
          } else {
            resolve();
          }
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new WindowsRecordingV4ProtocolError("helper_unavailable", "V4 helper hello timed out"));
      }, 5_000);
      const cleanup = () => { clearTimeout(timeout); this.events.off("event", onEvent); };
      this.events.on("event", onEvent);
    });
  }

  async send(command: WindowsRecordingV4Command): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new WindowsRecordingV4ProtocolError("helper_unavailable", "Helper is not running");
    await new Promise<void>((resolve, reject) => child.stdin.write(encodeWindowsRecordingV4Command(command),
      (error) => error ? reject(error) : resolve()));
  }

  onEvent(listener: (event: WindowsRecordingV4Event) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
}

export function resolveWindowsRecordingV4HelperPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  arch: string;
}): string {
  if (input.arch !== "x64" && input.arch !== "arm64") {
    throw new WindowsRecordingV4ProtocolError("helper_unavailable", `Unsupported Windows architecture ${input.arch}`);
  }
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "windows", input.arch, "storycapture-wgc.exe")
    : path.join(input.appPath, "native", "windows-capture", "bin", input.arch, "storycapture-wgc.exe");
}

export class WindowsRecordingV4Backend {
  private readonly transport: WindowsRecordingV4Transport;
  private readonly removeFailureObserver: () => void;
  private readonly removeExitObserver: () => void;
  private currentSessionId: string | null = null;
  private started = false;
  private stickyFailure: WindowsRecordingV4ProtocolError | null = null;

  constructor(options: {
    transport?: WindowsRecordingV4Transport;
    helperPath?: string;
    platform?: NodeJS.Platform;
    onFailure?: (error: WindowsRecordingV4ProtocolError) => void;
  }) {
    if ((options.platform ?? process.platform) !== "win32") {
      throw new WindowsRecordingV4ProtocolError("helper_unavailable", "Windows V4 backend requires win32");
    }
    if (!options.transport && !options.helperPath) {
      throw new WindowsRecordingV4ProtocolError("helper_unavailable", "V4 helper path or transport is required");
    }
    this.transport = options.transport ?? new SpawnedWindowsRecordingV4Helper(options.helperPath as string);
    this.removeFailureObserver = this.transport.onEvent((event) => {
      if (event.type !== "failure") return;
      this.stickyFailure = new WindowsRecordingV4ProtocolError(event.failure_code, event.message);
      options.onFailure?.(this.stickyFailure);
    });
    this.removeExitObserver = this.transport.onExit(() => {
      this.stickyFailure = new WindowsRecordingV4ProtocolError("helper_crashed", "Windows V4 helper exited");
      options.onFailure?.(this.stickyFailure);
    });
  }

  async capabilities(): Promise<WindowsRecordingV4Capabilities> {
    await this.ensureStarted();
    const event = await this.request({ version: 4, type: "capabilities" }, (value) => value.type === "capabilities");
    return (event as Extract<WindowsRecordingV4Event, { type: "capabilities" }>).capabilities;
  }

  async warmup(options: WindowsRecordingV4StartOptions, durationMs = 1_000): Promise<Extract<WindowsRecordingV4Event, { type: "warmup-result" }>> {
    await this.ensureStarted();
    const event = await this.request({ version: 4, type: "warmup", duration_ms: durationMs, ...options },
      (value) => value.type === "warmup-result" && value.session_id === options.session_id, 15_000);
    return event as Extract<WindowsRecordingV4Event, { type: "warmup-result" }>;
  }

  async start(options: WindowsRecordingV4StartOptions): Promise<void> {
    if (this.currentSessionId) throw new WindowsRecordingV4ProtocolError("illegal_transition", "Session already active");
    await this.ensureStarted();
    this.stickyFailure = null;
    await this.request({ version: 4, type: "start", ...options },
      (event) => event.type === "started" && event.session_id === options.session_id, 15_000);
    this.currentSessionId = options.session_id;
  }

  async pause(): Promise<void> { await this.lifecycle("pause", "paused"); }
  async resume(): Promise<void> { await this.lifecycle("resume", "resumed"); }

  async stop(): Promise<WindowsRecordingV4FinalEvidence> {
    const sessionId = this.requireSession();
    const event = await this.request({ version: 4, type: "stop", session_id: sessionId },
      (value) => value.type === "finalized" && value.session_id === sessionId, 30_000);
    this.currentSessionId = null;
    return (event as Extract<WindowsRecordingV4Event, { type: "finalized" }>).evidence;
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireSession();
    await this.request({ version: 4, type: "cancel", session_id: sessionId },
      (event) => event.type === "cancelled" && event.session_id === sessionId);
    this.currentSessionId = null;
  }

  async close(): Promise<void> {
    this.removeFailureObserver();
    this.removeExitObserver();
    await this.transport.close();
    this.started = false;
    this.currentSessionId = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.transport.start();
    this.started = true;
  }

  private requireSession(): string {
    if (!this.currentSessionId) throw new WindowsRecordingV4ProtocolError("illegal_transition", "No active session");
    return this.currentSessionId;
  }

  private async lifecycle(command: "pause" | "resume", response: "paused" | "resumed"): Promise<void> {
    const sessionId = this.requireSession();
    await this.request({ version: 4, type: command, session_id: sessionId },
      (event) => event.type === response && event.session_id === sessionId);
  }

  private async request(
    command: WindowsRecordingV4Command,
    accepts: (event: WindowsRecordingV4Event) => boolean,
    timeoutMs = 10_000,
  ): Promise<WindowsRecordingV4Event> {
    if (this.stickyFailure) throw this.stickyFailure;
    return await new Promise<WindowsRecordingV4Event>((resolve, reject) => {
      let cleanup = () => {};
      const cleanupEvent = this.transport.onEvent((event) => {
        if (event.type === "failure" && (event.session_id === null || event.session_id === this.currentSessionId ||
            ("session_id" in command && event.session_id === command.session_id))) {
          cleanup();
          reject(new WindowsRecordingV4ProtocolError(event.failure_code, event.message));
        } else if (accepts(event)) {
          cleanup();
          resolve(event);
        }
      });
      const cleanupExit = this.transport.onExit(() => {
        cleanup();
        reject(new WindowsRecordingV4ProtocolError("helper_crashed", "Windows V4 helper exited"));
      });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new WindowsRecordingV4ProtocolError("verification_timeout", `Timed out waiting for ${command.type}`));
      }, timeoutMs);
      cleanup = () => { clearTimeout(timeout); cleanupEvent(); cleanupExit(); };
      void this.transport.send(command).catch((error) => { cleanup(); reject(error); });
    });
  }
}
