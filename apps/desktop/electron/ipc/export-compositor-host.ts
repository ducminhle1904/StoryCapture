import path from "node:path";

import { app, BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from "electron";

import identity from "../identity.json";
import { isDevRuntime } from "../runtime";
import {
  type ExportAssetAppPaths,
  type ExportGraphLike,
  resolveExportGraphAssets,
} from "./export-asset-runtime";

const EXPORT_COMPOSITOR_QUERY = "storycaptureExportCompositor";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_POLL_MS = 50;

const BRIDGE_READINESS_EXPRESSION = `(() => {
  const bridge = window.__STORYCAPTURE_EXPORT_COMPOSITOR__;
  const canvas = document.querySelector("canvas");
  const canvasRect = canvas?.getBoundingClientRect();
  const methods = bridge ? {
    configure: typeof bridge.configure === "function",
    renderFrame: typeof bridge.renderFrame === "function",
    dispose: typeof bridge.dispose === "function",
  } : null;
  return {
    ready: document.readyState === "complete" && Boolean(
      methods?.configure && methods?.renderFrame && methods?.dispose
    ),
    documentReadyState: document.readyState,
    hasRoot: Boolean(document.getElementById("root")),
    methods,
    viewport: {
      canvasBackingWidth: canvas?.width ?? 0,
      canvasBackingHeight: canvas?.height ?? 0,
      cssViewportWidth: canvasRect?.width ?? window.innerWidth,
      cssViewportHeight: canvasRect?.height ?? window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
  };
})()`;

export type ExportCompositorStartupStage =
  | "asset-resolution"
  | "renderer-load"
  | "bridge-readiness"
  | "configure";

export type ExportCompositorStartupErrorCode =
  | "asset-resolution-failed"
  | "renderer-load-failed"
  | "bridge-timeout"
  | "window-destroyed"
  | "configure-failed";

export class ExportCompositorStartupError extends Error {
  override readonly name = "ExportCompositorStartupError";

  constructor(
    readonly code: ExportCompositorStartupErrorCode,
    readonly stage: ExportCompositorStartupStage,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      message: this.message,
      details: this.details,
    };
  }
}

export class ExportCompositorFrameDimensionError extends Error {
  override readonly name = "ExportCompositorFrameDimensionError";
  readonly code = "frame-dimension-mismatch";
  readonly stage = "capture";

  constructor(readonly details: Record<string, number>) {
    super(
      `Export compositor frame dimensions do not match: expected ${details.expectedWidth}x${details.expectedHeight}, captured ${details.capturedWidth}x${details.capturedHeight} at DPR ${details.devicePixelRatio}`,
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      message: this.message,
      details: this.details,
    };
  }
}

export interface ExportCompositorViewport {
  canvasBackingWidth: number;
  canvasBackingHeight: number;
  cssViewportWidth: number;
  cssViewportHeight: number;
  devicePixelRatio: number;
}

export interface ExportCompositorHostPlan {
  graph: ExportGraphLike;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  durationMs: number;
  resamplingQuality?: "high" | "balanced" | "fast";
}

interface ExportCompositorApp extends ExportAssetAppPaths {
  isPackaged: boolean;
}

interface ReadinessProbe {
  ready: boolean;
  documentReadyState?: string;
  hasRoot?: boolean;
  methods?: Record<string, boolean> | null;
  viewport?: ExportCompositorViewport;
}

