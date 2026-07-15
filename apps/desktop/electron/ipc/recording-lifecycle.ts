import type { RecordingOutcomeV1, RecordingTerminalEventV1 } from "@storycapture/shared-types";
import { hostLog, type RecordingSession, recordingSessions, sendChannel } from "./legacy/shared";
import { recordEngineLog } from "./recording-observability";
import {
  classifyRecordingOutcome,
  recordingOutcomeMode,
  recordingTerminalEvent,
} from "./recording-outcome";
import { recordingReadiness } from "./recording-readiness";
import { recordingSessionJournal } from "./recording-session-journal";

export type RecordingLifecycleState =
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "finalized"
  | "cancelling"
  | "cancelled"
  | "failed";

export type StopIntent =
  | {
      kind: "complete";
      automation?: RecordingOutcomeV1["automation"];
    }
  | { kind: "cancel"; actor: "user" | "host" };

export interface RecordingLifecycleSnapshot {
  version: 1;
  session_id: string;
  state: RecordingLifecycleState;
  sequence: number;
  updated_at: string;
}

export interface RecordingTerminalResult {
  session_id: string;
  snapshot: RecordingLifecycleSnapshot;
  outcome: RecordingOutcomeV1;
  terminal_event: RecordingTerminalEventV1;
  outcome_mode: "legacy" | "shadow" | "strict";
  legacy_result: Record<string, unknown> | null;
  error_message: string | null;
}

export interface RecordingStatusResultV1 {
  version: 1;
  session_id: string;
  snapshot: RecordingLifecycleSnapshot;
  terminal_outcome: RecordingOutcomeV1 | null;
  terminal_event: RecordingTerminalEventV1 | null;
  outcome_mode: "legacy" | "shadow" | "strict";
  cached_until: string | null;
}

type Finalizer = (
  session: RecordingSession,
  intent: StopIntent,
) => Promise<Record<string, unknown>>;

interface ActiveLifecycle {
  session: RecordingSession;
  state: RecordingLifecycleState;
  sequence: number;
  updatedAt: number;
  queue: Promise<void>;
  terminalPromise: Promise<RecordingTerminalResult> | null;
  cancellationActor: "user" | "host" | null;
  candidateSealed: boolean;
  sealedIntent: StopIntent | null;
}

interface TerminalCacheEntry {
  result: RecordingTerminalResult;
  expiresAt: number;
}

interface ControllerOptions {
  now?: () => number;
  terminalTtlMs?: number;
  terminalMaxEntries?: number;
  sessions?: Map<string, RecordingSession>;
}

const LEGAL_TRANSITIONS: Record<RecordingLifecycleState, ReadonlySet<RecordingLifecycleState>> = {
  starting: new Set(["recording", "cancelling", "failed"]),
  recording: new Set(["paused", "stopping", "cancelling", "failed"]),
  paused: new Set(["recording", "stopping", "cancelling", "failed"]),
  stopping: new Set(["finalized", "cancelled", "failed"]),
  finalized: new Set(),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  failed: new Set(),
};

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function captureEvidence(result: Record<string, unknown> | null) {
  return {
    output_path: typeof result?.output_path === "string" ? result.output_path : null,
    frames_written: numericField(result?.frames_written),
    frames_dropped: numericField(result?.frames_dropped),
    cadence_warning: typeof result?.cadence_warning === "string" ? result.cadence_warning : null,
    finalized: result != null,
  };
}

function defaultAutomation(intent: StopIntent): RecordingOutcomeV1["automation"] {
  if (intent.kind === "complete" && intent.automation) return intent.automation;
  return {
    exit_reason: intent.kind === "cancel" ? "cancelled" : "completed",
    total_steps: 0,
    succeeded: 0,
    failed: 0,
    failed_ordinal: null,
  };
}

function isRecordingOutcome(value: unknown, sessionId: string): value is RecordingOutcomeV1 {
  const outcome = value as Partial<RecordingOutcomeV1> | null;
  return (
    outcome?.version === 1 &&
    outcome.session_id === sessionId &&
    ["passed", "repairable", "failed", "cancelled"].includes(String(outcome.verdict))
  );
}

export class RecordingLifecycleController {
  readonly #active = new Map<string, ActiveLifecycle>();
  readonly #terminal = new Map<string, TerminalCacheEntry>();
  readonly #now: () => number;
  readonly #terminalTtlMs: number;
  readonly #terminalMaxEntries: number;
  readonly #sessions: Map<string, RecordingSession>;

  constructor(options: ControllerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#terminalTtlMs = options.terminalTtlMs ?? 15 * 60 * 1000;
    this.#terminalMaxEntries = options.terminalMaxEntries ?? 128;
    this.#sessions = options.sessions ?? recordingSessions;
  }

