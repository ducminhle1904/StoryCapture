import { randomUUID } from "node:crypto";
import { recordEngineLog } from "./recording-observability";

export type RecordingRepairMode = "off" | "plan_only" | "manual_hybrid";
export type RecordingRepairPhase =
  | "pre_input"
  | "input_emitted_presentation_pending"
  | "post_input_failed";
export type RecordingRepairAction =
  | "retry_step"
  | "use_candidate_and_retry"
  | "await_presentation"
  | "retry_scene"
  | "abort_keep_salvage";

export interface RecordingRepairCandidate {
  key: string;
  source: string;
  fallback_index: number | null;
}

export interface RecordingRepairRequest {
  session_id: string;
  scene_id: string;
  step_id: string;
  ordinal: number;
  phase: RecordingRepairPhase;
  reason_code: string;
  candidates: readonly RecordingRepairCandidate[];
  scene_retry_available: boolean;
}

export interface RepairRequiredEvent {
  type: "repair-required";
  session_id: string;
  repair_token: string;
  scene_id: string;
  step_id: string;
  ordinal: number;
  phase: RecordingRepairPhase;
  reason_code: string;
  candidates: RecordingRepairCandidate[];
  attempt: number;
  allowed_actions: RecordingRepairAction[];
  expires_at_ms: number;
}

export interface ResolveRecordingRepairArgs {
  session_id: string;
  repair_token: string;
  action: RecordingRepairAction;
  candidate_key?: string;
}

export interface RecordingRepairResolution {
  action: RecordingRepairAction;
  candidate_key: string | null;
  reason: "user" | "expired" | "session_closed";
}

export class RecordingRepairError extends Error {
  readonly recordingReasonCode = "recording_repair_rejected";

  constructor(readonly reason: string) {
    super(`recording_repair_rejected:${reason}`);
    this.name = "RecordingRepairError";
  }
}

export function recordingRepairMode(): RecordingRepairMode {
  const value = process.env.STORYCAPTURE_RECORDING_REPAIR_MODE?.trim().toLowerCase();
  if (value === "plan_only" || value === "manual_hybrid") return value;
  return "off";
}

export function recordingRepairAllowedActions(input: {
  phase: RecordingRepairPhase;
  attempt: number;
  candidateCount: number;
  sceneRetryAvailable: boolean;
}): RecordingRepairAction[] {
  const actions: RecordingRepairAction[] = [];
  const withinStepLimit = input.attempt < 3;
  if (input.phase === "pre_input" && withinStepLimit) {
    actions.push("retry_step");
    if (input.candidateCount > 0) actions.push("use_candidate_and_retry");
  }
  if (input.phase === "input_emitted_presentation_pending" && withinStepLimit) {
    actions.push("await_presentation");
  }
  if (input.sceneRetryAvailable) actions.push("retry_scene");
  actions.push("abort_keep_salvage");
  return actions;
}

interface PendingRepair {
  request: RecordingRepairRequest;
  event: RepairRequiredEvent;
  resolve: (resolution: RecordingRepairResolution) => void;
  promise: Promise<RecordingRepairResolution>;
  timer: ReturnType<typeof setTimeout>;
}

export class RecordingRepairController {
  readonly #attempts = new Map<string, number>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  #pending: PendingRepair | null = null;
  #closed = false;

  constructor(
    readonly sessionId: string,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
  }

  get pendingEvent(): RepairRequiredEvent | null {
    return this.#pending?.event ?? null;
  }

