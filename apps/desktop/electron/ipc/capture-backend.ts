import { randomUUID } from "node:crypto";
import type { CaptureTarget } from "./legacy/shared";

export type CaptureBackendMode = "legacy" | "contract_shadow" | "contract_internal" | "contract_ga";
export type CaptureTargetClass = "browser_surface" | "external_window" | "display";
export type CaptureDeliveryMode = "host_frames" | "backend_segment";
export type CapturePixelFormat = "bgra" | "nv12" | "opaque_native";
export type CaptureTargetLostReason =
  | "window_closed"
  | "process_exited"
  | "display_removed"
  | "permission_revoked"
  | "source_unresolvable";
export type CaptureBackendFailureReason =
  | "backend_not_registered"
  | "capability_mismatch"
  | "target_not_found"
  | "target_ambiguous"
  | "target_invalid"
  | "pid_resolution_unsupported"
  | "probe_failed"
  | "delivery_invalid"
  | "delivery_after_terminal"
  | "session_mismatch";

export interface CaptureBackendCapabilities {
  contract_version: 1;
  backend_id: string;
  target_classes: CaptureTargetClass[];
  delivery_modes: CaptureDeliveryMode[];
  pixel_formats: CapturePixelFormat[];
  timestamp_source: "recording_media_clock" | "native_monotonic";
  cursor_control: "fixed_included" | "fixed_excluded" | "selectable";
  supports_pause: boolean;
  supports_dynamic_resize: boolean;
  native: boolean;
}

export interface CaptureBackendRequest {
  request_id: string;
  target: CaptureTarget;
  target_class: CaptureTargetClass;
  width: number;
  height: number;
  fps: number;
  include_cursor: boolean;
}

export interface CaptureBackendProbe {
  supported: boolean;
  reason: CaptureBackendFailureReason | null;
  delivery_mode: CaptureDeliveryMode | null;
  platform_version: string | null;
}

export interface CaptureBackendSession {
  backend_id: string;
  session_id: string;
  ownership_token: string;
}

interface CaptureDeliveryEnvelope {
  backend_id: string;
  session_id: string;
  sequence: number;
}

export interface CaptureFrameDelivery extends CaptureDeliveryEnvelope {
  type: "frame";
  frame_index: number;
  pts_us: number;
  duration_us: number | null;
  width: number;
  height: number;
  pixel_format: CapturePixelFormat;
  payload: Uint8Array | string;
}

export interface CaptureTargetLostDelivery extends CaptureDeliveryEnvelope {
  type: "targetLost";
  reason: CaptureTargetLostReason;
  observed_at_us: number;
  last_pts_us: number | null;
}

export interface CaptureFormatChangedDelivery extends CaptureDeliveryEnvelope {
  type: "formatChanged";
  pts_us: number;
  width: number;
  height: number;
  pixel_format: CapturePixelFormat;
}

export interface CaptureEncodedSegmentDelivery extends CaptureDeliveryEnvelope {
  type: "segment";
  relative_path: string;
  first_pts_us: number;
  last_pts_us: number;
  timestamp_map_relative_path: string;
}

export type CaptureBackendDelivery =
  | CaptureFrameDelivery
  | CaptureTargetLostDelivery
  | CaptureFormatChangedDelivery
  | CaptureEncodedSegmentDelivery;

export interface CaptureBackendSink {
  deliver(event: CaptureBackendDelivery): Promise<"accepted" | "backpressured">;
}

export interface CaptureBackendResult {
  backend_id: string;
  session_id: string;
  terminal_status: "stopped" | "aborted" | "target_lost" | "failed";
  target_loss_reason: CaptureTargetLostReason | null;
  last_pts_us: number | null;
}

export interface CaptureBackend {
  readonly id: string;
  capabilities(): CaptureBackendCapabilities;
  probe(request: CaptureBackendRequest): Promise<CaptureBackendProbe>;
  start(request: CaptureBackendRequest, sink: CaptureBackendSink): Promise<CaptureBackendSession>;
  pause(session: CaptureBackendSession): Promise<void>;
  resume(session: CaptureBackendSession): Promise<void>;
  stop(session: CaptureBackendSession): Promise<CaptureBackendResult>;
  abort(session: CaptureBackendSession, reason: string): Promise<void>;
}

