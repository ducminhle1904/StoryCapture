import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ActionTimelineEvent } from "./action-timeline";
import { recordingBundleForSession } from "./recording-bundle";
import { RecordingMediaClock, type RecordingMediaClockSnapshot } from "./recording-media-clock";
import { recordEngineLog } from "./recording-observability";
import { recordingSessionJournal } from "./recording-session-journal";
import type { ParsedCommand, ParsedCommandSceneContext } from "./story-parser";

export type RecordingCheckpointMode = "off" | "shadow";
export type SceneAttemptStatus = "recording" | "committed" | "failed" | "cancelled";

export interface SceneSegmentAttempt {
  scene_id: string;
  scene_ordinal: number;
  attempt_id: string;
  status: SceneAttemptStatus;
  media_path: string;
  media_clock: RecordingMediaClockSnapshot;
  source_frame_range: { start: number; end: number } | null;
  source_pts_range_us: { start: number; end: number } | null;
  health: Record<string, number | string | boolean | null>;
}

export interface StepCheckpoint {
  step_id: string;
  scene_id: string;
  scene_ordinal: number;
  step_ordinal: number;
  command_verb: string;
  attempt_id: string;
  frame_range: { start: number; end: number };
  pts_range_us: { start: number; end: number };
  action_event_id: string | null;
  state_hash: string;
  status: "succeeded";
  health: Record<string, number | string | boolean | null>;
}

export interface LiveStepCheckpointState {
  step_id: string;
  attempt_id: string;
  live_state_handle: string;
}

export interface RecordingCheckpointAssemblySnapshot {
  attempts: SceneSegmentAttempt[];
  checkpoints_by_attempt: Record<string, StepCheckpoint[]>;
  actions_by_attempt: Record<string, ActionTimelineEvent[]>;
}

export interface SegmentEncoder {
  write(frame: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

interface ActiveAttempt {
  context: ParsedCommandSceneContext;
  attemptId: string;
  relativeMediaPath: string;
  finalMediaPath: string;
  partialMediaPath: string;
  encoder: SegmentEncoder;
  mediaClock: RecordingMediaClock;
  firstMasterFrame: number | null;
  firstMasterPtsUs: number | null;
  lastMasterFrame: number | null;
  lastMasterPtsUs: number | null;
  pendingStep: {
    command: ParsedCommand;
    startFrame: number;
    startPtsUs: number;
  } | null;
}

interface CoordinatorOptions {
  sessionId: string;
  segmentsDir: string;
  width: number;
  height: number;
  fps: number;
  encoderFactory?: (input: {
    partialPath: string;
    finalPath: string;
    width: number;
    height: number;
    fps: number;
  }) => SegmentEncoder;
  declareArtifacts?: (input: {
    segmentPath: string;
    segmentRelativePath: string;
    journalPath: string;
  }) => Promise<void>;
}

export class RecordingCheckpointError extends Error {
  readonly recordingReasonCode = "checkpoint_failed";

  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`recording_checkpoint_failed:${reason}`, cause === undefined ? undefined : { cause });
    this.name = "RecordingCheckpointError";
  }
}

export function recordingCheckpointMode(
  value = process.env.STORYCAPTURE_RECORDING_CHECKPOINT_MODE,
): RecordingCheckpointMode {
  return value === "shadow" ? "shadow" : "off";
}

function safeHealth(value: unknown): Record<string, number | string | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, number | string | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^(capture_|encoder_|frame_|frames_|fps|lifecycle|paused|session_|skipped)/.test(key)) {
      continue;
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      safe[key] = item;
    }
  }
  return safe;
}

function sanitizedUrlIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function checkpointStateHash(input: {
  sceneId: string;
  stepId: string;
  verb: string;
  url?: string | null;
  targetKind?: string | null;
  frame: number;
  ptsUs: number;
}): string {
  const sanitized = {
    scene_id: input.sceneId,
    step_id: input.stepId,
    verb: input.verb,
    url: sanitizedUrlIdentity(input.url),
    target_kind: input.targetKind ?? null,
    frame: input.frame,
    pts_us: input.ptsUs,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(sanitized)).digest("hex")}`;
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class FfmpegSegmentEncoder implements SegmentEncoder {
  readonly #child;
  readonly #done: Promise<void>;

  constructor(
    readonly partialPath: string,
    readonly finalPath: string,
    width: number,
    height: number,
    fps: number,
  ) {
    if (!ffmpegPath) throw new RecordingCheckpointError("ffmpeg_unavailable");
    this.#child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-y",
        partialPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.#child.stdin.on("error", () => {});
    this.#done = new Promise<void>((resolve, reject) => {
      this.#child.once("error", (error) =>
        reject(new RecordingCheckpointError("encoder_spawn", error)),
      );
      this.#child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new RecordingCheckpointError("encoder_exit"));
      });
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    if (this.#child.killed || this.#child.stdin.destroyed) {
      throw new RecordingCheckpointError("encoder_closed");
    }
    if (!this.#child.stdin.write(frame)) {
      await new Promise<void>((resolve, reject) => {
        this.#child.stdin.once("drain", resolve);
        this.#child.stdin.once("error", reject);
      });
    }
  }

  async finish(): Promise<void> {
    this.#child.stdin.end();
    await this.#done;
    await syncFile(this.partialPath);
    await fs.rename(this.partialPath, this.finalPath);
    await syncDirectory(path.dirname(this.finalPath));
  }

  async abort(): Promise<void> {
    if (!this.#child.killed) this.#child.kill("SIGKILL");
    await this.#done.catch(() => {});
    await fs.rm(this.partialPath, { force: true });
  }
}

export class RecordingCheckpointCoordinator {
  readonly #sessionId: string;
  readonly #segmentsDir: string;
  readonly #width: number;
  readonly #height: number;
  readonly #fps: number;
  readonly #encoderFactory: NonNullable<CoordinatorOptions["encoderFactory"]>;
  readonly #journalPath: string;
  readonly #declareArtifacts: NonNullable<CoordinatorOptions["declareArtifacts"]>;
  readonly #liveHandles = new Map<string, LiveStepCheckpointState>();
  readonly #attempts: SceneSegmentAttempt[] = [];
  readonly #checkpoints: StepCheckpoint[] = [];
  readonly #actionsByAttempt = new Map<string, ActionTimelineEvent[]>();
  #attemptSequence = 0;
  #active: ActiveAttempt | null = null;
  #appendChain = Promise.resolve();

  constructor(options: CoordinatorOptions) {
    this.#sessionId = options.sessionId;
    this.#segmentsDir = options.segmentsDir;
    this.#width = options.width;
    this.#height = options.height;
    this.#fps = options.fps;
    this.#journalPath = path.join(options.segmentsDir, "checkpoints.v1.jsonl");
    this.#encoderFactory =
      options.encoderFactory ??
      ((input) =>
        new FfmpegSegmentEncoder(
          input.partialPath,
          input.finalPath,
          input.width,
          input.height,
          input.fps,
        ));
    this.#declareArtifacts =
      options.declareArtifacts ??
      (async (input) => {
        const bundle = recordingBundleForSession(this.#sessionId);
        bundle?.registerArtifact("segment", input.segmentRelativePath, false);
        await recordingSessionJournal.checkpoint(this.#sessionId, "capture_started", {
          artifacts: [
            { kind: "segment", file: input.segmentPath },
            { kind: "diagnostic", file: input.journalPath },
          ],
        });
      });
  }

  get activeSceneId(): string | null {
    return this.#active?.context.scene_id ?? null;
  }

  async beginScene(context: ParsedCommandSceneContext): Promise<SceneSegmentAttempt> {
    if (this.#active) throw new RecordingCheckpointError("scene_already_active");
    this.#attemptSequence += 1;
    const attemptId = `attempt-${String(this.#attemptSequence).padStart(6, "0")}`;
    const sceneDir = path.join(this.#segmentsDir, context.scene_id);
    await fs.mkdir(sceneDir, { recursive: true });
    const finalMediaPath = path.join(sceneDir, `${attemptId}.mp4`);
    const partialMediaPath = `${finalMediaPath}.partial`;
    const relativeMediaPath = path.relative(path.dirname(this.#segmentsDir), finalMediaPath);
    const encoder = this.#encoderFactory({
      partialPath: partialMediaPath,
      finalPath: finalMediaPath,
      width: this.#width,
      height: this.#height,
      fps: this.#fps,
    });
    this.#active = {
      context,
      attemptId,
      relativeMediaPath,
      finalMediaPath,
      partialMediaPath,
      encoder,
      mediaClock: new RecordingMediaClock({ fpsNum: this.#fps, fpsDen: 1 }),
      firstMasterFrame: null,
      firstMasterPtsUs: null,
      lastMasterFrame: null,
      lastMasterPtsUs: null,
      pendingStep: null,
    };
    const attempt = this.#attemptRecord("recording", {});
    await this.#append({ type: "scene_attempt_started", attempt });
    void recordEngineLog({
      event: "recording.scene.attempt_started",
      context: {
        session_id: this.#sessionId,
        scene_id: context.scene_id,
        attempt_id: attemptId,
        phase: "recording",
      },
      details: { scene_ordinal: context.scene_ordinal },
    });
    return attempt;
  }

  beginStep(command: ParsedCommand, masterClock: RecordingMediaClockSnapshot): void {
    const active = this.#requiredActive(command.scene_id);
    if (active.pendingStep) throw new RecordingCheckpointError("step_already_active");
    active.pendingStep = {
      command,
      startFrame: masterClock.frameCount,
      startPtsUs: masterClock.nextPtsUs,
    };
  }

  async recordFrame(
    frame: Uint8Array,
    masterLandmark: { frameIndex: number; ptsUs: number },
  ): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (frame.byteLength !== this.#width * this.#height * 4) {
      throw new RecordingCheckpointError("frame_size_mismatch");
    }
    await active.encoder.write(frame);
    active.mediaClock.commitFrame(true);
    active.firstMasterFrame ??= masterLandmark.frameIndex;
    active.firstMasterPtsUs ??= masterLandmark.ptsUs;
    active.lastMasterFrame = masterLandmark.frameIndex;
    active.lastMasterPtsUs = masterLandmark.ptsUs;
  }

  async commitStep(input: {
    command: ParsedCommand;
    actionEventId: string | null;
    url?: string | null;
    targetKind?: string | null;
    health?: unknown;
  }): Promise<{ checkpoint: StepCheckpoint; live: LiveStepCheckpointState }> {
    const active = this.#requiredActive(input.command.scene_id);
    const pending = active.pendingStep;
    if (!pending || pending.command !== input.command) {
      throw new RecordingCheckpointError("step_not_active");
    }
    if (active.lastMasterFrame == null || active.lastMasterPtsUs == null) {
      throw new RecordingCheckpointError("step_media_uncommitted");
    }
    const stepId =
      input.command.step_id ??
      `scene-${input.command.scene_ordinal}-step-${input.command.step_ordinal}`;
    const checkpoint: StepCheckpoint = {
      step_id: stepId,
      scene_id: active.context.scene_id,
      scene_ordinal: active.context.scene_ordinal,
      step_ordinal: input.command.step_ordinal ?? 0,
      command_verb: input.command.verb,
      attempt_id: active.attemptId,
      frame_range: { start: pending.startFrame, end: active.lastMasterFrame },
      pts_range_us: { start: pending.startPtsUs, end: active.lastMasterPtsUs },
      action_event_id: input.actionEventId,
      state_hash: checkpointStateHash({
        sceneId: active.context.scene_id,
        stepId,
        verb: input.command.verb,
        url: input.url,
        targetKind: input.targetKind,
        frame: active.lastMasterFrame,
        ptsUs: active.lastMasterPtsUs,
      }),
      status: "succeeded",
      health: safeHealth(input.health),
    };
    if (
      checkpoint.frame_range.end < checkpoint.frame_range.start ||
      checkpoint.pts_range_us.end < checkpoint.pts_range_us.start
    ) {
      throw new RecordingCheckpointError("checkpoint_clock_regressed");
    }
    const live: LiveStepCheckpointState = {
      step_id: stepId,
      attempt_id: active.attemptId,
      live_state_handle: randomUUID(),
    };
    this.#liveHandles.set(live.live_state_handle, live);
    while (this.#liveHandles.size > 256) {
      const oldest = this.#liveHandles.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#liveHandles.delete(oldest);
    }
    active.pendingStep = null;
    this.#checkpoints.push(checkpoint);
    await this.#append({ type: "step_checkpoint_committed", checkpoint });
    void recordEngineLog({
      event: "recording.checkpoint.committed",
      context: {
        session_id: this.#sessionId,
        scene_id: checkpoint.scene_id,
        step_id: checkpoint.step_id,
        attempt_id: checkpoint.attempt_id,
        ordinal: checkpoint.step_ordinal,
      },
      details: {
        frame_start: checkpoint.frame_range.start,
        frame_end: checkpoint.frame_range.end,
        pts_start_us: checkpoint.pts_range_us.start,
        pts_end_us: checkpoint.pts_range_us.end,
        state_hash: checkpoint.state_hash,
      },
    });
    return { checkpoint, live };
  }

  async closeScene(
    status: Exclude<SceneAttemptStatus, "recording">,
    health?: unknown,
  ): Promise<SceneSegmentAttempt | null> {
    const active = this.#active;
    if (!active) return null;
    this.#active = null;
    active.pendingStep = null;
    if (active.mediaClock.snapshot().frameCount === 0) {
      await active.encoder.abort();
      const emptyAttempt = this.#attemptRecordFrom(active, status, safeHealth(health));
      this.#attempts.push(emptyAttempt);
      await this.#append({ type: `scene_attempt_${status}`, attempt: emptyAttempt });
      void recordEngineLog({
        level: status === "committed" ? "info" : "warn",
        event:
          status === "committed"
            ? "recording.scene.attempt_committed"
            : "recording.scene.attempt_failed",
        context: {
          session_id: this.#sessionId,
          scene_id: emptyAttempt.scene_id,
          attempt_id: emptyAttempt.attempt_id,
          phase: status,
          reason_code: status === "committed" ? undefined : `scene_${status}`,
        },
        details: { empty: true, scene_ordinal: emptyAttempt.scene_ordinal },
      });
      return emptyAttempt;
    }
    await active.encoder.finish();
    const attempt = this.#attemptRecordFrom(active, status, safeHealth(health));
    this.#attempts.push(attempt);
    await this.#append({
      type: status === "committed" ? "scene_attempt_committed" : `scene_attempt_${status}`,
      attempt,
    });
    void recordEngineLog({
      level: status === "committed" ? "info" : "warn",
      event:
        status === "committed"
          ? "recording.scene.attempt_committed"
          : "recording.scene.attempt_failed",
      context: {
        session_id: this.#sessionId,
        scene_id: attempt.scene_id,
        attempt_id: attempt.attempt_id,
        phase: status,
        reason_code: status === "committed" ? undefined : `scene_${status}`,
        artifact_relpath: active.relativeMediaPath,
      },
      details: {
        empty: false,
        scene_ordinal: attempt.scene_ordinal,
        frame_range: attempt.source_frame_range,
        pts_range_us: attempt.source_pts_range_us,
      },
    });
    await this.#declareArtifacts({
      segmentPath: active.finalMediaPath,
      segmentRelativePath: active.relativeMediaPath,
      journalPath: this.#journalPath,
    });
    return attempt;
  }

  recordAction(actionEventId: string, event: ActionTimelineEvent): void {
    let checkpoint: StepCheckpoint | undefined;
    for (let index = this.#checkpoints.length - 1; index >= 0; index -= 1) {
      const candidate = this.#checkpoints[index];
      if (candidate?.action_event_id === actionEventId) {
        checkpoint = candidate;
        break;
      }
    }
    if (!checkpoint) throw new RecordingCheckpointError("action_checkpoint_missing");
    const actions = this.#actionsByAttempt.get(checkpoint.attempt_id) ?? [];
    actions.push(event);
    this.#actionsByAttempt.set(checkpoint.attempt_id, actions);
  }

  assemblySnapshot(): RecordingCheckpointAssemblySnapshot {
    const checkpointsByAttempt: Record<string, StepCheckpoint[]> = {};
    for (const checkpoint of this.#checkpoints) {
      const attemptCheckpoints = checkpointsByAttempt[checkpoint.attempt_id] ?? [];
      attemptCheckpoints.push({ ...checkpoint });
      checkpointsByAttempt[checkpoint.attempt_id] = attemptCheckpoints;
    }
    return {
      attempts: this.#attempts.map((attempt) => ({ ...attempt })),
      checkpoints_by_attempt: checkpointsByAttempt,
      actions_by_attempt: Object.fromEntries(
        [...this.#actionsByAttempt].map(([attemptId, events]) => [
          attemptId,
          events.map((event) => ({ ...event })),
        ]),
      ),
    };
  }

  liveState(handle: string): LiveStepCheckpointState | null {
    return this.#liveHandles.get(handle) ?? null;
  }

  invalidateLiveState(): void {
    this.#liveHandles.clear();
  }

  async recordShadowDivergence(stage: string, reason: string, errorName: string): Promise<void> {
    await this.#append({
      type: "checkpoint_shadow_diverged",
      stage,
      reason,
      error_name: errorName,
      scene_id: this.#active?.context.scene_id ?? null,
      attempt_id: this.#active?.attemptId ?? null,
    });
  }

  async dispose(): Promise<void> {
    if (this.#active) await this.closeScene("cancelled");
    this.invalidateLiveState();
    await this.#appendChain;
  }

  #requiredActive(sceneId?: string): ActiveAttempt {
    if (!this.#active) throw new RecordingCheckpointError("scene_not_active");
    if (!sceneId || this.#active.context.scene_id !== sceneId) {
      throw new RecordingCheckpointError("scene_identity_mismatch");
    }
    return this.#active;
  }

  #attemptRecord(
    status: SceneAttemptStatus,
    health: Record<string, number | string | boolean | null>,
  ): SceneSegmentAttempt {
    if (!this.#active) throw new RecordingCheckpointError("scene_not_active");
    return this.#attemptRecordFrom(this.#active, status, health);
  }

  #attemptRecordFrom(
    active: ActiveAttempt,
    status: SceneAttemptStatus,
    health: Record<string, number | string | boolean | null>,
  ): SceneSegmentAttempt {
    return {
      scene_id: active.context.scene_id,
      scene_ordinal: active.context.scene_ordinal,
      attempt_id: active.attemptId,
      status,
      media_path: active.relativeMediaPath.split(path.sep).join("/"),
      media_clock: active.mediaClock.snapshot(),
      source_frame_range:
        active.firstMasterFrame == null || active.lastMasterFrame == null
          ? null
          : { start: active.firstMasterFrame, end: active.lastMasterFrame },
      source_pts_range_us:
        active.firstMasterPtsUs == null || active.lastMasterPtsUs == null
          ? null
          : { start: active.firstMasterPtsUs, end: active.lastMasterPtsUs },
      health,
    };
  }

  #append(record: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify({ version: 1, ...record })}\n`;
    this.#appendChain = this.#appendChain.then(async () => {
      await fs.mkdir(path.dirname(this.#journalPath), { recursive: true });
      await fs.appendFile(this.#journalPath, serialized, "utf8");
      await syncFile(this.#journalPath);
    });
    return this.#appendChain;
  }
}

