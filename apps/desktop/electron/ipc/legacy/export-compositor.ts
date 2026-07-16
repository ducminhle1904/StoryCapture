import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { exportFfmpegPath } from "../export-binaries";
import { createExportCompositorHost } from "../export-compositor-host";
import type { CompositedExportPlan } from "./export-planning";
import type { RenderSession } from "./shared";

export interface CompositedExportRuntimeDependencies {
  createHost?: typeof createExportCompositorHost;
  ffmpegPath?: () => string;
  spawnProcess?: typeof spawn;
}

export function compositedFrameTimeMs(frameIndex: number, fps: number): number {
  return (Math.max(0, frameIndex) / Math.max(1, fps)) * 1000;
}

export async function writeFrameWithBackpressure(stream: Writable, frame: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("ffmpeg stdin is closed");
  }
  if (stream.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", handleDrain);
      stream.off("error", handleError);
      stream.off("close", handleClose);
      stream.off("finish", handleClose);
    };
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("ffmpeg stdin closed before drain"));
    };
    stream.once("drain", handleDrain);
    stream.once("error", handleError);
    stream.once("close", handleClose);
    stream.once("finish", handleClose);
  });
}

function waitForFfmpeg(
  session: RenderSession,
  child: ReturnType<typeof spawn>,
  onProgress: (frame: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-8_000);
      const frame = text.match(/frame=\s*(\d+)/);
      if (frame?.[1]) {
        session.frame = Math.max(session.frame, Number(frame[1]));
        session.job.progress_pct = Math.max(session.job.progress_pct, 5);
        onProgress(session.frame);
      }
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
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

export async function runCompositedExportForRenderSession(
  session: RenderSession,
  plan: CompositedExportPlan,
  onProgress: (frame: number) => void,
  ffmpegArgs: string[],
  onFramesComplete: () => void = () => undefined,
  dependencies: CompositedExportRuntimeDependencies = {},
): Promise<void> {
  const binary = (dependencies.ffmpegPath ?? exportFfmpegPath)();

  const compositor = (dependencies.createHost ?? createExportCompositorHost)({
    ...plan,
    resamplingQuality: plan.encoderOptions.resamplingQuality,
  });
  let child: ReturnType<typeof spawn> | null = null;
  let ffmpegDone: Promise<void> | null = null;
  session.cancelCompositedExport = () => {
    if (!compositor.isDestroyed()) compositor.window.destroy();
  };

  try {
    await compositor.start();
    if (session.cancelRequested) throw new Error("render cancelled");
    child = (dependencies.spawnProcess ?? spawn)(binary, ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const ffmpegInput = child.stdin;
    if (!ffmpegInput) throw new Error("ffmpeg stdin is unavailable");
    session.ffmpegProcess = child;
    ffmpegDone = waitForFfmpeg(session, child, onProgress);
    // Attach a rejection handler immediately; frame capture may still be in
    // flight when a spawn/runtime error closes FFmpeg.
    void ffmpegDone.catch(() => undefined);

    for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex += 1) {
      if (session.cancelRequested) throw new Error("render cancelled");
      const timeMs = Math.min(plan.durationMs, compositedFrameTimeMs(frameIndex, plan.fps));
      const frame = await compositor.renderFrame(timeMs);
      await writeFrameWithBackpressure(ffmpegInput, frame);
      session.frame = frameIndex + 1;
      session.job.phase_progress_pct = Math.min(
        100,
        Math.max(0, Math.round((session.frame / plan.frameCount) * 100)),
      );
      session.job.progress_pct = Math.min(85, 5 + Math.round(session.job.phase_progress_pct * 0.8));
      onProgress(session.frame);
    }

    ffmpegInput.end();
    onFramesComplete();
    await ffmpegDone;
  } catch (error) {
    child?.stdin?.destroy();
    if (child && !session.cancelRequested) child.kill("SIGKILL");
    await ffmpegDone?.catch(() => undefined);
    throw error;
  } finally {
    session.ffmpegProcess = null;
    session.cancelCompositedExport = null;
    await compositor.dispose();
  }
}
