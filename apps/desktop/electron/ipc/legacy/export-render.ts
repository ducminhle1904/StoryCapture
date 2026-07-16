import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import slugify from "@sindresorhus/slugify";
import type { ExportCompositionGraphV4, ExportJobStatus } from "@storycapture/shared-types";
import type { WebContents } from "electron";
import { clampFps } from "./capture-preview";
import { sourceHasAudio, verifyExportArtifact } from "./export-artifact-verification";
import { buildExportAudioPlan } from "./export-audio-planning";
import { runCompositedExportForRenderSession } from "./export-compositor";
import {
  commitExportOutput,
  type ExportOutputReservation,
  prepareExportOutputFolder,
  releaseExportOutput,
  reserveExportOutputPath,
} from "./export-output-lifecycle";
import {
  analyzeExportPlan,
  ffmpegArgsForCanonicalExportPlan,
  normalizeExportEncoderOptions,
  type RunnableExportPlan,
} from "./export-planning";
import {
  channelIdFrom,
  type ExportOutput,
  type ExportRunArgs,
  type RenderJob,
  type RenderProgressListener,
  type RenderSession,
  renderProgressListeners,
  renderSessions,
  sendChannel,
} from "./shared";

// Electron's main bundle externalizes workspace packages, so runtime values at
// this boundary must remain local even when their type contract is shared.
const ACTIVE_EXPORT_JOB_STATUSES: readonly ExportJobStatus[] = [
  "queued",
  "rendering",
  "mixing",
  "verifying",
];

const EXPORT_SCHEDULER_CAPACITY = 2;
const ONE_UNIT_MAX_PIXELS = 2560 * 1440;

interface EnqueueExportRenderJobArgs {
  id?: string;
  batchId: string;
  storyId: string;
  output: ExportOutput;
  plan: RunnableExportPlan;
  outputReservation: ExportOutputReservation;
  probeSourceAudio?: (path: string) => Promise<boolean>;
  presetId?: string | null;
  priority?: number;
}

interface QueuedExportRenderJob {
  args: EnqueueExportRenderJobArgs;
  id: string;
  sequence: number;
  session: RenderSession;
  weight: number;
}

const queuedExportRenderJobs = new Map<string, QueuedExportRenderJob>();
const activeExportRenderJobWeights = new Map<string, number>();
let nextExportRenderJobSequence = 0;
let exportSchedulerWakePending = false;

export {
  analyzeExportPlan,
  firstSourcePath,
  normalizeExportEncoderOptions,
  resolutionSize,
  unsupportedExportGraphNodes,
  validateExportOutput,
} from "./export-planning";

export function exportOutputPath(args: ExportRunArgs, output: ExportOutput, index: number): string {
  const ext = output.format.toLowerCase();
  const base = slugify(args.base_name || args.story_id || "export") || "export";
  const suffix = args.outputs.length > 1 ? `-${index + 1}-${output.resolution}` : "";
  return path.join(args.output_folder, `${base}${suffix}.${ext}`);
}

export function scheduleRenderSessionRemoval(id: string): void {
  setTimeout(() => renderSessions.delete(id), 15_000).unref?.();
}

function createRenderJob(args: {
  id: string;
  batchId: string;
  storyId: string;
  output: ExportOutput;
  plan: RunnableExportPlan | null;
  outputPath: string | null;
  presetId?: string | null;
  priority?: number;
}): RenderJob {
  const now = Date.now();
  return {
    id: args.id,
    story_id: args.storyId,
    preset_id: args.presetId ?? null,
    format: args.output.format,
    resolution: args.output.resolution,
    fps: clampFps(args.output.fps),
    quality: args.output.quality,
    priority: Number.isFinite(Number(args.priority)) ? Number(args.priority) : 0,
    batch_id: args.batchId,
    output_width:
      args.output.output_width ?? (args.plan?.kind === "composited" ? args.plan.outputWidth : null),
    output_height:
      args.output.output_height ??
      (args.plan?.kind === "composited" ? args.plan.outputHeight : null),
    encoder_options_json: JSON.stringify(args.output.encoder_options ?? null),
    status: "queued",
    progress_pct: 0,
    phase_progress_pct: 0,
    started_at: null,
    completed_at: null,
    error: null,
    output_path: args.outputPath,
    created_at: now,
  };
}

