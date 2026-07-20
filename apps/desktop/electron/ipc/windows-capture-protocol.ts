import type {
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
} from "@storycapture/shared-types/recording-v2";

export const WINDOWS_CAPTURE_PROTOCOL_VERSION = 2 as const;
export const WINDOWS_CAPTURE_BACKEND_ID = "windows-graphics-capture" as const;
export const WINDOWS_CAPTURE_BACKEND_VERSION = "1.0.0" as const;
export const WINDOWS_CAPTURE_RING_CAPACITY = 8 as const;

const WINDOWS_HELPER_FAILURE_CODES = new Set<RecordingQualityFailureCode>([
  "source_rate_mismatch",
  "source_sequence_missing",
  "source_sequence_gap",
  "source_stale_reuse",
  "submitted_frame_dropped",
  "frame_ring_overflow",
  "preflight_failed",
  "backend_unavailable",
  "backend_capability_mismatch",
  "permission_denied",
  "target_missing",
  "target_ambiguous",
  "target_changed",
  "target_lost",
  "artifact_pts_gap",
  "artifact_pts_duplicate",
  "verification_timeout",
  "contract_mismatch",
]);

export type WindowsCaptureTarget =
  | {
      kind: "display";
      device_path: string;
    }
  | {
      kind: "window";
      hwnd: string;
      process_id: number;
      executable_path: string;
      class_name: string;
    };

export interface WindowsCaptureSessionOptions {
  ownership_token: string;
  target: WindowsCaptureTarget;
  cursor_policy: "include" | "exclude";
  dynamic_size_policy: "fail";
  audio_roles: Array<"microphone" | "system">;
  requested_width: number;
  requested_height: number;
}

export type WindowsCaptureHelperCommand =
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "probe";
      request: RecordingPreflightV2Request;
      options: WindowsCaptureSessionOptions;
      duration_ms: number;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "start";
      session_id: string;
      request: RecordingPreflightV2Request;
      options: WindowsCaptureSessionOptions;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "pause" | "resume" | "stop" | "shutdown";
      session_id: string | null;
    };

export interface WindowsCaptureRingDescriptor {
  mapping_name: string;
  frame_event_name: string;
  ownership_token: string;
  capacity: typeof WINDOWS_CAPTURE_RING_CAPACITY;
  width: number;
  height: number;
  stride: number;
  pixel_format: "bgra";
}

export interface WindowsCaptureFrameCommit {
  delivery_sequence: number;
  source_frame_index: number;
  native_pts_us: number;
  duration_us: number;
  slot_index: number;
  width: number;
  height: number;
  stride: number;
  pixel_format: "bgra";
  ownership_token: string;
}

export interface WindowsCaptureProbeResult {
  backend_id: typeof WINDOWS_CAPTURE_BACKEND_ID;
  backend_version: typeof WINDOWS_CAPTURE_BACKEND_VERSION;
  gpu_identity: string | null;
  hardware_fingerprint: string;
  adapter_luid: string | null;
  permissions_granted: boolean;
  source_presentations: number;
  probe_duration_ms: number;
  measured_fps_numerator: number | null;
  measured_fps_denominator: number | null;
  sequence_gaps: number;
  stale_reuses: number;
  physical_width: number;
  physical_height: number;
  failure_codes: RecordingQualityFailureCode[];
}

export type WindowsCaptureHelperEvent =
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "hello";
      backend_id: typeof WINDOWS_CAPTURE_BACKEND_ID;
      backend_version: typeof WINDOWS_CAPTURE_BACKEND_VERSION;
      process_id: number;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "probe-result";
      result: WindowsCaptureProbeResult;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "ready";
      session_id: string;
      ring: WindowsCaptureRingDescriptor;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "clock-anchor";
      session_id: string;
      qpc_timestamp_us: number;
      audio_sample_rate: 48_000;
    }
  | ({
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "frame-committed";
      session_id: string;
    } & WindowsCaptureFrameCommit)
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "paused" | "resumed" | "stopped";
      session_id: string;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "format-changed";
      session_id: string;
      width: number;
      height: number;
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "target-lost";
      session_id: string;
      failure_code: "target_lost" | "target_changed";
    }
  | {
      version: typeof WINDOWS_CAPTURE_PROTOCOL_VERSION;
      type: "failure";
      session_id: string | null;
      failure_code: RecordingQualityFailureCode;
      message: string;
    };

export interface WindowsNativeFrameSink {
  open(descriptor: WindowsCaptureRingDescriptor): Promise<void>;
  commit(frame: WindowsCaptureFrameCommit): Promise<void>;
  close(): Promise<void>;
}

export interface WindowsCaptureHelperTransport {
  start(): Promise<void>;
  send(command: WindowsCaptureHelperCommand): Promise<void>;
  onEvent(listener: (event: WindowsCaptureHelperEvent) => void): () => void;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): () => void;
  close(): Promise<void>;
}