const coordinators = new Map<string, RecordingCheckpointCoordinator>();

export function registerRecordingCheckpoints(
  options: CoordinatorOptions,
): RecordingCheckpointCoordinator {
  const existing = coordinators.get(options.sessionId);
  if (existing) return existing;
  const coordinator = new RecordingCheckpointCoordinator(options);
  coordinators.set(options.sessionId, coordinator);
  return coordinator;
}

export function recordingCheckpointsForSession(
  sessionId: string,
): RecordingCheckpointCoordinator | null {
  return coordinators.get(sessionId) ?? null;
}

export async function disposeRecordingCheckpoints(sessionId: string): Promise<void> {
  const coordinator = coordinators.get(sessionId);
  coordinators.delete(sessionId);
  await coordinator?.dispose();
}

export async function discoverCommittedSceneAttempts(
  segmentsDir: string,
): Promise<SceneSegmentAttempt[]> {
  const journalPath = path.join(segmentsDir, "checkpoints.v1.jsonl");
  const content = await fs.readFile(journalPath, "utf8").catch(() => "");
  const committed: SceneSegmentAttempt[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; attempt?: SceneSegmentAttempt };
      if (record.type !== "scene_attempt_committed" || !record.attempt) continue;
      const media = path.resolve(path.dirname(segmentsDir), record.attempt.media_path);
      if (!media.startsWith(`${path.resolve(segmentsDir)}${path.sep}`)) continue;
      if ((await fs.stat(media).catch(() => null))?.isFile()) committed.push(record.attempt);
    } catch {
      // Ignore a torn trailing record; durable earlier records remain discoverable.
    }
  }
  return committed;
}

export function actionEventIdForCheckpoint(
  command: ParsedCommand,
  ordinal: number,
  event: ActionTimelineEvent | null,
): string | null {
  return event ? `${command.step_id ?? "step"}:${ordinal}` : null;
}
