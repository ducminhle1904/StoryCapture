import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StartRecordingV4Args } from "@storycapture/shared-types";
import {
  canTransitionRecordingV4,
  isRecordingV4TerminalState,
  RECORDING_V4_CONTRACT_VERSION,
  RECORDING_V4_PROFILE,
  type RecordingV4CadenceEvidence,
  type RecordingV4Event,
  type RecordingV4FailureCode,
  type RecordingV4Journal,
  type RecordingV4Preflight,
  type RecordingV4Result,
  type RecordingV4Snapshot,
  type RecordingV4State,
} from "@storycapture/shared-types/recording-v4";
import type { WebContents } from "electron";

import { writeJsonAtomic } from "./json-store";
import {
  closeRecordingV4Channel,
  recordingV4ChannelId,
  sendRecordingV4Channel,
} from "./recording-v4-channel";
import { RecordingV4JournalStore } from "./recording-v4-journal";

export interface RecordingV4PlatformSession {
  readonly helperPid: number | null;
  preflight(): Promise<RecordingV4Preflight>;
  warmUp(): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<RecordingV4Result>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RecordingV4PlatformSessionInput {
  sessionId: string;
  workspacePath: string;
  request: StartRecordingV4Args;
  publishCadence: (cadence: RecordingV4CadenceEvidence) => void;
  fail: (code: RecordingV4FailureCode) => void;
  activeMediaTimeUs: () => number;
  recordAction: (action: RecordingV4ActionInput) => Promise<RecordingV4ActionEvent>;
  isActive: () => boolean;
}

export type RecordingV4PlatformSessionFactory = (
  input: RecordingV4PlatformSessionInput,
) => RecordingV4PlatformSession | Promise<RecordingV4PlatformSession>;

export interface RecordingV4ActionInput {
  step_id: string | null;
  ordinal: number;
  phase: string;
  payload?: Record<string, unknown>;
}

export interface RecordingV4ActionEvent extends RecordingV4ActionInput {
  active_media_time_us: number;
}

export interface RecordingV4CoordinatorOptions {
  journalRoot: string;
  platformSessionFactory: RecordingV4PlatformSessionFactory;
  heartbeatIntervalMs?: number;
  monotonicNowUs?: () => number;
  wallClockNow?: () => Date;
  sessionIdFactory?: () => string;
}

interface Subscription {
  sender: WebContents;
  channelId: number;
}

function failedResult(
  sessionId: string,
  failureCodes: RecordingV4FailureCode[],
): RecordingV4Result {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    profile: RECORDING_V4_PROFILE,
    session_id: sessionId,
    state: "failed",
    bundle_path: null,
    output_path: null,
    diagnostic_bundle_path: null,
    failure_codes: failureCodes,
  };
}

function cancelledResult(sessionId: string): RecordingV4Result {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    profile: RECORDING_V4_PROFILE,
    session_id: sessionId,
    state: "cancelled",
    bundle_path: null,
    output_path: null,
    diagnostic_bundle_path: null,
    failure_codes: [],
  };
}

class ActiveMediaClock {
  private accumulatedUs = 0;
  private runningSinceUs: number | null = null;

  constructor(private readonly nowUs: () => number) {}

  start(): void {
    this.runningSinceUs ??= this.nowUs();
  }

  pause(): void {
    if (this.runningSinceUs === null) return;
    this.accumulatedUs += Math.max(0, this.nowUs() - this.runningSinceUs);
    this.runningSinceUs = null;
  }

  value(): number {
    const runningUs =
      this.runningSinceUs === null ? 0 : Math.max(0, this.nowUs() - this.runningSinceUs);
    return Math.round(this.accumulatedUs + runningUs);
  }
}

class RecordingV4Session {
  private state: RecordingV4State = "idle";
  private revision = 0;
  private cadence: RecordingV4CadenceEvidence | null = null;
  private terminalResult: RecordingV4Result | null = null;
  private platformSession: RecordingV4PlatformSession | null = null;
  private operation: Promise<void> = Promise.resolve();
  private readonly subscriptions = new Set<Subscription>();
  private readonly mediaClock: ActiveMediaClock;
  private readonly actions: RecordingV4ActionEvent[] = [];
  private actionWrite: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private terminalPublished = false;