function createRenderSession(
  job: RenderJob,
  outputReservation: ExportOutputReservation | null,
): RenderSession {
  return {
    job,
    timer: null,
    frame: 0,
    ffmpegProcess: null,
    cancelCompositedExport: null,
    cancelRequested: false,
    outputReservation,
  };
}

function setJobPhase(
  session: RenderSession,
  status: ExportJobStatus,
  progressPct: number,
  phaseProgressPct: number,
): void {
  session.job.status = status;
  session.job.progress_pct = Math.max(0, Math.min(100, Math.round(progressPct)));
  session.job.phase_progress_pct = Math.max(0, Math.min(100, Math.round(phaseProgressPct)));
  broadcastRenderProgress(session.job, session.frame);
}

function graphSourceNodes(graph: ExportCompositionGraphV4) {
  return graph.video.filter((node) => node.type === "source");
}

function exportRenderJobWeight(plan: RunnableExportPlan): number {
  return plan.outputWidth * plan.outputHeight <= ONE_UNIT_MAX_PIXELS ? 1 : 2;
}

function queuedExportRenderJobsInOrder(): QueuedExportRenderJob[] {
  return [...queuedExportRenderJobs.values()].sort(
    (a, b) => b.session.job.priority - a.session.job.priority || a.sequence - b.sequence,
  );
}

function refreshQueuedExportJobPositions(shouldBroadcast: boolean): void {
  for (const [index, queued] of queuedExportRenderJobsInOrder().entries()) {
    const queuePosition = index + 1;
    if (queued.session.job.queue_position === queuePosition) continue;
    queued.session.job.queue_position = queuePosition;
    if (shouldBroadcast) {
      broadcastRenderProgress(queued.session.job, queued.session.frame);
    }
  }
}

function activeExportRenderUnits(): number {
  let units = 0;
  for (const weight of activeExportRenderJobWeights.values()) units += weight;
  return units;
}

function wakeExportRenderScheduler(): void {
  if (exportSchedulerWakePending) return;
  exportSchedulerWakePending = true;
  queueMicrotask(() => {
    exportSchedulerWakePending = false;
    startReadyExportRenderJobs();
  });
}

async function executeExportRenderJob(queued: QueuedExportRenderJob): Promise<void> {
  const { args, id, session } = queued;
  const renderJob = session.job;

  try {
    if (session.cancelRequested) throw new Error("render cancelled");
    if (args.plan.kind !== "composited") {
      throw new Error("canonical export received a retired non-composited plan");
    }
    renderJob.started_at = Date.now();
    setJobPhase(session, "rendering", 5, 0);
    const graph = args.plan.graph as unknown as ExportCompositionGraphV4;
    const sourceAudio =
      args.output.format === "gif"
        ? {}
        : Object.fromEntries(
            await Promise.all(
              graphSourceNodes(graph).map(
                async (source) =>
                  [
                    source.id,
                    await (args.probeSourceAudio ?? sourceHasAudio)(source.path),
                  ] as const,
              ),
            ),
          );
    if (session.cancelRequested) throw new Error("render cancelled");
    const normalized = normalizeExportEncoderOptions(args.output);
    const audioPlan = buildExportAudioPlan({
      graph,
      output:
        args.output.format === "gif"
          ? { format: "gif" }
          : {
              format: args.output.format as "mp4" | "webm",
              bitrateKbps: normalized.audio?.bitrateKbps ?? 160,
              channels: normalized.audio?.channels ?? 2,
              sampleRateHz: normalized.audio?.sampleRateHz ?? 48_000,
            },
      sourceAudio,
    });
    if (audioPlan.kind === "invalid") {
      throw new Error(audioPlan.diagnostics.map((issue) => issue.message).join("; "));
    }
    const ffmpegArgs = ffmpegArgsForCanonicalExportPlan(
      args.plan,
      audioPlan,
      args.outputReservation.tempPath,
    );
    await runCompositedExportForRenderSession(
      session,
      args.plan,
      (frame) => broadcastRenderProgress(renderJob, frame),
      ffmpegArgs,
      () => setJobPhase(session, "mixing", 86, 0),
    );
    if (session.cancelRequested) throw new Error("render cancelled");
    setJobPhase(session, "mixing", 92, 100);
    setJobPhase(session, "verifying", 94, 0);
    await verifyExportArtifact(args.outputReservation.tempPath, {
      format: args.output.format as "mp4" | "webm" | "gif",
      width: args.plan.outputWidth,
      height: args.plan.outputHeight,
      fps: args.plan.fps,
      durationMs: args.plan.durationMs,
      expectAudio: audioPlan.kind === "mixed",
    });
    if (session.cancelRequested) throw new Error("render cancelled");
    setJobPhase(session, "verifying", 99, 100);
    await commitExportOutput(args.outputReservation);
    session.outputReservation = null;
    setJobPhase(session, "completed", 100, 100);
  } catch (error) {
    if (session.outputReservation) {
      await releaseExportOutput(session.outputReservation).catch(() => undefined);
      session.outputReservation = null;
    }
    renderJob.status = session.cancelRequested ? "cancelled" : "failed";
    renderJob.error = session.cancelRequested
      ? "Export cancelled. Partial output was removed."
      : error instanceof Error
        ? error.message
        : String(error);
    if (renderJob.status === "failed") {
      console.error("[export-render] render job failed", {
        jobId: renderJob.id,
        outputPath: renderJob.output_path,
        error: renderJob.error,
      });
    }
  } finally {
    renderJob.completed_at = Date.now();
    broadcastRenderProgress(renderJob, session.frame);
    scheduleRenderSessionRemoval(id);
  }
}

