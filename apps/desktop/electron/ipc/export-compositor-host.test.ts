import path from "node:path";

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  createExportCompositorHost,
  ExportCompositorStartupError,
  exportCompositorRendererPath,
  loadExportCompositorRenderer,
  waitForExportCompositorReady,
} from "./export-compositor-host";

function fakeWindow(
  options: {
    executeJavaScript?: (source: string) => Promise<unknown>;
    loadFile?: (filePath: string, options?: unknown) => Promise<void>;
    loadURL?: (url: string) => Promise<void>;
    destroyed?: boolean;
  } = {},
): BrowserWindow {
  const bitmap = Buffer.alloc(2 * 2 * 4);
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    destroy: vi.fn(),
    loadFile: vi.fn(options.loadFile ?? (async () => undefined)),
    loadURL: vi.fn(options.loadURL ?? (async () => undefined)),
    webContents: {
      isDestroyed: vi.fn(() => options.destroyed ?? false),
      setFrameRate: vi.fn(),
      setZoomFactor: vi.fn(),
      executeJavaScript: vi.fn(
        options.executeJavaScript ??
          (async (source: string) =>
            source.includes("const bridge")
              ? {
                  ready: true,
                  documentReadyState: "complete",
                  hasRoot: true,
                  methods: { configure: true, renderFrame: true, dispose: true },
                }
              : { ok: true }),
      ),
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: 2, height: 2 }),
        resize: vi.fn(),
        toBitmap: () => bitmap,
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
    expect(win.webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 2, height: 2 });
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