  begin(request: RecordingRepairRequest): {
    event: RepairRequiredEvent;
    resolution: Promise<RecordingRepairResolution>;
  } {
    if (this.#closed) throw new RecordingRepairError("session_closed");
    if (request.session_id !== this.sessionId) throw new RecordingRepairError("wrong_session");
    if (this.#pending) throw new RecordingRepairError("repair_already_pending");
    const attempt = this.#attempts.get(request.step_id) ?? 0;
    const allowedActions = recordingRepairAllowedActions({
      phase: request.phase,
      attempt,
      candidateCount: request.candidates.length,
      sceneRetryAvailable: request.scene_retry_available,
    });
    const event: RepairRequiredEvent = {
      type: "repair-required",
      session_id: this.sessionId,
      repair_token: randomUUID(),
      scene_id: request.scene_id,
      step_id: request.step_id,
      ordinal: request.ordinal,
      phase: request.phase,
      reason_code: request.reason_code,
      candidates: request.candidates.map((candidate) => ({ ...candidate })),
      attempt,
      allowed_actions: allowedActions,
      expires_at_ms: this.#now() + this.#ttlMs,
    };
    let resolve!: (resolution: RecordingRepairResolution) => void;
    const promise = new Promise<RecordingRepairResolution>((settle) => {
      resolve = settle;
    });
    const timer = setTimeout(
      () => this.#settle("abort_keep_salvage", null, "expired"),
      this.#ttlMs,
    );
    timer.unref?.();
    this.#pending = { request, event, resolve, promise, timer };
    void recordEngineLog({
      level: "warn",
      event: "recording.repair.required",
      context: {
        session_id: this.sessionId,
        scene_id: request.scene_id,
        step_id: request.step_id,
        ordinal: request.ordinal,
        phase: request.phase,
        reason_code: request.reason_code,
      },
      details: {
        attempt,
        candidate_count: request.candidates.length,
        allowed_actions: allowedActions,
        ttl_ms: this.#ttlMs,
      },
    });
    return { event, resolution: promise };
  }

  resolve(args: ResolveRecordingRepairArgs): RecordingRepairResolution {
    const pending = this.#requiredPending();
    if (args.session_id !== this.sessionId) throw new RecordingRepairError("wrong_session");
    if (args.repair_token !== pending.event.repair_token) {
      throw new RecordingRepairError("stale_or_replayed_token");
    }
    if (this.#now() >= pending.event.expires_at_ms) {
      this.#settle("abort_keep_salvage", null, "expired");
      throw new RecordingRepairError("expired_token");
    }
    if (!pending.event.allowed_actions.includes(args.action)) {
      throw new RecordingRepairError("action_not_allowed");
    }
    let candidateKey: string | null = null;
    if (args.action === "use_candidate_and_retry") {
      candidateKey = args.candidate_key?.trim() || null;
      if (
        !candidateKey ||
        !pending.request.candidates.some((candidate) => candidate.key === candidateKey)
      ) {
        throw new RecordingRepairError("candidate_not_allowed");
      }
    } else if (args.candidate_key != null) {
      throw new RecordingRepairError("candidate_not_applicable");
    }
    if (
      args.action === "retry_step" ||
      args.action === "use_candidate_and_retry" ||
      args.action === "await_presentation"
    ) {
      this.#attempts.set(pending.request.step_id, pending.event.attempt + 1);
    }
    return this.#settle(args.action, candidateKey, "user");
  }

  invalidate(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pending) this.#settle("abort_keep_salvage", null, "session_closed");
  }

  expireForTest(): void {
    if (this.#pending) this.#settle("abort_keep_salvage", null, "expired");
  }

  #requiredPending(): PendingRepair {
    if (this.#closed) throw new RecordingRepairError("session_closed");
    if (!this.#pending) throw new RecordingRepairError("no_repair_pending");
    return this.#pending;
  }

  #settle(
    action: RecordingRepairAction,
    candidateKey: string | null,
    reason: RecordingRepairResolution["reason"],
  ): RecordingRepairResolution {
    const pending = this.#pending;
    if (!pending) throw new RecordingRepairError("no_repair_pending");
    clearTimeout(pending.timer);
    this.#pending = null;
    const resolution = {
      action,
      candidate_key: candidateKey,
      reason,
    } satisfies RecordingRepairResolution;
    const escalated = action === "retry_scene" || action === "abort_keep_salvage";
    void recordEngineLog({
      level: reason === "user" && !escalated ? "info" : "warn",
      event:
        reason === "expired"
          ? "recording.repair.expired"
          : escalated
            ? "recording.repair.escalated"
            : "recording.repair.resolved",
      context: {
        session_id: this.sessionId,
        scene_id: pending.request.scene_id,
        step_id: pending.request.step_id,
        ordinal: pending.request.ordinal,
        phase: pending.request.phase,
        reason_code: reason,
      },
      details: {
        action,
        candidate_selected: candidateKey !== null,
        attempt: pending.event.attempt,
      },
    });
    pending.resolve(resolution);
    return resolution;
  }
}

const controllers = new Map<string, RecordingRepairController>();

export function recordingRepairController(sessionId: string): RecordingRepairController {
  const current = controllers.get(sessionId);
  if (current) return current;
  const controller = new RecordingRepairController(sessionId);
  controllers.set(sessionId, controller);
  return controller;
}

export function recordingRepairControllerForSession(
  sessionId: string,
): RecordingRepairController | null {
  return controllers.get(sessionId) ?? null;
}

export function invalidateRecordingRepair(sessionId: string): void {
  const controller = controllers.get(sessionId);
  controllers.delete(sessionId);
  controller?.invalidate();
}
