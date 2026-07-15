import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devServerUrl = "http://127.0.0.1:1420";

async function launchDevRenderer(extraArgs: string[] = []) {
  const app = await electron.launch({
    args: [desktopDir, ...extraArgs],
    cwd: desktopDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
  });
  try {
    await expect
      .poll(() => app.windows().some((window) => window.url().startsWith(devServerUrl)))
      .toBe(true);
    const main = app.windows().find((window) => window.url().startsWith(devServerUrl));
    if (!main) throw new Error("StoryCapture renderer window did not open");
    await expect(main.locator("body")).toBeVisible();
    return { app, main };
  } catch (error) {
    await app.close();
    throw error;
  }
}

test("loads the bundled cursor skin through Vite in the Electron dev renderer", async () => {
  const { app, main } = await launchDevRenderer();
  try {
    const cursorSkin = await main.evaluate(async () => {
      const canonicalAssetsModulePath =
        "/src/features/post-production/export-compositor/canonical-assets.ts";
      const { CanonicalImageAssetPool } = await import(canonicalAssetsModulePath);
      const pool = new CanonicalImageAssetPool();
      try {
        await pool.configure({
          schema_version: 4,
          output_width: 1_280,
          output_height: 720,
          output_fps: 30,
          duration_ms: 1_000,
          video: [
            {
              type: "cursor-overlay",
              id: "cursor-skin-e2e",
              clip_id: "cursor-skin-e2e-clip",
              skin: "mac-default",
              size_scale: 1,
              motion_preset: "natural",
              preserve_full_motion: true,
              click_effect: { style: "none", color: "auto", intensity: "normal" },
              color_tint: null,
              t_start_ms: 0,
              duration_ms: 1_000,
              trajectory: {
                kind: "actions",
                path: "unused.actions.json",
                png_sequence_dir: "unused.actions.json",
                fps: 60,
                frame_count: 0,
              },
            },
          ],
          audio: [],
        });
        const skin = pool.cursorSkin("mac-default");
        return {
          exists: skin !== null,
          naturalWidth: skin instanceof HTMLImageElement ? skin.naturalWidth : 0,
          naturalHeight: skin instanceof HTMLImageElement ? skin.naturalHeight : 0,
          src: skin instanceof HTMLImageElement ? skin.currentSrc || skin.src : "",
        };
      } finally {
        pool.dispose();
      }
    });

    expect(cursorSkin.exists).toBe(true);
    expect(cursorSkin.naturalWidth).toBeGreaterThan(0);
    expect(cursorSkin.naturalHeight).toBeGreaterThan(0);
    expect(new URL(cursorSkin.src).pathname).toMatch(/^\/@fs\//);
  } finally {
    await app.close();
  }
});

test("streams and seeks real MP4 media through the local asset protocol", async () => {
  test.skip(!ffmpegPath, "ffmpeg-static binary is unavailable");
  const { app, main } = await launchDevRenderer();
  try {
    const userDataDir = await app.evaluate(({ app }) => app.getPath("userData"));
    const exportsDir = path.join(userDataDir, "exports");
    await fs.mkdir(exportsDir, { recursive: true });
    const fixturePath = path.join(exportsDir, "media fixture ü.mp4");
    await execFileAsync(ffmpegPath as string, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=24",
      "-t",
      "2",
      "-c:v",
      "libaom-av1",
      "-cpu-used",
      "8",
      "-crf",
      "40",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      fixturePath,
    ]);
    const assetUrl = `storycapture-asset://local/${encodeURIComponent(fixturePath)}`;

    const range = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url, { headers: { Range: "bytes=0-31" } });
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, assetUrl);
    expect(range.status).toBe(206);
    expect(range.contentRange).toMatch(/^bytes 0-31\/\d+$/);
    expect(range.bytes).toHaveLength(32);

    const largeFixturePath = path.join(exportsDir, "large sparse fixture.mp4");
    await fs.copyFile(fixturePath, largeFixturePath);
    const fixtureSize = (await fs.stat(largeFixturePath)).size;
    await fs.truncate(largeFixturePath, fixtureSize + 128 * 1024 * 1024);
    const largeAssetUrl = `storycapture-asset://local/${encodeURIComponent(largeFixturePath)}`;
    const memoryBefore = await app.evaluate(({ app }) =>
      app.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize, 0),
    );
    const largeRange = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url, { headers: { Range: "bytes=0-1048575" } });
      return { status: response.status, size: (await response.arrayBuffer()).byteLength };
    }, largeAssetUrl);
    const memoryAfter = await app.evaluate(({ app }) =>
      app.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize, 0),
    );
    expect(largeRange).toEqual({ status: 206, size: 1_048_576 });
    expect(memoryAfter - memoryBefore).toBeLessThan(64 * 1024);

    const playback = await main.evaluate(async (url) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = url;
      document.body.append(video);
      const loadError = await new Promise<string | null>((resolve) => {
        video.onloadedmetadata = () => resolve(null);
        video.onerror = () => resolve(`media error ${video.error?.code ?? "unknown"}`);
      });
      if (loadError) {
        return { duration: 0, middleTime: 0, endTime: 0, currentTime: 0, loadError };
      }
      const duration = video.duration;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = duration / 2;
      });
      const middleTime = video.currentTime;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.max(0, duration - 0.1);
      });
      const endTime = video.currentTime;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = 0;
      });
      await video.play();
      await new Promise<void>((resolve) => {
        video.ontimeupdate = () => resolve();
      });
      const currentTime = video.currentTime;
      video.remove();
      return { duration, middleTime, endTime, currentTime, loadError: null };
    }, assetUrl);
    expect(playback.loadError).toBeNull();
    expect(playback.duration).toBeGreaterThan(1.5);
    expect(playback.middleTime).toBeGreaterThan(0.5);
    expect(playback.endTime).toBeGreaterThan(playback.duration - 0.25);
    expect(playback.currentTime).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("uses the newest recording and recovers from transient media failure", async () => {
  test.skip(!ffmpegPath, "ffmpeg-static binary is unavailable");
  const userDataDir = await fs.mkdtemp(path.join(process.cwd(), ".media-e2e-"));
  const projectId = "media-e2e-project";
  const projectDir = path.join(userDataDir, "project with ünicode");
  const exportsDir = path.join(projectDir, "exports");
  await fs.mkdir(path.join(projectDir, ".storycapture"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "assets"), { recursive: true });
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, ".storycapture", "version.txt"), "1");
  await fs.writeFile(
    path.join(projectDir, "story.story"),
    'story "E2E" { meta { app: "https://example.com" viewport: desktop } scene "E2E" { pause } }',
  );
  const older = path.join(exportsDir, "recording-1.mp4");
  const latest = path.join(exportsDir, "recording-2 ü.mp4");
  await execFileAsync(ffmpegPath as string, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=12",
    "-t",
    "1",
    "-c:v",
    "libaom-av1",
    "-cpu-used",
    "8",
    "-crf",
    "45",
    "-pix_fmt",
    "yuv420p",
    latest,
  ]);
  await fs.copyFile(latest, older);
  await fs.utimes(older, 1, 1);
  await fs.utimes(latest, 2, 2);
  await fs.writeFile(
    path.join(userDataDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "E2E",
        folder_path: projectDir,
        created_at: 1,
        last_opened_at: 1,
        thumbnail_path: null,
      },
    ]),
  );

  const { app, main } = await launchDevRenderer([`--user-data-dir=${userDataDir}`]);
  try {
    const discovered = await main.evaluate(async (id) => {
      const internals = (
        window as typeof window & {
          __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: unknown) => Promise<Array<{ path: string }>>;
          };
        }
      ).__TAURI_INTERNALS__;
      return internals.invoke("list_project_recordings", { args: { id } });
    }, projectId);
    expect(discovered.map((recording) => recording.path)).toEqual([latest, older]);
    const latestAssetUrl = `storycapture-asset://local/${encodeURIComponent(latest)}`;
    await main.goto(
      `${devServerUrl}/?storycapturePreviewE2E=${encodeURIComponent(latestAssetUrl)}`,
    );
    await expect(main.getByLabel("Source video preview")).toHaveAttribute("src", latestAssetUrl);
    const dispatchMediaEvent = (type: string) =>
      main.evaluate((eventType) => {
        const video = document.querySelector<HTMLVideoElement>(
          'video[aria-label="Source video preview"]',
        );
        if (!video) return false;
        video.dispatchEvent(new Event(eventType));
        return true;
      }, type);
    await expect.poll(() => dispatchMediaEvent("loadeddata")).toBe(true);

    await main.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(
        'video[aria-label="Source video preview"]',
      );
      if (!video) throw new Error("Source video preview disappeared");
      video.dataset.e2eGeneration = "first";
    });
    await expect.poll(() => dispatchMediaEvent("error")).toBe(true);
    await expect
      .poll(() =>
        main.evaluate(
          () =>
            document.querySelector<HTMLVideoElement>('video[aria-label="Source video preview"]')
              ?.dataset.e2eGeneration !== "first",
        ),
      )
      .toBe(true);
    await expect.poll(() => dispatchMediaEvent("loadeddata")).toBe(true);
    await expect(main.getByRole("button", { name: "Retry preview" })).toHaveCount(0);

    await app.evaluate(async ({ protocol, session }) => {
      await session.defaultSession.clearCache();
      protocol.unhandle("storycapture-asset");
      protocol.handle(
        "storycapture-asset",
        () =>
          new Response("forced media failure", {
            status: 500,
            headers: { "cache-control": "no-store" },
          }),
      );
    });
    await main.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(
        'video[aria-label="Source video preview"]',
      );
      if (!video) return;
      video.src = `${video.src}?permanent-failure=1`;
      video.load();
      video.dispatchEvent(new Event("error"));
      video.dispatchEvent(new Event("error"));
    });
    await expect(main.getByRole("button", { name: "Retry preview" })).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await app.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
