import { spawn } from "node:child_process";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type Rectangle } from "electron";
import ffmpegPath from "ffmpeg-static";
import identity from "../../identity.json";
import { isDevRuntime } from "../../runtime";
import { type CompositedExportPlan, ffmpegArgsForExportPlan } from "./export-planning";
import type { RenderSession } from "./shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env[identity.devServerUrlEnv] ?? identity.defaultDevServerUrl;
const EXPORT_COMPOSITOR_QUERY = "storycaptureExportCompositor";

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

function createCompositorWindow(plan: CompositedExportPlan): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: plan.outputWidth,
    height: plan.outputHeight,
    backgroundColor: "#000000",
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(plan.fps);
  win.webContents.setZoomFactor(1);
  return win;
}

async function loadCompositorApp(win: BrowserWindow): Promise<void> {
  if (isDevRuntime(app)) {
    const url = new URL(devServerUrl);
    url.searchParams.set(EXPORT_COMPOSITOR_QUERY, "1");
    await win.loadURL(url.toString());
    return;
  }
  await win.loadFile(path.join(here, "..", "..", "..", "dist", "index.html"), {
    query: { [EXPORT_COMPOSITOR_QUERY]: "1" },
  });
}

async function waitForCompositorBridge(win: BrowserWindow): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await win.webContents
      .executeJavaScript("Boolean(window.__STORYCAPTURE_EXPORT_COMPOSITOR__)", true)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("export compositor renderer did not become ready");
}

async function configureCompositorWindow(
  win: BrowserWindow,
  plan: CompositedExportPlan,
): Promise<void> {
  const payload = {
    graph: plan.graph,
    outputWidth: plan.outputWidth,
    outputHeight: plan.outputHeight,
    fps: plan.fps,
    durationMs: plan.durationMs,
  };
  await win.webContents.executeJavaScript(
    `window.__STORYCAPTURE_EXPORT_COMPOSITOR__.configure(${JSON.stringify(payload)})`,
    true,
  );
}

async function renderCompositorFrame(
  win: BrowserWindow,
  plan: CompositedExportPlan,
  timeMs: number,
): Promise<Buffer> {
  await win.webContents.executeJavaScript(
    `window.__STORYCAPTURE_EXPORT_COMPOSITOR__.renderFrame(${JSON.stringify(timeMs)})`,
    true,
  );
  const captureRect: Rectangle = {
    x: 0,
    y: 0,
    width: plan.outputWidth,
    height: plan.outputHeight,
  };
  const image = await win.webContents.capturePage(captureRect);
  const size = image.getSize();
  const normalized =
    size.width === plan.outputWidth && size.height === plan.outputHeight
      ? image
      : image.resize({ width: plan.outputWidth, height: plan.outputHeight, quality: "best" });
  const bitmap = normalized.toBitmap();
  const expectedBytes = plan.outputWidth * plan.outputHeight * 4;
  if (bitmap.byteLength !== expectedBytes) {
    throw new Error(
      `export compositor captured ${bitmap.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  return bitmap;
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
      stderr += text;
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
  outputPath: string,
  onProgress: (frame: number) => void,
): Promise<void> {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");

  const win = createCompositorWindow(plan);
  const child = spawn(binary, ffmpegArgsForExportPlan(plan, outputPath), {
    stdio: ["pipe", "ignore", "pipe"],
  });
  session.ffmpegProcess = child;
  session.cancelCompositedExport = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  const ffmpegDone = waitForFfmpeg(session, child, onProgress);

  try {
    await loadCompositorApp(win);
    await waitForCompositorBridge(win);
    await configureCompositorWindow(win, plan);

    for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex += 1) {
      if (session.cancelRequested) throw new Error("render cancelled");
      const timeMs = Math.min(plan.durationMs, compositedFrameTimeMs(frameIndex, plan.fps));
      const frame = await renderCompositorFrame(win, plan, timeMs);
      await writeFrameWithBackpressure(child.stdin, frame);
      session.frame = frameIndex + 1;
      session.job.progress_pct = Math.min(
        99,
        Math.max(5, Math.round((session.frame / plan.frameCount) * 95)),
      );
      onProgress(session.frame);
    }

    child.stdin.end();
    await ffmpegDone;
  } catch (error) {
    child.stdin.destroy();
    if (!session.cancelRequested) child.kill("SIGKILL");
    await ffmpegDone.catch(() => undefined);
    throw error;
  } finally {
    session.ffmpegProcess = null;
    session.cancelCompositedExport = null;
    if (!win.isDestroyed()) {
      await win.webContents
        .executeJavaScript("window.__STORYCAPTURE_EXPORT_COMPOSITOR__?.dispose?.()", true)
        .catch(() => undefined);
      win.destroy();
    }
  }
}
