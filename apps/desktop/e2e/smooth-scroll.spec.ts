import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startSmoothScrollFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

test("automation smooth-scrolls document and nested targets before clicking", async () => {
  const fixture = await startSmoothScrollFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-scroll-e2e-"));
  const app = await electron.launch({
    args: [desktopDir],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
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
          partition: "scroll-e2e",
          purpose: "recording",
          visible: false,
        })) as string;
      },
      { url: fixture.url },
    );

    const preview = app.windows().find((window) => window.url().startsWith(fixture.url));
    if (!preview) throw new Error("Author preview window did not open");
    await preview.evaluate(() => window.scrollTo(0, 0));
    const pickerResultPromise = renderer.evaluate(async (id) => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      return invoke("picker_start_author", { streamId: id, timeoutMs: 10_000 });
    }, streamId);
    await preview.mouse.move(200, 126);
    await expect
      .poll(() =>
        preview.locator('[data-testid="picker-a"]').evaluate((node) => node.style.outline),
      )
      .toContain("rgb(57, 255, 136)");
    await preview.evaluate(async () => {
      window.scrollTo(0, 600);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect
      .poll(() =>
        preview.locator('[data-testid="picker-b"]').evaluate((node) => node.style.outline),
      )
      .toContain("rgb(57, 255, 136)");
    await renderer.evaluate(async () => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      await invoke("picker_cancel");
    });
    const pickerResult = (await pickerResultPromise) as { json?: string };
    expect(JSON.parse(pickerResult.json ?? "{}")).toMatchObject({
      cancelled: true,
      reason: "user-cancel",
    });
    await expect
      .poll(() =>
        preview.locator('[data-testid="picker-b"]').evaluate((node) => node.style.outline),
      )
      .toBe("");

    await renderer.evaluate(
      async ({ streamId, projectFolder, url }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        await invoke("launch_automation", {
          streamId,
          projectFolder,
          storySource: `story "Scroll" {
meta {
  app: "${url}"
  viewport: 900x600
}
scene "Main" {
  scroll down 300px
  scroll testid "panel" down 50vh
  click testid "below-fold"
  click testid "nested-target"
}
}`,
          recordingSessionId: null,
          onEvent: null,
        });
      },
      { streamId, projectFolder, url: fixture.url },
    );

    const state = await app.evaluate(async ({ BrowserWindow }, fixtureUrl) => {
      const preview = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith(fixtureUrl),
      );
      if (!preview) return null;
      return preview.webContents.executeJavaScript(`({
        clicked: document.body.dataset.clicked,
        documentScrollY: window.scrollY,
        panelScrollTop: document.querySelector('[data-testid="panel"]').scrollTop
      })`);
    }, fixture.url);

    expect(state).toMatchObject({ clicked: "nested-target" });
    expect(state?.documentScrollY).toBeGreaterThan(0);
    expect(state?.panelScrollTop).toBeGreaterThan(0);

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
  }
});
