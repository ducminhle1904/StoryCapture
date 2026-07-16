import path from "node:path";

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  createExportCompositorHost,
  ExportCompositorFrameDimensionError,
  ExportCompositorStartupError,
  exportCompositorRendererPath,
  exportCompositorViewportForOutput,
  loadExportCompositorRenderer,
  waitForExportCompositorReady,
} from "./export-compositor-host";

function fakeWindow(
  options: {
    executeJavaScript?: (source: string) => Promise<unknown>;
    loadFile?: (filePath: string, options?: unknown) => Promise<void>;
    loadURL?: (url: string) => Promise<void>;
    destroyed?: boolean;
    devicePixelRatio?: number;
    imageWidth?: number;
    imageHeight?: number;
    bitmapBytes?: number;
    toBitmap?: (options?: { scaleFactor?: number }) => Buffer;
  } = {},
): BrowserWindow {
  const imageWidth = options.imageWidth ?? 2;
  const imageHeight = options.imageHeight ?? 2;
  const bitmap = Buffer.alloc(options.bitmapBytes ?? imageWidth * imageHeight * 4);
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    destroy: vi.fn(),
    loadFile: vi.fn(options.loadFile ?? (async () => undefined)),
    loadURL: vi.fn(options.loadURL ?? (async () => undefined)),
    setContentSize: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => options.destroyed ?? false),
      setFrameRate: vi.fn(),
      setZoomFactor: vi.fn(),
      executeJavaScript: vi.fn(
        options.executeJavaScript ??
          (async (source: string) => {
            const devicePixelRatio = options.devicePixelRatio ?? 1;
            if (source.includes("const bridge")) {
              return {
                ready: true,
                documentReadyState: "complete",
                hasRoot: true,
                methods: { configure: true, renderFrame: true, dispose: true },
                viewport: {
                  canvasBackingWidth: 300,
                  canvasBackingHeight: 150,
                  cssViewportWidth: 2,
                  cssViewportHeight: 2,
                  devicePixelRatio,
                },
              };
            }
            const configurePrefix = "window.__STORYCAPTURE_EXPORT_COMPOSITOR__.configure(";
            if (source.startsWith(configurePrefix)) {
              const payload = JSON.parse(source.slice(configurePrefix.length, -1)) as {
                outputWidth: number;
                outputHeight: number;
                cssViewportWidth: number;
                cssViewportHeight: number;
              };
              return {
                ok: true,
                viewport: {
                  canvasBackingWidth: payload.outputWidth,
                  canvasBackingHeight: payload.outputHeight,
                  cssViewportWidth: payload.cssViewportWidth,
                  cssViewportHeight: payload.cssViewportHeight,
                  devicePixelRatio,
                },
              };
            }
            return { ok: true };
          }),
      ),
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: imageWidth, height: imageHeight }),
        toBitmap: vi.fn(options.toBitmap ?? (() => bitmap)),
      })),
    },
  } as unknown as BrowserWindow;
}

const plan = {
  graph: { video: [] },
  outputWidth: 2,
  outputHeight: 2,
  fps: 30,
  durationMs: 100,
  resamplingQuality: "high" as const,
};

const runtimeApp = {
  isPackaged: true,
  getAppPath: () => "/mock/app.asar",
  getPath: (_name: "userData") => "/mock/user-data",
};