  constructor(
    readonly id: string,
    readonly request: StartRecordingV4Args,
    readonly workspacePath: string,
    private readonly store: RecordingV4JournalStore,
    private readonly options: Required<
      Pick<RecordingV4CoordinatorOptions, "heartbeatIntervalMs" | "monotonicNowUs" | "wallClockNow">
    > & { platformSessionFactory: RecordingV4PlatformSessionFactory },
    private readonly createdAt: string,
  ) {
    this.mediaClock = new ActiveMediaClock(options.monotonicNowUs);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.workspacePath, "sidecars"), { recursive: true });
    await this.persist();
    this.heartbeat = setInterval(() => {
      this.emit({
        type: "heartbeat",
        revision: this.revision,
        monotonic_us: this.options.monotonicNowUs(),
      });
    }, this.options.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  snapshot(): RecordingV4Snapshot {
    return {
      version: RECORDING_V4_CONTRACT_VERSION,
      session_id: this.id,
      state: this.state,
      revision: this.revision,
      active_media_time_us: this.mediaClock.value(),
      requested_audio_roles: [...this.request.requested_audio_roles],
      cadence: this.cadence,
      terminal_result: this.terminalResult,
    };
  }

  subscribe(sender: WebContents, channel: unknown): RecordingV4Snapshot {
    const channelId = recordingV4ChannelId(channel);
    if (channelId === null) throw new Error("Recording V4 subscription requires a channel.");
    const subscription = { sender, channelId };
    this.subscriptions.add(subscription);
    const snapshot = this.snapshot();
    sendRecordingV4Channel(sender, channelId, { type: "snapshot", snapshot });
    if (this.terminalResult) {
      closeRecordingV4Channel(sender, channelId);
      this.subscriptions.delete(subscription);
    }
    return snapshot;
  }

  command(command: "start" | "pause" | "resume" | "stop" | "cancel") {
    return this.enqueue(async () => {
      if (this.terminalResult) {
        if (command === "stop" || command === "cancel") return this.terminalResult;
        throw new Error(`Recording V4 session is already ${this.state}.`);
      }
      if (command === "start") return this.start();
      if (command === "pause") return this.pause();
      if (command === "resume") return this.resume();
      if (command === "stop") return this.stop();
      return this.cancel();
    });
  }

  async recordAction(input: RecordingV4ActionInput): Promise<RecordingV4ActionEvent> {
    if (this.state !== "capturing" && this.state !== "paused") {
      throw new Error("Recording V4 actions require an active capture session.");
    }
    const event = { ...input, active_media_time_us: this.mediaClock.value() };
    JSON.stringify(event);
    this.actions.push(event);
    this.actionWrite = this.actionWrite.then(() =>
      writeJsonAtomic(path.join(this.workspacePath, "sidecars", "actions.json"), {
        version: RECORDING_V4_CONTRACT_VERSION,
        session_id: this.id,
        clock: "active_media_time_us",
        events: this.actions,
      }),
    );
    await this.actionWrite;
    return event;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async start(): Promise<RecordingV4Result | null> {
    if (this.state !== "idle") throw new Error(`Cannot start Recording V4 from ${this.state}.`);
    await this.transition("preflighting");
    try {
      this.platformSession = await this.options.platformSessionFactory({
        sessionId: this.id,
        workspacePath: this.workspacePath,
        request: this.request,
        publishCadence: (cadence) => this.publishCadence(cadence),
        fail: (code) => void this.fail(code),
        activeMediaTimeUs: () => this.mediaClock.value(),
        recordAction: (action) => this.recordAction(action),
        isActive: () => !isRecordingV4TerminalState(this.state),
      });
      await this.persist();
      const preflight = await this.platformSession.preflight();
      this.emit({ type: "preflight", result: preflight });
      if (!preflight.passed) {
        return this.finishTerminal(
          failedResult(
            this.id,
            preflight.failure_codes.length ? preflight.failure_codes : ["contract_mismatch"],
          ),
        );
      }
      await this.transition("warming_up");
      await this.platformSession.warmUp();
      await this.transition("ready");
      await this.platformSession.start();
      this.mediaClock.start();
      await this.transition("capturing");
      return null;
    } catch (error) {
      return this.finishTerminal(failedResult(this.id, [this.failureCode(error)]));
    }
  }

  private async pause(): Promise<null> {
    if (this.state !== "capturing" || !this.platformSession) {
      throw new Error(`Cannot pause Recording V4 from ${this.state}.`);
    }
    await this.platformSession.pause();
    this.mediaClock.pause();
    await this.transition("paused");
    return null;
  }

  private async resume(): Promise<null> {
    if (this.state !== "paused" || !this.platformSession) {
      throw new Error(`Cannot resume Recording V4 from ${this.state}.`);
    }
    await this.platformSession.resume();
    this.mediaClock.start();
    await this.transition("capturing");
    return null;
  }

  private async stop(): Promise<RecordingV4Result> {
    if ((this.state !== "capturing" && this.state !== "paused") || !this.platformSession) {
      throw new Error(`Cannot stop Recording V4 from ${this.state}.`);
    }
    this.mediaClock.pause();
    await this.transition("stopping");
    try {
      await this.actionWrite;
      const result = await this.platformSession.stop();
      if (result.session_id !== this.id)
        throw new Error("Platform returned a mismatched session ID.");
      if (result.state === "completed" || result.state === "quality_failed") {
        await this.transition("verifying");
      }
      return this.finishTerminal(result);
    } catch (error) {
      return this.finishTerminal(failedResult(this.id, [this.failureCode(error)]));
    }
  }

  private async cancel(): Promise<RecordingV4Result> {
    if (this.platformSession) {
      try {
        await this.platformSession.cancel();
      } catch {
        return this.finishTerminal(failedResult(this.id, ["helper_crashed"]));
      }
    }
    this.mediaClock.pause();
    return this.finishTerminal(cancelledResult(this.id));
  }

  private fail(code: RecordingV4FailureCode): Promise<RecordingV4Result> {
    return this.enqueue(() => this.finishTerminal(failedResult(this.id, [code])));
  }

  private failureCode(error: unknown): RecordingV4FailureCode {
    if (
      error &&
      typeof error === "object" &&
      "recordingV4FailureCode" in error &&
      typeof error.recordingV4FailureCode === "string"
    ) {
      return error.recordingV4FailureCode as RecordingV4FailureCode;
    }
    return this.platformSession ? "helper_crashed" : "helper_unavailable";
  }

  private async transition(next: RecordingV4State): Promise<void> {
    if (!canTransitionRecordingV4(this.state, next)) {
      throw new Error(`Illegal Recording V4 transition: ${this.state} -> ${next}.`);
    }
    const previous = this.state;
    this.state = next;
    this.revision += 1;
    try {
      await this.persist();
    } catch (error) {
      this.state = previous;
      this.revision -= 1;
      throw error;
    }
    this.emit({ type: "state-changed", from: previous, to: next, revision: this.revision });
  }

  private publishCadence(cadence: RecordingV4CadenceEvidence): void {
    if (this.terminalResult) return;
    this.cadence = cadence;
    this.emit({ type: "live-evidence", cadence });
  }

  private async finishTerminal(result: RecordingV4Result): Promise<RecordingV4Result> {
    if (this.terminalResult) return this.terminalResult;
    if (!isRecordingV4TerminalState(result.state)) {
      throw new Error("Platform returned a non-terminal Recording V4 result.");
    }
    if (!canTransitionRecordingV4(this.state, result.state)) {
      result = failedResult(this.id, ["illegal_transition"]);
      if (!canTransitionRecordingV4(this.state, "failed")) {
        throw new Error(`Cannot fail Recording V4 from ${this.state}.`);
      }
    }
    const previous = this.state;
    const previousRevision = this.revision;
    this.state = result.state;
    this.revision += 1;
    this.terminalResult = result;
    try {
      await this.actionWrite;
      await this.persist();
    } catch (error) {
      this.state = previous;
      this.revision = previousRevision;
      this.terminalResult = null;
      throw error;
    }
    this.emit({ type: "state-changed", from: previous, to: result.state, revision: this.revision });
    if (!this.terminalPublished) {
      this.terminalPublished = true;
      this.emit({ type: "terminal", result });
    }
    await this.cleanup(result);
    return result;
  }

  private async cleanup(result: RecordingV4Result): Promise<void> {
    this.cleanupPromise ??= (async () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.platformSession) await this.platformSession.dispose().catch(() => undefined);
      for (const subscription of this.subscriptions) {
        closeRecordingV4Channel(subscription.sender, subscription.channelId);
      }
      this.subscriptions.clear();
      if (result.bundle_path === null) {
        await fs.rm(this.workspacePath, { recursive: true, force: true });
        await this.store.remove(this.id);
      }
    })();
    return this.cleanupPromise;
  }

  private emit(event: RecordingV4Event): void {
    for (const subscription of this.subscriptions) {
      if (subscription.sender.isDestroyed()) {
        this.subscriptions.delete(subscription);
        continue;
      }
      sendRecordingV4Channel(subscription.sender, subscription.channelId, event);
    }
  }

  private journal(): RecordingV4Journal {
    return {
      version: RECORDING_V4_CONTRACT_VERSION,
      session_id: this.id,
      project_path: this.request.project_path,
      workspace_path: this.workspacePath,
      state: this.state,
      revision: this.revision,
      helper_pid: this.platformSession?.helperPid ?? null,
      created_at: this.createdAt,
      updated_at: this.options.wallClockNow().toISOString(),
      terminal_result: this.terminalResult,
    };
  }

  private persist(): Promise<void> {
    return this.store.write(this.journal());
  }
}