function startReadyExportRenderJobs(): void {
  while (true) {
    const next = queuedExportRenderJobsInOrder()[0];
    if (!next) return;
    if (activeExportRenderUnits() + next.weight > EXPORT_SCHEDULER_CAPACITY) return;

    queuedExportRenderJobs.delete(next.id);
    activeExportRenderJobWeights.set(next.id, next.weight);
    next.session.job.queue_position = null;
    refreshQueuedExportJobPositions(true);
    void executeExportRenderJob(next).finally(() => {
      activeExportRenderJobWeights.delete(next.id);
      wakeExportRenderScheduler();
    });
  }
}

export function enqueueExportRenderJob(args: EnqueueExportRenderJobArgs): string {
  const id = args.id ?? randomUUID();
  const renderJob = createRenderJob({
    ...args,
    id,
    outputPath: args.outputReservation.finalPath,
  });
  const session = createRenderSession(renderJob, args.outputReservation);
  renderSessions.set(id, session);
  queuedExportRenderJobs.set(id, {
    args,
    id,
    sequence: nextExportRenderJobSequence++,
    session,
    weight: exportRenderJobWeight(args.plan),
  });
  refreshQueuedExportJobPositions(true);
  wakeExportRenderScheduler();
  return id;
}

export async function exportRun(args: ExportRunArgs) {
  if (!args.outputs.length) throw new Error("export requires at least one output");
  await prepareExportOutputFolder(args.output_folder);
  const batchId = randomUUID();
  const snapshotPath = path.join(
    args.output_folder,
    `${slugify(args.base_name || args.story_id || "export") || "export"}.${batchId}.graph.json`,
  );
  await fs.writeFile(snapshotPath, args.graph_json, "utf8");
  const jobIds: string[] = [];
  const sourceProbeCache = new Map<string, Promise<boolean>>();
  const probeSourceAudio = (sourcePath: string) => {
    const cached = sourceProbeCache.get(sourcePath);
    if (cached) return cached;
    const pending = sourceHasAudio(sourcePath);
    sourceProbeCache.set(sourcePath, pending);
    return pending;
  };

  for (const [index, output] of args.outputs.entries()) {
    const id = randomUUID();
    jobIds.push(id);
    const plan = analyzeExportPlan(args.graph_json, output);
    if (plan.kind === "unsupported") {
      const job = createRenderJob({
        id,
        batchId,
        storyId: args.story_id,
        output,
        plan: null,
        outputPath: null,
        presetId: args.preset_id,
        priority: args.priority,
      });
      job.status = "failed";
      job.error = `${output.format} export is unsupported: ${plan.reason}`;
      job.completed_at = Date.now();
      const session = createRenderSession(job, null);
      renderSessions.set(id, session);
      broadcastRenderProgress(job, 0);
      scheduleRenderSessionRemoval(id);
      continue;
    }
    try {
      const outputReservation = await reserveExportOutputPath(
        exportOutputPath(args, output, index),
        id,
      );
      enqueueExportRenderJob({
        id,
        batchId,
        storyId: args.story_id,
        output,
        plan,
        outputReservation,
        probeSourceAudio,
        presetId: args.preset_id,
        priority: args.priority,
      });
    } catch (error) {
      const job = createRenderJob({
        id,
        batchId,
        storyId: args.story_id,
        output,
        plan,
        outputPath: null,
        presetId: args.preset_id,
        priority: args.priority,
      });
      job.status = "failed";
      job.error = `Could not reserve export output: ${error instanceof Error ? error.message : String(error)}`;
      job.completed_at = Date.now();
      const session = createRenderSession(job, null);
      renderSessions.set(id, session);
      broadcastRenderProgress(job, 0);
      scheduleRenderSessionRemoval(id);
    }
  }

  return {
    batch_id: batchId,
    job_ids: jobIds,
    graph_snapshot_path: snapshotPath,
  };
}