  async register(session: RecordingSession): Promise<RecordingLifecycleSnapshot> {
    this.#purgeExpired();
    if (this.#active.has(session.id)) {
      throw new Error(`recording session ${session.id} already registered`);
    }
    this.#terminal.delete(session.id);
    const now = this.#now();
    const active: ActiveLifecycle = {
      session,
      state: "starting",
      sequence: 0,
      updatedAt: now,
      queue: Promise.resolve(),
      terminalPromise: null,
      cancellationActor: null,
      candidateSealed: false,
      sealedIntent: null,
    };
    this.#active.set(session.id, active);
    this.#sessions.set(session.id, session);
    const snapshot = this.#snapshot(active);
    const journal = recordingSessionJournal.traceContext(session.id);
    await recordEngineLog({
      event: "recording.session.created",
      context: {
        session_id: session.id,
        take_id: journal?.take_id,
        phase: "starting",
      },
      details: {
        lifecycle_sequence: snapshot.sequence,
        journal_id: journal?.journal_id,
        journal_checkpoint: journal?.checkpoint,
      },
    });
    return snapshot;
  }

  markRecording(id: string): Promise<RecordingLifecycleSnapshot> {
    return this.#enqueue(this.#required(id), async (active) => {
      this.#transition(active, "recording", "capture_started");
      return this.#snapshot(active);
    });
  }

  pause(id: string): Promise<RecordingLifecycleSnapshot> {
    return this.#enqueue(this.#required(id), async (active) => {
      if (active.state === "paused") return this.#snapshot(active);
      this.#transition(active, "paused", "pause_requested");
      active.session.paused = true;
      active.session.lifecycle = "paused";
      active.session.mediaClock.pause();
      active.session.pauseGate.pause();
      recordingReadiness.get(id)?.pause();
      return this.#snapshot(active);
    });
  }

  resume(id: string): Promise<RecordingLifecycleSnapshot> {
    return this.#enqueue(this.#required(id), async (active) => {
      if (active.state === "recording") return this.#snapshot(active);
      this.#transition(active, "recording", "resume_requested");
      active.session.paused = false;
      active.session.lifecycle = "recording";
      active.session.mediaClock.resume();
      active.session.pauseGate.resume();
      recordingReadiness.get(id)?.resume();
      return this.#snapshot(active);
    });
  }

  stop(id: string, intent: StopIntent, finalizer: Finalizer): Promise<RecordingTerminalResult> {
    this.#purgeExpired();
    const cached = this.#terminal.get(id);
    if (cached) return Promise.resolve(cached.result);
    const active = this.#required(id);
    if (intent.kind === "cancel" && !active.candidateSealed) {
      this.#latchCancellation(active, intent.actor);
    }
    if (active.terminalPromise) return active.terminalPromise;

    const terminalPromise = this.#enqueue(active, async (current) => {
      const cancelling = current.cancellationActor !== null || intent.kind === "cancel";
      this.#transition(
        current,
        cancelling ? "cancelling" : "stopping",
        cancelling
          ? `cancelled_by_${current.cancellationActor ?? (intent.kind === "cancel" ? intent.actor : "host")}`
          : "automation_complete",
      );
      current.session.lifecycle = "stopping";
      if (cancelling)
        this.#latchCancellation(
          current,
          current.cancellationActor ?? (intent.kind === "cancel" ? intent.actor : "host"),
        );

      let legacyResult: Record<string, unknown> | null = null;
      let finalizerError: unknown = null;
      try {
        legacyResult = await finalizer(current.session, intent);
      } catch (error) {
        finalizerError = error;
      }
      current.session.pauseGate.cancel();
      current.session.actionLandmarks.cancelAll();
      recordingReadiness.remove(id);

      const sealedIntent = this.#sealIntent(current, intent);
      const outcomeMode = recordingOutcomeMode();
      const providedOutcome =
        outcomeMode === "shadow"
          ? legacyResult?.shadow_terminal_outcome
          : legacyResult?.terminal_outcome;
      const providedOutcomeValid = isRecordingOutcome(providedOutcome, id);
      const providedOutcomeNeedsBundle =
        providedOutcomeValid &&
        (providedOutcome.verdict === "passed" || providedOutcome.verdict === "repairable");
      const providedOutcomeAccepted =
        !finalizerError &&
        providedOutcomeValid &&
        (outcomeMode !== "strict" ||
          !providedOutcomeNeedsBundle ||
          legacyResult?.canonical_bundle_committed === true);
      const outcome = providedOutcomeAccepted
        ? providedOutcome
        : classifyRecordingOutcome({
            session_id: id,
            automation: defaultAutomation(sealedIntent),
            capture: captureEvidence(legacyResult),
            artifact_readable: legacyResult != null && numericField(legacyResult.bytes) > 0,
            cancelled_by: sealedIntent.kind === "cancel" ? sealedIntent.actor : null,
            terminal_reason_code: finalizerError
              ? ((
                  finalizerError as {
                    recordingReasonCode?: "bundle_commit_failed" | "readiness_failed";
                  }
                ).recordingReasonCode ?? "encode_failed")
              : outcomeMode === "strict"
                ? providedOutcomeNeedsBundle
                  ? "bundle_commit_failed"
                  : "terminal_evidence_missing"
                : null,
          });
      const terminalState: RecordingLifecycleState =
        outcome.verdict === "cancelled"
          ? "cancelled"
          : finalizerError || outcome.verdict === "failed"
            ? "failed"
            : "finalized";
      this.#transition(
        current,
        terminalState,
        finalizerError ? "finalizer_failed" : "finalizer_settled",
      );
      current.session.lifecycle = "finalized";
      const terminalEvent = recordingTerminalEvent(
        outcome,
        legacyResult,
        legacyResult?.canonical_bundle_committed === true,
      );
      const result: RecordingTerminalResult = {
        session_id: id,
        snapshot: this.#snapshot(current),
        outcome,
        terminal_event: terminalEvent,
        outcome_mode: outcomeMode,
        legacy_result: legacyResult,
        error_message:
          finalizerError instanceof Error
            ? finalizerError.message
            : finalizerError == null
              ? null
              : String(finalizerError),
      };
      const journal = recordingSessionJournal.traceContext(id);
      await recordEngineLog({
        level: outcome.verdict === "passed" ? "info" : "warn",
        event: "recording.terminal",
        context: {
          session_id: id,
          phase: terminalState,
          verdict: outcome.verdict,
          reason_code: outcome.reason_code,
          take_id: journal?.take_id,
          artifact_relpath:
            legacyResult?.canonical_bundle_committed === true ? "manifest.json" : undefined,
        },
        details: {
          canonical_bundle_committed: legacyResult?.canonical_bundle_committed === true,
          lifecycle_sequence: result.snapshot.sequence,
          outcome_mode: outcomeMode,
          journal_id: journal?.journal_id,
          journal_checkpoint: journal?.checkpoint,
        },
        error: finalizerError ?? undefined,
      });
      this.#cacheTerminal(result);
      this.#active.delete(id);
      this.#sessions.delete(id);
      if (outcomeMode === "strict") {
        try {
          sendChannel(current.session.eventTarget, current.session.eventChannelId, {
            type: "terminal",
            terminal: terminalEvent,
          });
        } catch {
          // Terminal state is already sealed and replayable through status.
        }
      }
      return result;
    });
    active.terminalPromise = terminalPromise;
    return terminalPromise;
  }

  async fail(id: string, reason: string): Promise<RecordingTerminalResult> {
    const active = this.#required(id);
    if (active.terminalPromise) return active.terminalPromise;
    const terminalPromise = this.#enqueue(active, async (current) => {
      current.session.pauseGate.cancel();
      current.session.actionLandmarks.cancelAll();
      recordingReadiness.remove(id);
      this.#transition(current, "failed", reason);
      current.session.lifecycle = "finalized";
      const outcome = classifyRecordingOutcome({
        session_id: id,
        automation: null,
        capture: null,
        terminal_reason_code: "terminal_evidence_missing",
      });
      const outcomeMode = recordingOutcomeMode();
      const result: RecordingTerminalResult = {
        session_id: id,
        snapshot: this.#snapshot(current),
        outcome,
        terminal_event: recordingTerminalEvent(outcome, null, false),
        outcome_mode: outcomeMode,
        legacy_result: null,
        error_message: reason,
      };
      const journal = recordingSessionJournal.traceContext(id);
      await recordEngineLog({
        level: "error",
        event: "recording.terminal",
        context: {
          session_id: id,
          phase: "failed",
          verdict: outcome.verdict,
          reason_code: outcome.reason_code,
          take_id: journal?.take_id,
        },
        details: {
          lifecycle_sequence: result.snapshot.sequence,
          outcome_mode: outcomeMode,
          journal_id: journal?.journal_id,
          journal_checkpoint: journal?.checkpoint,
        },
        error: new Error(reason),
      });
      this.#cacheTerminal(result);
      this.#active.delete(id);
      this.#sessions.delete(id);
      if (outcomeMode === "strict") {
        try {
          sendChannel(current.session.eventTarget, current.session.eventChannelId, {
            type: "terminal",
            terminal: result.terminal_event,
          });
        } catch {
          // Terminal state is already sealed and replayable through status.
        }
      }
      return result;
    });
    active.terminalPromise = terminalPromise;
    return terminalPromise;
  }

  status(id: string): RecordingStatusResultV1 | null {
    this.#purgeExpired();
    const active = this.#active.get(id);
    if (active) {
      return {
        version: 1,
        session_id: id,
        snapshot: this.#snapshot(active),
        terminal_outcome: null,
        terminal_event: null,
        outcome_mode: recordingOutcomeMode(),
        cached_until: null,
      };
    }
    const cached = this.#terminal.get(id);
    return cached
      ? {
          version: 1,
          session_id: id,
          snapshot: cached.result.snapshot,
          terminal_outcome: cached.result.outcome,
          terminal_event: cached.result.terminal_event,
          outcome_mode: cached.result.outcome_mode,
          cached_until: new Date(cached.expiresAt).toISOString(),
        }
      : null;
  }

  snapshot(id: string): RecordingLifecycleSnapshot | null {
    return this.status(id)?.snapshot ?? null;
  }

  isTerminalOrStopping(id: string): boolean {
    this.#purgeExpired();
    const active = this.#active.get(id);
    return Boolean(active?.terminalPromise || this.#terminal.has(id));
  }

  isCancellationRequested(id: string): boolean {
    const active = this.#active.get(id);
    return Boolean(
      active?.cancellationActor ||
        active?.state === "cancelling" ||
        active?.state === "cancelled" ||
        active?.state === "failed",
    );
  }

  sealIntent(id: string, fallback: StopIntent): StopIntent {
    return this.#sealIntent(this.#required(id), fallback);
  }

  #latchCancellation(active: ActiveLifecycle, actor: "user" | "host"): void {
    if (active.candidateSealed) return;
    active.cancellationActor ??= actor;
    active.session.paused = true;
    active.session.pauseGate.cancel();
    active.session.actionLandmarks.cancelAll();
    recordingReadiness.cancel(active.session.id);
  }

  #sealIntent(active: ActiveLifecycle, fallback: StopIntent): StopIntent {
    if (active.sealedIntent) return active.sealedIntent;
    const sealed: StopIntent = active.cancellationActor
      ? { kind: "cancel", actor: active.cancellationActor }
      : fallback;
    active.candidateSealed = true;
    active.sealedIntent = sealed;
    return sealed;
  }

  #required(id: string): ActiveLifecycle {
    const active = this.#active.get(id);
    if (!active) throw new Error(`recording session ${id} not found`);
    return active;
  }

  #enqueue<T>(
    active: ActiveLifecycle,
    operation: (active: ActiveLifecycle) => Promise<T>,
  ): Promise<T> {
    const run = active.queue.then(() => operation(active));
    active.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #transition(active: ActiveLifecycle, next: RecordingLifecycleState, reasonCode: string): void {
    if (active.state === next) return;
    if (!LEGAL_TRANSITIONS[active.state].has(next)) {
      void recordEngineLog({
        level: "warn",
        event: "recording.lifecycle.transition",
        context: {
          session_id: active.session.id,
          phase: next,
          reason_code: reasonCode,
        },
        details: {
          accepted: false,
          from_state: active.state,
          to_state: next,
          lifecycle_sequence: active.sequence,
        },
      });
      void hostLog("warn", "recording_lifecycle_illegal_transition", {
        session_id: active.session.id,
        from_state: active.state,
        to_state: next,
        sequence: active.sequence,
        reason_code: reasonCode,
      });
      throw new Error(`illegal recording lifecycle transition ${active.state} -> ${next}`);
    }
    const previous = active.state;
    active.state = next;
    active.sequence += 1;
    active.updatedAt = this.#now();
    void recordEngineLog({
      event: "recording.lifecycle.transition",
      context: {
        session_id: active.session.id,
        phase: next,
        reason_code: reasonCode,
      },
      details: {
        accepted: true,
        from_state: previous,
        to_state: next,
        lifecycle_sequence: active.sequence,
      },
    });
  }

  #snapshot(active: ActiveLifecycle): RecordingLifecycleSnapshot {
    return {
      version: 1,
      session_id: active.session.id,
      state: active.state,
      sequence: active.sequence,
      updated_at: new Date(active.updatedAt).toISOString(),
    };
  }

  #cacheTerminal(result: RecordingTerminalResult): void {
    this.#terminal.set(result.session_id, {
      result,
      expiresAt: this.#now() + this.#terminalTtlMs,
    });
    while (this.#terminal.size > this.#terminalMaxEntries) {
      const oldest = this.#terminal.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#terminal.delete(oldest);
    }
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, entry] of this.#terminal) {
      if (entry.expiresAt <= now) this.#terminal.delete(id);
    }
  }
}

export const recordingLifecycle = new RecordingLifecycleController();
