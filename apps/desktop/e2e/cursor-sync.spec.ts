import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { startCursorSyncFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Electron smoke and deterministic post-input paint fixture", async () => {
  const fixture = await startCursorSyncFixtureServer();
  const app = await electron.launch({
    args: [desktopDir],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_CURSOR_SYNC_MODE: process.env.STORYCAPTURE_CURSOR_SYNC_MODE ?? "unified",
    },
  });
  try {
    const main = await app.firstWindow();
    await expect(main.locator("body")).toBeVisible();
    const fixtureWindowPromise = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ show: true, width: 640, height: 480 });
      void win.loadURL(url);
    }, fixture.url);
    const fixtureWindow = await fixtureWindowPromise;
    await fixtureWindow.locator("#target").click();
    await expect(fixtureWindow).toHaveTitle("paint-1");
    await expect(fixtureWindow.locator("#paint-marker")).toHaveAttribute("data-sequence", "1");
  } finally {
    await app.close();
    await fixture.close();
  }
});