export interface CaptureBackendProvenance {
  contract_version: 1;
  mode: CaptureBackendMode;
  selected_backend_id: string;
  attempted_backend_id: string | null;
  fallback_reason: CaptureBackendFailureReason | null;
  delivery_mode: CaptureDeliveryMode;
  timestamp_source: CaptureBackendCapabilities["timestamp_source"];
  resolved_target_identity: string;
  platform_version: string | null;
  target_loss_reason: CaptureTargetLostReason | null;
  terminal_status: "pending" | CaptureBackendResult["terminal_status"];
}

export interface CaptureSourceCandidate {
  source_id: string;
  native_window_id: string | number | null;
  display_id: string | number | null;
  owner_pid: number | null;
  title: string | null;
}

export class CaptureBackendContractError extends Error {
  readonly reason: CaptureBackendFailureReason;

  constructor(reason: CaptureBackendFailureReason, message: string) {
    super(message);
    this.name = "CaptureBackendContractError";
    this.reason = reason;
  }
}

const BACKEND_MODES = new Set<CaptureBackendMode>([
  "legacy",
  "contract_shadow",
  "contract_internal",
  "contract_ga",
]);

export function captureBackendMode(
  raw = process.env.STORYCAPTURE_CAPTURE_BACKEND_MODE,
): CaptureBackendMode {
  return BACKEND_MODES.has(raw as CaptureBackendMode) ? (raw as CaptureBackendMode) : "legacy";
}

export function targetClass(target: CaptureTarget): CaptureTargetClass {
  if (target.kind === "author_preview") return "browser_surface";
  if (target.kind === "window" || target.kind === "window_by_pid") return "external_window";
  return "display";
}

export function normalizeWindowTitle(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (!normalized || [...normalized].length > 512 || /\p{Cc}/u.test(normalized)) {
    throw new CaptureBackendContractError("target_invalid", "window title hint is invalid");
  }
  return normalized;
}

function safelyNormalizeWindowTitle(value: string): string | null {
  try {
    return normalizeWindowTitle(value);
  } catch {
    return null;
  }
}

function canonicalNativeId(value: string | number): string {
  const text = String(value).trim();
  if (!text) throw new CaptureBackendContractError("target_invalid", "native target id is empty");
  if (/^\d+$/u.test(text)) return BigInt(text).toString(10);
  return text;
}

function exactlyOne(candidates: CaptureSourceCandidate[]): CaptureSourceCandidate {
  if (candidates.length === 0) {
    throw new CaptureBackendContractError("target_not_found", "capture target not found");
  }
  if (candidates.length > 1) {
    throw new CaptureBackendContractError("target_ambiguous", "capture target is ambiguous");
  }
  return candidates[0];
}

export function resolveCaptureSource(
  target: Exclude<CaptureTarget, { kind: "author_preview" }>,
  candidates: readonly CaptureSourceCandidate[],
): CaptureSourceCandidate {
  if (target.kind === "display" || target.kind === "display_region") {
    const requested = canonicalNativeId(target.display_id);
    return exactlyOne(
      candidates.filter(
        (candidate) =>
          candidate.display_id != null && canonicalNativeId(candidate.display_id) === requested,
      ),
    );
  }
  if (target.kind === "window") {
    const requested = canonicalNativeId(target.window_id);
    if (requested === "0") {
      throw new CaptureBackendContractError("target_invalid", "native window id must be positive");
    }
    return exactlyOne(
      candidates.filter(
        (candidate) =>
          candidate.native_window_id != null &&
          canonicalNativeId(candidate.native_window_id) === requested,
      ),
    );
  }
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !target.title_hint) {
    throw new CaptureBackendContractError("target_invalid", "window_by_pid target is invalid");
  }
  const requestedTitle = normalizeWindowTitle(target.title_hint);
  if (!candidates.some((candidate) => candidate.owner_pid != null)) {
    throw new CaptureBackendContractError(
      "pid_resolution_unsupported",
      "capture sources do not expose owner PID metadata",
    );
  }
  return exactlyOne(
    candidates.filter(
      (candidate) =>
        candidate.owner_pid === target.pid &&
        candidate.title != null &&
        safelyNormalizeWindowTitle(candidate.title) === requestedTitle,
    ),
  );
}