export class RecordingV4Coordinator {
  readonly journalStore: RecordingV4JournalStore;
  private readonly sessions = new Map<string, RecordingV4Session>();
  private readonly recoveredSnapshots = new Map<string, RecordingV4Snapshot>();
  private initialized: Promise<void> | null = null;
  private readonly options: Required<
    Pick<
      RecordingV4CoordinatorOptions,
      "heartbeatIntervalMs" | "monotonicNowUs" | "wallClockNow" | "sessionIdFactory"
    >
  > & { platformSessionFactory: RecordingV4PlatformSessionFactory };

  constructor(options: RecordingV4CoordinatorOptions) {
    this.journalStore = new RecordingV4JournalStore(options.journalRoot);
    this.options = {
      platformSessionFactory: options.platformSessionFactory,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
      monotonicNowUs: options.monotonicNowUs ?? (() => Number(process.hrtime.bigint() / 1_000n)),
      wallClockNow: options.wallClockNow ?? (() => new Date()),
      sessionIdFactory: options.sessionIdFactory ?? randomUUID,
    };
  }

  initialize(): Promise<void> {
    this.initialized ??= this.journalStore.recoverInterrupted().then((records) => {
      for (const record of records) {
        const journal = record.journal;
        if (!journal?.terminal_result) continue;
        this.recoveredSnapshots.set(journal.session_id, {
          version: RECORDING_V4_CONTRACT_VERSION,
          session_id: journal.session_id,
          state: journal.state,
          revision: journal.revision,
          active_media_time_us: 0,
          requested_audio_roles: [],
          cadence: null,
          terminal_result: journal.terminal_result,
        });
      }
    });
    return this.initialized;
  }