export function renderProgress(job: RenderJob, frame: number) {
  return {
    job_id: job.id,
    status: job.status,
    pct: job.progress_pct,
    phase_pct: job.phase_progress_pct,
    frame,
    fps: job.fps,
    speed: 1,
    eta_ms: Math.max(0, Math.round((100 - job.progress_pct) * 100)),
    queue_position: job.status === "queued" ? (job.queue_position ?? null) : null,
  };
}

export function broadcastRenderProgress(job: RenderJob, frame: number): void {
  const progress = renderProgress(job, frame);
  for (const listener of renderProgressListeners) {
    if (listener.sender.isDestroyed()) {
      renderProgressListeners.delete(listener);
      continue;
    }
    sendChannel(listener.sender, listener.channelId, progress);
  }
}

export function renderEnqueue(rawJob: unknown): string {
  void rawJob;
  throw new Error(
    "render_enqueue is no longer a fake timer queue; call export_run with graph_json",
  );
}

export function renderCancel(jobId: string): null {
  const session = renderSessions.get(jobId);
  if (session?.job.status === "queued" && queuedExportRenderJobs.delete(jobId)) {
    session.cancelRequested = true;
    session.job.status = "cancelled";
    session.job.queue_position = null;
    session.job.error = "Export cancelled. Partial output is being removed.";
    session.job.completed_at = Date.now();
    const outputReservation = session.outputReservation;
    if (outputReservation) {
      void releaseExportOutput(outputReservation)
        .catch(() => undefined)
        .finally(() => {
          if (session.outputReservation === outputReservation) {
            session.outputReservation = null;
          }
        });
    }
    broadcastRenderProgress(session.job, session.frame);
    refreshQueuedExportJobPositions(true);
    scheduleRenderSessionRemoval(jobId);
    wakeExportRenderScheduler();
    return null;
  }
  if (session && ACTIVE_EXPORT_JOB_STATUSES.includes(session.job.status)) {
    if (session.timer) clearInterval(session.timer);
    session.cancelRequested = true;
    session.ffmpegProcess?.kill("SIGKILL");
    session.cancelCompositedExport?.();
    session.job.status = "cancelled";
    session.job.error = "Export cancelled. Partial output is being removed.";
    broadcastRenderProgress(session.job, session.frame);
  }
  return null;
}

export function renderListActive(storyId: string): RenderJob[] {
  return [...renderSessions.values()]
    .map((session) => session.job)
    .filter((job) => job.story_id === storyId)
    .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
}

export function streamRenderProgress(args: unknown, sender: WebContents): null {
  const listener: RenderProgressListener = {
    sender,
    channelId: channelIdFrom((args as { channel?: unknown } | undefined)?.channel),
  };
  renderProgressListeners.add(listener);
  sender.once("destroyed", () => {
    renderProgressListeners.delete(listener);
  });
  for (const session of renderSessions.values()) {
    sendChannel(sender, listener.channelId, renderProgress(session.job, session.frame));
  }
  return null;
}