export class CaptureBackendRegistry {
  readonly #backends = new Map<string, CaptureBackend>();

  register(backend: CaptureBackend): void {
    const capabilities = backend.capabilities();
    if (capabilities.contract_version !== 1 || capabilities.backend_id !== backend.id) {
      throw new CaptureBackendContractError("capability_mismatch", "backend identity mismatch");
    }
    if (capabilities.native && capabilities.target_classes.includes("browser_surface")) {
      throw new CaptureBackendContractError(
        "capability_mismatch",
        "native capture backend cannot advertise browser_surface",
      );
    }
    if (capabilities.delivery_modes.length === 0 || capabilities.delivery_modes.length > 2) {
      throw new CaptureBackendContractError("capability_mismatch", "delivery mode invalid");
    }
    if (this.#backends.has(backend.id)) {
      throw new CaptureBackendContractError("capability_mismatch", "backend already registered");
    }
    this.#backends.set(backend.id, backend);
  }

  require(id: string): CaptureBackend {
    const backend = this.#backends.get(id);
    if (!backend) {
      throw new CaptureBackendContractError(
        "backend_not_registered",
        `backend ${id} not registered`,
      );
    }
    return backend;
  }
}

export function backendIdForTarget(
  target: CaptureTarget,
): "electron_author_preview" | "electron_external" {
  return target.kind === "author_preview" ? "electron_author_preview" : "electron_external";
}

export async function resolveCaptureBackend(input: {
  registry: CaptureBackendRegistry;
  request: CaptureBackendRequest;
  mode?: CaptureBackendMode;
  preferredNativeBackendId?: string | null;
}): Promise<{
  backend: CaptureBackend;
  probe: CaptureBackendProbe;
  provenance: CaptureBackendProvenance;
}> {
  const mode = input.mode ?? captureBackendMode();
  const electronId = backendIdForTarget(input.request.target);
  const preferred =
    input.request.target.kind === "author_preview" || mode === "legacy"
      ? electronId
      : input.preferredNativeBackendId || electronId;
  let attemptedBackendId: string | null = null;
  let fallbackReason: CaptureBackendFailureReason | null = null;
  let backend: CaptureBackend;
  let probe: CaptureBackendProbe;
  try {
    backend = input.registry.require(preferred);
    probe = await backend.probe(input.request);
  } catch (error) {
    if (preferred === electronId) throw error;
    attemptedBackendId = preferred;
    fallbackReason = error instanceof CaptureBackendContractError ? error.reason : "probe_failed";
    backend = input.registry.require(electronId);
    probe = await backend.probe(input.request);
  }
  if (!probe.supported && preferred !== electronId) {
    attemptedBackendId ??= preferred;
    fallbackReason ??= probe.reason ?? "probe_failed";
    backend = input.registry.require(electronId);
    probe = await backend.probe(input.request);
  }
  if (!probe.supported || !probe.delivery_mode) {
    throw new CaptureBackendContractError(
      probe.reason ?? "probe_failed",
      "capture backend probe failed",
    );
  }
  const capabilities = backend.capabilities();
  return {
    backend,
    probe,
    provenance: {
      contract_version: 1,
      mode,
      selected_backend_id: backend.id,
      attempted_backend_id: attemptedBackendId,
      fallback_reason: fallbackReason,
      delivery_mode: probe.delivery_mode,
      timestamp_source: capabilities.timestamp_source,
      resolved_target_identity: captureTargetIdentity(input.request.target),
      platform_version: probe.platform_version,
      target_loss_reason: null,
      terminal_status: "pending",
    },
  };
}