export interface WaitForExportCompositorReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface ExportCompositorHostOptions {
  app?: ExportCompositorApp;
  devRuntime?: boolean;
  devServerUrl?: string;
  startupTimeoutMs?: number;
  windowFactory?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

export interface ExportCompositorHost {
  readonly window: BrowserWindow;
  start(): Promise<void>;
  renderFrame(timeMs: number): Promise<Buffer>;
  dispose(): Promise<void>;
  isDestroyed(): boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupError(
  code: ExportCompositorStartupErrorCode,
  stage: ExportCompositorStartupStage,
  message: string,
  error: unknown,
  details: Record<string, unknown> = {},
): ExportCompositorStartupError {
  return new ExportCompositorStartupError(
    code,
    stage,
    message,
    { ...details, cause: errorMessage(error) },
    error instanceof Error ? { cause: error } : undefined,
  );
}

function createWindowOptions(plan: ExportCompositorHostPlan): BrowserWindowConstructorOptions {
  return {
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
  };
}

function normalizedDevicePixelRatio(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
}

export function exportCompositorViewportForOutput(
  outputWidth: number,
  outputHeight: number,
  devicePixelRatio: number,
): ExportCompositorViewport {
  const dpr = normalizedDevicePixelRatio(devicePixelRatio);
  return {
    canvasBackingWidth: outputWidth,
    canvasBackingHeight: outputHeight,
    cssViewportWidth: outputWidth / dpr,
    cssViewportHeight: outputHeight / dpr,
    devicePixelRatio: dpr,
  };
}

function viewportMatchesOutput(
  viewport: ExportCompositorViewport,
  plan: ExportCompositorHostPlan,
): boolean {
  return (
    viewport.canvasBackingWidth === plan.outputWidth &&
    viewport.canvasBackingHeight === plan.outputHeight &&
    Math.round(viewport.cssViewportWidth * viewport.devicePixelRatio) === plan.outputWidth &&
    Math.round(viewport.cssViewportHeight * viewport.devicePixelRatio) === plan.outputHeight
  );
}

export function exportCompositorRendererPath(appPath: string): string {
  return path.join(appPath, "dist", "index.html");
}

export async function loadExportCompositorRenderer(
  win: BrowserWindow,
  options: { appPath: string; devRuntime: boolean; devServerUrl: string },
): Promise<void> {
  if (options.devRuntime) {
    const url = new URL(options.devServerUrl);
    url.searchParams.set(EXPORT_COMPOSITOR_QUERY, "1");
    await win.loadURL(url.toString());
    return;
  }
  await win.loadFile(exportCompositorRendererPath(options.appPath), {
    query: { [EXPORT_COMPOSITOR_QUERY]: "1" },
  });
}

export async function waitForExportCompositorReady(
  win: BrowserWindow,
  options: WaitForExportCompositorReadyOptions = {},
): Promise<ReadinessProbe> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_READINESS_POLL_MS);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastProbe: ReadinessProbe | null = null;
  let lastProbeError: string | null = null;

  while (now() <= deadline) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new ExportCompositorStartupError(
        "window-destroyed",
        "bridge-readiness",
        "Export compositor window was destroyed before the renderer became ready",
        { attempts, lastProbe, lastProbeError },
      );
    }
    attempts += 1;
    try {
      lastProbe = (await win.webContents.executeJavaScript(
        BRIDGE_READINESS_EXPRESSION,
        true,
      )) as ReadinessProbe;
      lastProbeError = null;
      if (lastProbe?.ready) return lastProbe;
    } catch (error) {
      lastProbeError = errorMessage(error);
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  throw new ExportCompositorStartupError(
    "bridge-timeout",
    "bridge-readiness",
    `Export compositor renderer did not become ready within ${timeoutMs}ms`,
    { attempts, timeoutMs, lastProbe, lastProbeError },
  );
}

async function configureExportCompositor(
  win: BrowserWindow,
  plan: ExportCompositorHostPlan,
  graph: ExportGraphLike,
  viewport: ExportCompositorViewport,
): Promise<ExportCompositorViewport> {
  const payload = {
    graph,
    outputWidth: plan.outputWidth,
    outputHeight: plan.outputHeight,
    fps: plan.fps,
    durationMs: plan.durationMs,
    resamplingQuality: plan.resamplingQuality ?? "high",
    cssViewportWidth: viewport.cssViewportWidth,
    cssViewportHeight: viewport.cssViewportHeight,
  };
  const configured = (await win.webContents.executeJavaScript(
    `window.__STORYCAPTURE_EXPORT_COMPOSITOR__.configure(${JSON.stringify(payload)})`,
    true,
  )) as { viewport?: ExportCompositorViewport };
  if (!configured?.viewport) {
    throw new Error("export compositor configure handshake did not return viewport metrics");
  }
  return configured.viewport;
}

