import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startRecordEngineInteractionFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

test("executes real DOM drag and visible/hidden file uploads", async () => {
  const fixture = await startRecordEngineInteractionFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-record-engine-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const assetDir = path.join(projectFolder, "assets");
  const assetPath = path.join(assetDir, "sample.txt");
  const storyPath = path.join(projectFolder, "wave-2-interactions.story");
  const dragStepId = "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72911";
  const hiddenUploadStepId = "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72912";
  const storySource = `story "Wave 2 interactions" {
meta {
  app: "${fixture.url}"
  viewport: 900x600
}
scene "Main" {
  drag testid "stale-source" to testid "stale-destination" # @id=${dragStepId}
  upload testid "visible-upload" with "assets/sample.txt"
  upload testid "stale-hidden-upload" with "assets/sample.txt" # @id=${hiddenUploadStepId}
}
}`;
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(assetPath, "record-engine-fixture", "utf8");
  await fs.writeFile(storyPath, storySource, "utf8");
  await fs.writeFile(
    `${storyPath}.targets.json`,
    JSON.stringify({
      version: 1,
      steps: {
        [dragStepId]: {
          from: {
            primary: { kind: "test_id", value: "drag-source" },
            fallbacks: [],
          },
          to: {
            primary: { kind: "test_id", value: "missing-destination" },
            fallbacks: [{ kind: "test_id", value: "drag-destination" }],
          },
        },
        [hiddenUploadStepId]: {
          primary: { kind: "test_id", value: "missing-hidden-upload" },
          fallbacks: [{ kind: "test_id", value: "hidden-upload" }],
        },
      },
    }),
    "utf8",
  );

  const app = await electron.launch({
    args: [desktopDir, `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_RUNTIME_TARGET_MODE: "enforce",
      STORYCAPTURE_DRAG_EXECUTION_MODE: "on",
      STORYCAPTURE_UPLOAD_EXECUTION_MODE: "on",
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
    const streamId = await renderer.evaluate(
      async ({ url }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        return (await invoke("start_author_preview", {
          initialUrl: url,
          viewportWidth: 900,
          viewportHeight: 600,
          fps: 30,
          replaceExisting: false,
          partition: "record-engine-interactions-e2e",
          purpose: "recording",
          visible: false,
        })) as string;
      },
      { url: fixture.url },
    );

    const preview = app.windows().find((window) => window.url().startsWith(fixture.url));
    if (!preview) throw new Error("record-engine fixture preview did not open");
    await expect(preview.locator('[data-testid="drag-source"]')).toBeVisible();

    await renderer.evaluate(
      async ({ streamId, projectFolder, storyPath, storySource }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        await invoke("launch_automation", {
          streamId,
          projectFolder,
          storyPath,
          storySource,
          recordingSessionId: null,
          onEvent: null,
        });
      },
      { streamId, projectFolder, storyPath, storySource },
    );

    const state = await preview.evaluate(() => ({
      dragged: document.body.dataset.dragged,
      dragDown: document.body.dataset.dragDown,
      dragMove: Number(document.body.dataset.dragMove ?? 0),
      dragUp: document.body.dataset.dragUp,
      visibleUpload: document.body.dataset.visibleUpload,
      hiddenUpload: document.body.dataset.hiddenUpload,
    }));
    const expectedFile = `sample.txt:${Buffer.byteLength("record-engine-fixture")}`;
    expect(state).toMatchObject({
      dragged: "true",
      dragDown: "1",
      dragUp: "1",
      visibleUpload: expectedFile,
      hiddenUpload: expectedFile,
    });
    expect(state.dragMove).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain(projectFolder);

    await renderer.evaluate(async (id) => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      await invoke("stop_author_preview", { streamId: id });
    }, streamId);
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