export function captureTargetIdentity(target: CaptureTarget): string {
  if (target.kind === "author_preview") return `author_preview:${target.stream_id}`;
  if (target.kind === "window") return `window:${canonicalNativeId(target.window_id)}`;
  if (target.kind === "window_by_pid") {
    return `window_by_pid:${target.pid}:${normalizeWindowTitle(target.title_hint ?? "")}`;
  }
  if (target.kind === "display_region") {
    return `display_region:${canonicalNativeId(target.display_id)}:${target.rect.x},${target.rect.y},${target.rect.w},${target.rect.h}`;
  }
  return `display:${canonicalNativeId(target.display_id)}`;
}

export function createCaptureBackendRequest(input: {
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  includeCursor: boolean;
}): CaptureBackendRequest {
  return {
    request_id: randomUUID(),
    target: input.target,
    target_class: targetClass(input.target),
    width: input.width,
    height: input.height,
    fps: input.fps,
    include_cursor: input.includeCursor,
  };
}

export class CaptureBackendDeliveryGuard implements CaptureBackendSink {
  readonly #delegate: CaptureBackendSink;
  readonly #session: CaptureBackendSession;
  #nextSequence = 0;
  #nextFrameIndex = 0;
  #lastPtsUs: number | null = null;
  #terminal = false;

  constructor(session: CaptureBackendSession, delegate: CaptureBackendSink) {
    this.#session = session;
    this.#delegate = delegate;
  }

  async deliver(event: CaptureBackendDelivery): Promise<"accepted" | "backpressured"> {
    if (this.#terminal) {
      throw new CaptureBackendContractError(
        "delivery_after_terminal",
        "delivery after target loss",
      );
    }
    if (
      event.backend_id !== this.#session.backend_id ||
      event.session_id !== this.#session.session_id
    ) {
      throw new CaptureBackendContractError(
        "session_mismatch",
        "capture delivery session mismatch",
      );
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== this.#nextSequence) {
      throw new CaptureBackendContractError(
        "delivery_invalid",
        "capture delivery sequence invalid",
      );
    }
    let nextFrameIndex = this.#nextFrameIndex;
    let lastPtsUs = this.#lastPtsUs;
    let terminal = false;
    if (event.type === "frame") {
      if (
        !Number.isSafeInteger(event.frame_index) ||
        event.frame_index !== this.#nextFrameIndex ||
        !Number.isSafeInteger(event.pts_us) ||
        event.pts_us < 0 ||
        (this.#lastPtsUs != null && event.pts_us <= this.#lastPtsUs)
      ) {
        throw new CaptureBackendContractError("delivery_invalid", "frame index or PTS invalid");
      }
      nextFrameIndex += 1;
      lastPtsUs = event.pts_us;
    } else if (event.type === "targetLost") {
      if (event.last_pts_us !== this.#lastPtsUs) {
        throw new CaptureBackendContractError("delivery_invalid", "target loss last PTS mismatch");
      }
      terminal = true;
    } else {
      const firstPts = event.type === "segment" ? event.first_pts_us : event.pts_us;
      const lastPts = event.type === "segment" ? event.last_pts_us : event.pts_us;
      if (
        !Number.isSafeInteger(firstPts) ||
        !Number.isSafeInteger(lastPts) ||
        firstPts < 0 ||
        lastPts < firstPts ||
        (this.#lastPtsUs != null && firstPts <= this.#lastPtsUs)
      ) {
        throw new CaptureBackendContractError("delivery_invalid", "capture delivery PTS invalid");
      }
      lastPtsUs = lastPts;
    }
    const disposition = await this.#delegate.deliver(event);
    if (disposition === "backpressured") return disposition;
    this.#nextSequence += 1;
    this.#nextFrameIndex = nextFrameIndex;
    this.#lastPtsUs = lastPtsUs;
    this.#terminal = terminal;
    return disposition;
  }
}