async function captureExportCompositorFrame(
  win: BrowserWindow,
  plan: ExportCompositorHostPlan,
  viewport: ExportCompositorViewport,
  timeMs: number,
): Promise<Buffer> {
  await win.webContents.executeJavaScript(
    `window.__STORYCAPTURE_EXPORT_COMPOSITOR__.renderFrame(${JSON.stringify(timeMs)})`,
    true,
  );
  const captureRect: Rectangle = {
    x: 0,
    y: 0,
    width: viewport.cssViewportWidth,
    height: viewport.cssViewportHeight,
  };
  const image = await win.webContents.capturePage(captureRect, { stayHidden: true });
  const size = image.getSize(1);
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  const expectedBytes = plan.outputWidth * plan.outputHeight * 4;
  if (
    size.width !== plan.outputWidth ||
    size.height !== plan.outputHeight ||
    bitmap.byteLength !== expectedBytes
  ) {
    throw new ExportCompositorFrameDimensionError({
      expectedWidth: plan.outputWidth,
      expectedHeight: plan.outputHeight,
      capturedWidth: size.width,
      capturedHeight: size.height,
      devicePixelRatio: viewport.devicePixelRatio,
      expectedBytes,
      capturedBytes: bitmap.byteLength,
    });
  }
  return bitmap;
}

export function createExportCompositorHost(
  plan: ExportCompositorHostPlan,
  options: ExportCompositorHostOptions = {},
): ExportCompositorHost {
  const runtimeApp = options.app ?? app;
  const devRuntime = options.devRuntime ?? isDevRuntime(runtimeApp);
  const devServerUrl =
    options.devServerUrl ?? process.env[identity.devServerUrlEnv] ?? identity.defaultDevServerUrl;
  const win = (options.windowFactory ?? ((windowOptions) => new BrowserWindow(windowOptions)))(
    createWindowOptions(plan),
  );
  win.webContents.setFrameRate(plan.fps);
  win.webContents.setZoomFactor(1);
  let started = false;
  let captureViewport: ExportCompositorViewport | null = null;

  return {
    window: win,
    async start() {
      let graph: ExportGraphLike;
      try {
        graph = await resolveExportGraphAssets(plan.graph, {
          app: runtimeApp,
          devRuntime,
        });
      } catch (error) {
        throw startupError(
          "asset-resolution-failed",
          "asset-resolution",
          "Export compositor could not resolve its assets",
          error,
        );
      }

      try {
        await loadExportCompositorRenderer(win, {
          appPath: runtimeApp.getAppPath(),
          devRuntime,
          devServerUrl,
        });
      } catch (error) {
        throw startupError(
          "renderer-load-failed",
          "renderer-load",
          "Export compositor renderer failed to load",
          error,
          { devRuntime },
        );
      }

      const readiness = await waitForExportCompositorReady(win, {
        timeoutMs: options.startupTimeoutMs,
      });
      try {
        let targetViewport = exportCompositorViewportForOutput(
          plan.outputWidth,
          plan.outputHeight,
          readiness.viewport?.devicePixelRatio ?? 1,
        );
        win.setContentSize(
          Math.ceil(targetViewport.cssViewportWidth),
          Math.ceil(targetViewport.cssViewportHeight),
        );
        let configuredViewport = await configureExportCompositor(win, plan, graph, targetViewport);
        if (configuredViewport.devicePixelRatio !== targetViewport.devicePixelRatio) {
          targetViewport = exportCompositorViewportForOutput(
            plan.outputWidth,
            plan.outputHeight,
            configuredViewport.devicePixelRatio,
          );
          win.setContentSize(
            Math.ceil(targetViewport.cssViewportWidth),
            Math.ceil(targetViewport.cssViewportHeight),
          );
          configuredViewport = await configureExportCompositor(win, plan, graph, targetViewport);
        }
        if (!viewportMatchesOutput(configuredViewport, plan)) {
          throw new Error(
            `export compositor viewport handshake does not match ${plan.outputWidth}x${plan.outputHeight}: ${JSON.stringify(configuredViewport)}`,
          );
        }
        captureViewport = configuredViewport;
      } catch (error) {
        throw startupError(
          "configure-failed",
          "configure",
          "Export compositor renderer failed during configuration",
          error,
        );
      }
      started = true;
    },
    async renderFrame(timeMs) {
      if (!started || !captureViewport || win.isDestroyed()) {
        throw new Error("export compositor host is not ready");
      }
      return captureExportCompositorFrame(win, plan, captureViewport, timeMs);
    },
    async dispose() {
      started = false;
      captureViewport = null;
      if (win.isDestroyed()) return;
      await win.webContents
        .executeJavaScript("window.__STORYCAPTURE_EXPORT_COMPOSITOR__?.dispose?.()", true)
        .catch(() => undefined);
      win.destroy();
    },
    isDestroyed() {
      return win.isDestroyed();
    },
  };
}