export class WindowsCaptureProtocolError extends Error {
  constructor(
    readonly failureCode: RecordingQualityFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "WindowsCaptureProtocolError";
  }
}

export function encodeWindowsCaptureCommand(command: WindowsCaptureHelperCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export function validateWindowsCaptureTarget(target: WindowsCaptureTarget): void {
  if (target.kind === "display") {
    if (!target.device_path.trim()) {
      throw new WindowsCaptureProtocolError("target_missing", "display device path is required");
    }
    return;
  }
  if (!/^0x[0-9a-f]+$/i.test(target.hwnd)) {
    throw new WindowsCaptureProtocolError(
      "target_missing",
      "window HWND must be canonical hexadecimal",
    );
  }
  if (!Number.isSafeInteger(target.process_id) || target.process_id <= 0) {
    throw new WindowsCaptureProtocolError("target_missing", "window process ID must be positive");
  }
  if (!target.executable_path.trim() || !target.class_name.trim()) {
    throw new WindowsCaptureProtocolError(
      "target_missing",
      "window executable path and class name are required",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRing(value: unknown): WindowsCaptureRingDescriptor {
  if (
    !isRecord(value) ||
    typeof value.mapping_name !== "string" ||
    typeof value.frame_event_name !== "string" ||
    typeof value.ownership_token !== "string" ||
    value.capacity !== WINDOWS_CAPTURE_RING_CAPACITY ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    !isPositiveInteger(value.stride) ||
    value.stride !== value.width * 4 ||
    value.pixel_format !== "bgra"
  ) {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "invalid native frame-ring descriptor",
    );
  }
  return value as unknown as WindowsCaptureRingDescriptor;
}

function parseFrame(value: Record<string, unknown>): WindowsCaptureFrameCommit {
  if (["pixels", "bytes", "bitmap", "data"].some((key) => key in value)) {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "frame pixels cannot cross the JSON helper protocol",
    );
  }
  if (
    !isPositiveInteger(value.delivery_sequence) ||
    !isPositiveInteger(value.source_frame_index) ||
    !isNonNegativeInteger(value.native_pts_us) ||
    !isPositiveInteger(value.duration_us) ||
    !isNonNegativeInteger(value.slot_index) ||
    value.slot_index >= WINDOWS_CAPTURE_RING_CAPACITY ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    !isPositiveInteger(value.stride) ||
    value.stride !== value.width * 4 ||
    value.pixel_format !== "bgra" ||
    typeof value.ownership_token !== "string" ||
    !value.ownership_token
  ) {
    throw new WindowsCaptureProtocolError("contract_mismatch", "invalid committed-frame envelope");
  }
  return value as unknown as WindowsCaptureFrameCommit;
}

function parseProbeResult(value: unknown): WindowsCaptureProbeResult {
  if (
    !isRecord(value) ||
    value.backend_id !== WINDOWS_CAPTURE_BACKEND_ID ||
    value.backend_version !== WINDOWS_CAPTURE_BACKEND_VERSION ||
    (value.gpu_identity !== null && typeof value.gpu_identity !== "string") ||
    typeof value.hardware_fingerprint !== "string" ||
    (value.adapter_luid !== null && typeof value.adapter_luid !== "string") ||
    typeof value.permissions_granted !== "boolean" ||
    !isNonNegativeInteger(value.source_presentations) ||
    !isPositiveInteger(value.probe_duration_ms) ||
    !isNonNegativeInteger(value.sequence_gaps) ||
    !isNonNegativeInteger(value.stale_reuses) ||
    !isPositiveInteger(value.physical_width) ||
    !isPositiveInteger(value.physical_height) ||
    !Array.isArray(value.failure_codes) ||
    !value.failure_codes.every(
      (code) =>
        typeof code === "string" &&
        WINDOWS_HELPER_FAILURE_CODES.has(code as RecordingQualityFailureCode),
    )
  ) {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "invalid Windows capture probe result",
    );
  }
  const numerator = value.measured_fps_numerator;
  const denominator = value.measured_fps_denominator;
  if (
    (numerator === null) !== (denominator === null) ||
    (numerator !== null && (!isPositiveInteger(numerator) || !isPositiveInteger(denominator)))
  ) {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "invalid measured source frame rate",
    );
  }
  return value as unknown as WindowsCaptureProbeResult;
}