  async create(request: StartRecordingV4Args): Promise<{ id: string }> {
    await this.initialize();
    if (typeof request.project_path !== "string" || !path.isAbsolute(request.project_path)) {
      throw new Error("Recording V4 project_path must be absolute.");
    }
    if (!request.source_url || !Number.isSafeInteger(request.logical_width) ||
      !Number.isSafeInteger(request.logical_height) || request.logical_width <= 0 ||
      request.logical_height <= 0) {
      throw new Error("Recording V4 requires a valid author-preview source.");
    }
    if (
      !Array.isArray(request.requested_audio_roles) ||
      !request.requested_audio_roles.every((role) => role === "microphone" || role === "system")
    ) {
      throw new Error("Recording V4 audio roles are invalid.");
    }
    if (new Set(request.requested_audio_roles).size !== request.requested_audio_roles.length) {
      throw new Error("Recording V4 audio roles must be unique.");
    }
    const id = this.options.sessionIdFactory();
    const workspacePath = path.join(request.project_path, "exports", `.recording-v4-${id}.staging`);
    const createdAt = this.options.wallClockNow().toISOString();
    const session = new RecordingV4Session(
      id,
      request,
      workspacePath,
      this.journalStore,
      this.options,
      createdAt,
    );
    await session.initialize();
    this.sessions.set(id, session);
    return { id };
  }

  async command(
    sessionId: string,
    command: "start" | "pause" | "resume" | "stop" | "cancel",
  ): Promise<RecordingV4Result | null> {
    return this.requireSession(sessionId).command(command);
  }

  snapshot(sessionId: string): RecordingV4Snapshot {
    return this.sessions.get(sessionId)?.snapshot() ?? this.requireRecoveredSnapshot(sessionId);
  }

  subscribe(sessionId: string, sender: WebContents, channel: unknown): RecordingV4Snapshot {
    const session = this.sessions.get(sessionId);
    if (session) return session.subscribe(sender, channel);
    const snapshot = this.requireRecoveredSnapshot(sessionId);
    const channelId = recordingV4ChannelId(channel);
    if (channelId === null) throw new Error("Recording V4 subscription requires a channel.");
    sendRecordingV4Channel(sender, channelId, { type: "snapshot", snapshot });
    closeRecordingV4Channel(sender, channelId);
    return snapshot;
  }

  recordAction(sessionId: string, action: RecordingV4ActionInput): Promise<RecordingV4ActionEvent> {
    return this.requireSession(sessionId).recordAction(action);
  }

  private requireSession(sessionId: string): RecordingV4Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Recording V4 session: ${sessionId}`);
    return session;
  }

  private requireRecoveredSnapshot(sessionId: string): RecordingV4Snapshot {
    const snapshot = this.recoveredSnapshots.get(sessionId);
    if (!snapshot) throw new Error(`Unknown Recording V4 session: ${sessionId}`);
    return snapshot;
  }
}
