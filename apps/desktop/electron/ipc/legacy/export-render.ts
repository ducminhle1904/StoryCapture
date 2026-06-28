import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import slugify from "@sindresorhus/slugify";
import type { WebContents } from "electron";
import ffmpegPath from "ffmpeg-static";
import { clampFps } from "./capture-preview";
import { runCompositedExportForRenderSession } from "./export-compositor";
import {
  analyzeExportPlan,
  ffmpegArgsForExportPlan,
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

export {
  analyzeExportPlan,
  ffmpegArgsForExportOutput,
  ffmpegArgsForExportPlan,
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

export function runFfmpegForRenderSession(
  session: RenderSession,
  ffmpegArgs: string[],
): Promise<void> {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ffmpegArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    session.ffmpegProcess = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      stderr += text;
      const frame = text.match(/frame=\s*(\d+)/);
      if (frame?.[1]) {
        session.frame = Number(frame[1]);
        session.job.progress_pct = Math.max(session.job.progress_pct, 5);
        broadcastRenderProgress(session.job, session.frame);
      }
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      session.ffmpegProcess = null;
      if (session.cancelRequested) {
        reject(new Error("render cancelled"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export function scheduleRenderSessionRemoval(id: string): void {
  setTimeout(() => renderSessions.delete(id), 5000).unref?.();
}

export function enqueueExportRenderJob(args: {
  batchId: string;
  storyId: string;
  output: ExportOutput;
  plan: RunnableExportPlan;
  outputPath: string;
  presetId?: string | null;
  priority?: number;
}): string {
  const id = randomUUID();
  const now = Date.now();
  const renderJob: RenderJob = {
    id,
    story_id: args.storyId,
    preset_id: args.presetId ?? null,
    format: args.output.format,
    resolution: args.output.resolution,
    fps: clampFps(args.output.fps),
    quality: args.output.quality,
    priority: Number.isFinite(Number(args.priority)) ? Number(args.priority) : 0,
    batch_id: args.batchId,
    output_width: args.output.output_width ?? (args.plan.kind === "composited" ? args.plan.outputWidth : null),
    output_height: args.output.output_height ?? (args.plan.kind === "composited" ? args.plan.outputHeight : null),
    encoder_options_json: JSON.stringify(
      (args.output as { encoder_options?: unknown }).encoder_options ?? null,
    ),
    status: "running",
    progress_pct: 0,
    started_at: now,
    completed_at: null,
    error: null,
    output_path: args.outputPath,
    created_at: now,
  };
  const session: RenderSession = {
    job: renderJob,
    timer: null,
    frame: 0,
    ffmpegProcess: null,
    cancelCompositedExport: null,
    cancelRequested: false,
  };
  renderSessions.set(id, session);
  broadcastRenderProgress(renderJob, 0);

  void (async () => {
    try {
      renderJob.progress_pct = 5;
      broadcastRenderProgress(renderJob, session.frame);
      if (args.plan.kind === "composited") {
        await runCompositedExportForRenderSession(
          session,
          args.plan,
          args.outputPath,
          (frame) => broadcastRenderProgress(renderJob, frame),
        );
      } else {
        await runFfmpegForRenderSession(
          session,
          ffmpegArgsForExportPlan(args.plan, args.outputPath),
        );
      }
      renderJob.status = "completed";
      renderJob.progress_pct = 100;
    } catch (error) {
      renderJob.status = session.cancelRequested ? "cancelled" : "failed";
      renderJob.error = error instanceof Error ? error.message : String(error);
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
  })();
  return id;
}

export async function exportRun(args: ExportRunArgs) {
  if (!args.outputs.length) throw new Error("export requires at least one output");
  const plannedOutputs = args.outputs.map((output) => {
    const plan = analyzeExportPlan(args.graph_json, output);
    if (plan.kind === "unsupported") {
      throw new Error(`${output.format} export is unsupported: ${plan.reason}`);
    }
    return { output, plan };
  });
  await fs.mkdir(args.output_folder, { recursive: true });
  const batchId = randomUUID();
  const snapshotPath = path.join(
    args.output_folder,
    `${slugify(args.base_name || args.story_id || "export") || "export"}.graph.json`,
  );
  await fs.writeFile(snapshotPath, args.graph_json, "utf8");
  const jobIds: string[] = [];

  for (const [index, { output, plan }] of plannedOutputs.entries()) {
    const out = exportOutputPath(args, output, index);
    jobIds.push(
      enqueueExportRenderJob({
        batchId,
        storyId: args.story_id,
        output,
        plan,
        outputPath: out,
        presetId: args.preset_id,
        priority: args.priority,
      }),
    );
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
    pct: job.progress_pct,
    frame,
    fps: job.fps,
    speed: 1,
    eta_ms: Math.max(0, Math.round((100 - job.progress_pct) * 100)),
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
  if (session) {
    if (session.timer) clearInterval(session.timer);
    session.cancelRequested = true;
    session.ffmpegProcess?.kill("SIGKILL");
    session.cancelCompositedExport?.();
    session.job.status = "cancelled";
    session.job.completed_at = Date.now();
    broadcastRenderProgress(session.job, session.frame);
    renderSessions.delete(jobId);
  }
  return null;
}

export function renderListActive(storyId: string): RenderJob[] {
  return [...renderSessions.values()]
    .map((session) => session.job)
    .filter(
      (job) => job.story_id === storyId && job.status !== "completed" && job.status !== "cancelled",
    )
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