export function parseWindowsCaptureEvent(line: string): WindowsCaptureHelperEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "native helper emitted invalid JSON",
    );
  }
  if (
    !isRecord(value) ||
    value.version !== WINDOWS_CAPTURE_PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    throw new WindowsCaptureProtocolError(
      "contract_mismatch",
      "native helper protocol version mismatch",
    );
  }
  switch (value.type) {
    case "hello":
      if (
        value.backend_id !== WINDOWS_CAPTURE_BACKEND_ID ||
        value.backend_version !== WINDOWS_CAPTURE_BACKEND_VERSION ||
        !isPositiveInteger(value.process_id)
      ) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "invalid helper identity");
      }
      return value as unknown as WindowsCaptureHelperEvent;
    case "probe-result":
      return { version: 2, type: "probe-result", result: parseProbeResult(value.result) };
    case "ready":
      if (typeof value.session_id !== "string" || !value.session_id) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "ready event has no session ID");
      }
      return {
        version: 2,
        type: "ready",
        session_id: value.session_id,
        ring: parseRing(value.ring),
      };
    case "clock-anchor":
      if (
        typeof value.session_id !== "string" ||
        !value.session_id ||
        !isNonNegativeInteger(value.qpc_timestamp_us) ||
        value.audio_sample_rate !== 48_000
      ) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "invalid native clock anchor");
      }
      return value as unknown as WindowsCaptureHelperEvent;
    case "frame-committed":
      if (typeof value.session_id !== "string" || !value.session_id) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "frame event has no session ID");
      }
      return {
        version: 2,
        type: "frame-committed",
        session_id: value.session_id,
        ...parseFrame(value),
      };
    case "paused":
    case "resumed":
    case "stopped":
      if (typeof value.session_id !== "string" || !value.session_id) {
        throw new WindowsCaptureProtocolError(
          "contract_mismatch",
          `${value.type} event has no session ID`,
        );
      }
      return value as unknown as WindowsCaptureHelperEvent;
    case "format-changed":
      if (
        typeof value.session_id !== "string" ||
        !value.session_id ||
        !isPositiveInteger(value.width) ||
        !isPositiveInteger(value.height)
      ) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "invalid format-change event");
      }
      return value as unknown as WindowsCaptureHelperEvent;
    case "target-lost":
      if (
        typeof value.session_id !== "string" ||
        !value.session_id ||
        (value.failure_code !== "target_lost" && value.failure_code !== "target_changed")
      ) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "invalid target-loss event");
      }
      return value as unknown as WindowsCaptureHelperEvent;
    case "failure":
      if (
        (value.session_id !== null && typeof value.session_id !== "string") ||
        typeof value.failure_code !== "string" ||
        !WINDOWS_HELPER_FAILURE_CODES.has(value.failure_code as RecordingQualityFailureCode) ||
        typeof value.message !== "string"
      ) {
        throw new WindowsCaptureProtocolError("contract_mismatch", "invalid helper failure event");
      }
      return value as unknown as WindowsCaptureHelperEvent;
    default:
      throw new WindowsCaptureProtocolError(
        "contract_mismatch",
        `unknown native helper event ${value.type}`,
      );
  }
}

export function windowsProbeToPreflight(
  request: RecordingPreflightV2Request,
  result: WindowsCaptureProbeResult,
  input: {
    arch: string;
    certificationMatch: boolean;
    encodeThroughputRatio: number;
    estimatedBytesPerSecond: number;
    requiredBytesForTenMinutes: number;
    availableBytes: number;
    reserveBytes: number;
  },
): RecordingPreflightV2Dto {
  const failureCodes = new Set(result.failure_codes);
  if (
    result.physical_width < request.dimensions.requested_output_width ||
    result.physical_height < request.dimensions.requested_output_height
  ) {
    failureCodes.add("backend_capability_mismatch");
  }
  if (!input.certificationMatch) failureCodes.add("uncertified_tier");
  if (input.encodeThroughputRatio < 1.5) failureCodes.add("preflight_failed");
  const strictEligible =
    request.delivery_policy === "strict" &&
    result.permissions_granted &&
    input.certificationMatch &&
    input.encodeThroughputRatio >= 1.5 &&
    result.measured_fps_numerator === 60 &&
    result.measured_fps_denominator === 1 &&
    result.sequence_gaps === 0 &&
    result.stale_reuses === 0 &&
    failureCodes.size === 0;
  return {
    version: 2,
    backend_id: WINDOWS_CAPTURE_BACKEND_ID,
    backend_version: WINDOWS_CAPTURE_BACKEND_VERSION,
    platform: "win32",
    arch: input.arch,
    gpu_identity: result.gpu_identity,
    hardware_fingerprint: result.hardware_fingerprint,
    certification: request.desired_tier,
    certification_match: input.certificationMatch,
    source_rate: {
      measured_fps:
        result.measured_fps_numerator === null || result.measured_fps_denominator === null
          ? null
          : {
              numerator: result.measured_fps_numerator,
              denominator: result.measured_fps_denominator,
            },
      source_presentations: result.source_presentations,
      sequence_gaps: result.sequence_gaps,
      stale_reuses: result.stale_reuses,
      probe_duration_ms: result.probe_duration_ms,
    },
    encode_throughput_ratio: input.encodeThroughputRatio,
    storage: {
      estimated_bytes_per_second: input.estimatedBytesPerSecond,
      required_bytes_for_ten_minutes: input.requiredBytesForTenMinutes,
      available_bytes: input.availableBytes,
      reserve_bytes: input.reserveBytes,
    },
    permissions_granted: result.permissions_granted,
    strict_eligible: strictEligible,
    failure_codes: [...failureCodes],
  };
}
