import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startCursorSyncFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

test("captures one exact external window and fails closed when it disappears", async () => {
  const fixture = await startCursorSyncFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-external-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const externalTitle = `StoryCapture External Capture ${Date.now()}`;
  const app = await electron.launch({
    args: [desktopDir, `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_CAPTURE_BACKEND_MODE: "contract_internal",
      STORYCAPTURE_RECORDING_BUNDLE_MODE: "required",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "strict",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
    },
  });

  try {
    await expect
      .poll(() => app.windows().some((window) => window.url().startsWith("http://127.0.0.1:1420")))
      .toBe(true);
    const renderer = app
      .windows()
      .find((window) => window.url().startsWith("http://127.0.0.1:1420"));
    if (!renderer) throw new Error("StoryCapture renderer window did not open");
    await renderer.waitForFunction(() =>
      Boolean((window as never as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
    );

    const externalSourceId = await app.evaluate(
      async ({ BrowserWindow }, { title, url }) => {
        const externalWindow = new BrowserWindow({
          width: 360,
          height: 260,
          show: true,
          title,
        });
        await externalWindow.loadURL(url);
        externalWindow.setTitle(title);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return externalWindow.getMediaSourceId();
      },
      { title: externalTitle, url: fixture.url },
    );
    const [, nativeWindowId] = externalSourceId.split(":");
    if (!nativeWindowId)
      throw new Error(`unexpected Electron media source id: ${externalSourceId}`);
    const sourceProbe = await app.evaluate(async ({ desktopCapturer }, sourceId) => {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 320, height: 240 },
      });
      const source = sources.find((candidate) => candidate.id === sourceId);
      return source
        ? { found: true, thumbnailEmpty: source.thumbnail.isEmpty() }
        : { found: false };
    }, externalSourceId);
    expect(sourceProbe.found).toBe(true);
    test.skip(
      "thumbnailEmpty" in sourceProbe && sourceProbe.thumbnailEmpty,
      "macOS Screen Recording/TCC did not grant external-window pixels to the dev Electron host",
    );

    const recordingSession = await renderer.evaluate(
      async ({ nativeWindowId, projectFolder }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        return (await invoke("start_recording", {
          args: {
            project_folder: projectFolder,
            target: { kind: "window", window_id: nativeWindowId },
            width: 320,
            height: 240,
            fps: 30,
            audio_device_id: null,
            include_cursor: false,
          },
          onEvent: null,
        })) as { id: string };
      },
      { nativeWindowId, projectFolder },
    );

    await app.evaluate(({ BrowserWindow }, title) => {
      const target = BrowserWindow.getAllWindows().find((window) => window.getTitle() === title);
      if (!target) throw new Error("external capture fixture window missing");
      target.destroy();
    }, externalTitle);
    await expect
      .poll(() => app.windows().some((window) => window.title() === externalTitle))
      .toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 750));

    const result = await renderer.evaluate(async (sessionId) => {
      const encode = await import("/src/ipc/encode.ts");
      return encode.stopRecording({ id: sessionId });
    }, recordingSession.id);
    expect(result.capture_backend).toMatchObject({
      selected_backend_id: "electron_external",
      attempted_backend_id: null,
      fallback_reason: null,
      target_loss_reason: "window_closed",
      terminal_status: "target_lost",
    });
    expect(result.terminal_outcome).toMatchObject({
      verdict: "failed",
      reason_code: "capture_target_lost",
    });
    expect(result.terminal_event).toMatchObject({
      event: "terminal",
      outcome: { verdict: "failed", reason_code: "capture_target_lost" },
      disposition: {
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
      },
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(result.bundle_path, "manifest.json"), "utf8"),
    ) as { verdict: string; outcome: { reason_code: string } };
    expect(manifest).toMatchObject({
      verdict: "failed",
      outcome: { reason_code: "capture_target_lost" },
    });
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