describe("export compositor production bootstrap", () => {
  it("loads the built renderer with loadFile and the compositor query", async () => {
    const win = fakeWindow();

    await loadExportCompositorRenderer(win, {
      appPath: "/mock/app.asar",
      devRuntime: false,
      devServerUrl: "http://127.0.0.1:1420",
    });

    expect(win.loadFile).toHaveBeenCalledWith(path.join("/mock/app.asar", "dist", "index.html"), {
      query: { storycaptureExportCompositor: "1" },
    });
    expect(exportCompositorRendererPath("/mock/app.asar")).toBe(
      path.join("/mock/app.asar", "dist", "index.html"),
    );
  });

  it("loads the dev renderer with the same compositor query", async () => {
    const win = fakeWindow();

    await loadExportCompositorRenderer(win, {
      appPath: "/mock/app",
      devRuntime: true,
      devServerUrl: "http://127.0.0.1:1420/base?existing=1",
    });

    expect(win.loadURL).toHaveBeenCalledWith(
      "http://127.0.0.1:1420/base?existing=1&storycaptureExportCompositor=1",
    );
  });

  it("waits for the full bridge method handshake", async () => {
    let timeMs = 0;
    const probes = [
      { ready: false, documentReadyState: "complete", hasRoot: true, methods: null },
      {
        ready: true,
        documentReadyState: "complete",
        hasRoot: true,
        methods: { configure: true, renderFrame: true, dispose: true },
      },
    ];
    const win = fakeWindow({ executeJavaScript: async () => probes.shift() });

    await expect(
      waitForExportCompositorReady(win, {
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => timeMs,
        sleep: async (delay) => {
          timeMs += delay;
        },
      }),
    ).resolves.toMatchObject({ ready: true });
  });

  it("returns a structured timeout with the last readiness probe", async () => {
    let timeMs = 0;
    const win = fakeWindow({
      executeJavaScript: async () => ({
        ready: false,
        documentReadyState: "complete",
        hasRoot: true,
        methods: { configure: false, renderFrame: false, dispose: false },
      }),
    });

    const readiness = waitForExportCompositorReady(win, {
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => timeMs,
      sleep: async (delay) => {
        timeMs += delay;
      },
    });

    await expect(readiness).rejects.toMatchObject({
      name: "ExportCompositorStartupError",
      code: "bridge-timeout",
      stage: "bridge-readiness",
      details: { timeoutMs: 20 },
    });
  });

  it("reports renderer load failures as structured startup errors", async () => {
    const win = fakeWindow({
      loadFile: async () => {
        throw new Error("ERR_FILE_NOT_FOUND");
      },
    });
    const host = createExportCompositorHost(plan, {
      app: runtimeApp,
      devRuntime: false,
      windowFactory: () => win,
    });

    await expect(host.start()).rejects.toMatchObject({
      code: "renderer-load-failed",
      stage: "renderer-load",
      details: { cause: "ERR_FILE_NOT_FOUND" },
    });
  });

  it("configures, renders, and disposes a ready hidden compositor", async () => {
    const win = fakeWindow();
    const host = createExportCompositorHost(plan, {
      app: runtimeApp,
      devRuntime: false,
      windowFactory: () => win,
    });

    await host.start();
    await expect(host.renderFrame(50)).resolves.toHaveLength(16);
    await host.dispose();

    expect(win.webContents.setFrameRate).toHaveBeenCalledWith(30);
    expect(win.setContentSize).toHaveBeenCalledWith(2, 2);
    expect(
      vi
        .mocked(win.webContents.executeJavaScript)
        .mock.calls.some(
          ([source]) =>
            source.includes(".configure(") && source.includes('"resamplingQuality":"high"'),
        ),
    ).toBe(true);
    expect(win.webContents.capturePage).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 2, height: 2 },
      { stayHidden: true },
    );
    const image = await vi.mocked(win.webContents.capturePage).mock.results[0]?.value;
    expect(image?.toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 });
    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    1, 1.25, 1.5, 2,
  ])("derives exact backing and CSS capture geometry at DPR %s", async (devicePixelRatio) => {
    const outputWidth = 62;
    const outputHeight = 37;
    const framePlan = { ...plan, outputWidth, outputHeight };
    const win = fakeWindow({
      devicePixelRatio,
      imageWidth: outputWidth,
      imageHeight: outputHeight,
    });
    const host = createExportCompositorHost(framePlan, {
      app: runtimeApp,
      devRuntime: false,
      windowFactory: () => win,
    });

    const viewport = exportCompositorViewportForOutput(outputWidth, outputHeight, devicePixelRatio);
    expect(Math.round(viewport.cssViewportWidth * devicePixelRatio)).toBe(outputWidth);
    expect(Math.round(viewport.cssViewportHeight * devicePixelRatio)).toBe(outputHeight);

    await host.start();
    await expect(host.renderFrame(25)).resolves.toHaveLength(outputWidth * outputHeight * 4);
    expect(win.setContentSize).toHaveBeenCalledWith(
      Math.ceil(outputWidth / devicePixelRatio),
      Math.ceil(outputHeight / devicePixelRatio),
    );
    expect(win.webContents.capturePage).toHaveBeenCalledWith(
      {
        x: 0,
        y: 0,
        width: outputWidth / devicePixelRatio,
        height: outputHeight / devicePixelRatio,
      },
      { stayHidden: true },
    );
    await host.dispose();
  });

  it("fails with structured dimensions instead of silently resizing", async () => {
    const toBitmap = vi.fn(() => Buffer.alloc(3 * 2 * 4));
    const win = fakeWindow({ imageWidth: 3, imageHeight: 2, toBitmap });
    const host = createExportCompositorHost(plan, {
      app: runtimeApp,
      devRuntime: false,
      windowFactory: () => win,
    });

    await host.start();
    const render = host.renderFrame(50);

    await expect(render).rejects.toMatchObject({
      name: "ExportCompositorFrameDimensionError",
      code: "frame-dimension-mismatch",
      stage: "capture",
      details: {
        expectedWidth: 2,
        expectedHeight: 2,
        capturedWidth: 3,
        capturedHeight: 2,
        devicePixelRatio: 1,
        expectedBytes: 16,
        capturedBytes: 24,
      },
    });
    expect(toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 });
    expect(ExportCompositorFrameDimensionError.prototype).not.toHaveProperty("resize");
    await host.dispose();
    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it("keeps startup errors serializable for export job reporting", () => {
    const error = new ExportCompositorStartupError(
      "bridge-timeout",
      "bridge-readiness",
      "not ready",
      { attempts: 3 },
    );

    expect(error.toJSON()).toEqual({
      name: "ExportCompositorStartupError",
      code: "bridge-timeout",
      stage: "bridge-readiness",
      message: "not ready",
      details: { attempts: 3 },
    });
  });
});
