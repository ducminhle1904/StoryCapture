import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startRecordEngineAudioFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

test("records author-preview tab audio as an authenticated immutable stem", async () => {
  const fixture = await startRecordEngineAudioFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-tab-audio-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const storySource = `story "Tab audio E2E" {
meta {
  app: "${fixture.url}"
  viewport: 320x240
}
scene "Audio" {
  wait 2500ms
}
}`;

  const app = await electron.launch({
    args: [
      desktopDir,
      `--user-data-dir=${userDataDir}`,
      "--use-fake-device-for-media-stream",
    ],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_RECORDING_AV_MODE: "unified",
      STORYCAPTURE_RECORDING_AUDIO_MODE: "multitrack_shadow",
      STORYCAPTURE_RECORDING_BUNDLE_MODE: "required",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "shadow",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
    },
  });

  try {
    await app.evaluate(({ session }) => {
      session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission) => permission === "display-capture" || permission === "media",
      );
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) =>
          callback(permission === "display-capture" || permission === "media"),
      );
    });
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
          viewportWidth: 320,
          viewportHeight: 240,
          fps: 30,
          replaceExisting: false,
          partition: "record-engine-tab-audio-e2e",
          purpose: "recording",
          visible: false,
        })) as string;
      },
      { url: fixture.url },
    );

    await expect
      .poll(() => app.windows().some((window) => window.url().startsWith(fixture.url)))
      .toBe(true);
    const preview = app.windows().find((window) => window.url().startsWith(fixture.url));
    if (!preview) throw new Error("Author-preview fixture window did not open");
    const frameOrigins = await preview.evaluate(() =>
      Array.from(document.querySelectorAll("iframe"), (frame) => new URL(frame.src).origin).sort(),
    );
    expect(frameOrigins).toEqual(
      [new URL(fixture.url).origin, new URL(fixture.crossOriginUrl).origin].sort(),
    );
    await expect(
      preview.evaluate(async () =>
        (
          window as never as {
            __startFixtureFramesAudio: () => Promise<string[]>;
          }
        ).__startFixtureFramesAudio(),
      ),
    ).resolves.toEqual(["cross-origin", "same-origin"]);

    const recordingSession = await renderer.evaluate(
      async ({ projectFolder, streamId }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        return (await invoke("start_recording", {
          args: {
            project_folder: projectFolder,
            target: { kind: "author_preview", stream_id: streamId },
            width: 320,
            height: 240,
            fps: 30,
            audio_device_id: "default",
            audio_track_selection: [
              { role: "microphone", requirement: "required", source_id: "default" },
              { role: "tab", requirement: "required", source_id: streamId },
            ],
            include_cursor: false,
          },
          onEvent: null,
        })) as { id: string };
      },
      { projectFolder, streamId },
    );

    const maliciousCapture = await preview.evaluate(async () => {
      try {
        const result = await Promise.race([
          navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
        ]);
        if (result === "timeout") return "timeout";
        result.getTracks().forEach((track) => track.stop());
        return "granted";
      } catch (error) {
        return error instanceof DOMException ? error.name : "rejected";
      }
    });
    expect(maliciousCapture).not.toBe("granted");

    const pauseResumePromise = renderer.evaluate(
      async ({ projectFolder, recordingSessionId, storySource, streamId }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        const automation = invoke("launch_automation", {
          streamId,
          projectFolder,
          storySource,
          recordingSessionId,
          onEvent: null,
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        const paused = (await invoke("pause_recording", {
          session: { id: recordingSessionId },
        })) as { status: string };
        await new Promise((resolve) => setTimeout(resolve, 600));
        const resumed = (await invoke("resume_recording", {
          session: { id: recordingSessionId },
        })) as { status: string };
        await automation;
        return { paused: paused.status, resumed: resumed.status };
      },
      { projectFolder, recordingSessionId: recordingSession.id, storySource, streamId },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await preview.evaluate(() =>
      (
        window as never as {
          __setFixtureFramesMuted: (muted: boolean) => void;
        }
      ).__setFixtureFramesMuted(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await preview.evaluate(() =>
      (
        window as never as {
          __setFixtureFramesMuted: (muted: boolean) => void;
        }
      ).__setFixtureFramesMuted(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 950));
    await preview.goto(`${fixture.url}/next`);
    await expect(
      preview.evaluate(async () =>
        (
          window as never as {
            __startFixtureFramesAudio: () => Promise<string[]>;
          }
        ).__startFixtureFramesAudio(),
      ),
    ).resolves.toEqual(["cross-origin", "same-origin"]);

    const pauseResume = await pauseResumePromise;
    expect(pauseResume).toEqual({ paused: "paused", resumed: "recording" });

    const takeEntries = await fs.readdir(path.join(projectFolder, "exports", "takes"));
    expect(takeEntries).toHaveLength(1);
    const takeRoot = path.join(projectFolder, "exports", "takes", takeEntries[0] as string);
    const audioRoot = path.join(takeRoot, "media", "audio");
    const audioEntries = await fs.readdir(audioRoot).catch(() => []);
    const healthDiagnostic = await fs
      .readFile(path.join(takeRoot, "health.json"), "utf8")
      .catch(() => "health.json unavailable");
    expect(audioEntries, healthDiagnostic).toContain("tracks.json");
    const tracksDocument = JSON.parse(
      await fs.readFile(path.join(audioRoot, "tracks.json"), "utf8"),
    ) as {
      schema_version: number;
      session_id: string;
      tracks: Array<{
        role: string;
        requirement: string;
        source_kind: string;
        source_id: string | null;
        relative_path: string | null;
        first_pts_us: number | null;
        last_pts_us: number | null;
        duration_us: number;
        discontinuity_count: number;
        status: string;
        failure_reason: string | null;
      }>;
    };
    expect(tracksDocument).toMatchObject({ schema_version: 1, session_id: recordingSession.id });
    expect(tracksDocument.tracks).toHaveLength(2);
    const microphone = tracksDocument.tracks.find((track) => track.role === "microphone");
    const tab = tracksDocument.tracks.find((track) => track.role === "tab");
    expect(microphone).toMatchObject({
      role: "microphone",
      requirement: "required",
      source_kind: "media_device",
      source_id: "default",
      status: "completed",
      failure_reason: null,
      discontinuity_count: 1,
    });
    expect(tab).toMatchObject({
      role: "tab",
      requirement: "required",
      source_kind: "author_preview_frame",
      source_id: streamId,
      status: "completed",
      failure_reason: null,
      discontinuity_count: 1,
    });
    expect(tab?.relative_path).toBeTruthy();
    expect(tab?.first_pts_us).not.toBeNull();
    expect(tab?.last_pts_us).not.toBeNull();
    expect(tab?.duration_us ?? 0).toBeGreaterThan(1_000_000);
    expect(microphone?.relative_path).toBeTruthy();
    expect(microphone?.first_pts_us).not.toBeNull();
    expect(microphone?.last_pts_us).not.toBeNull();
    expect(microphone?.duration_us ?? 0).toBeGreaterThan(1_000_000);
    for (const track of [microphone, tab]) {
      const stemPath = path.join(takeRoot, track?.relative_path as string);
      expect((await fs.stat(stemPath)).size).toBeGreaterThan(0);
    }
    expect((await fs.stat(path.join(audioRoot, "compatibility.m4a"))).size).toBeGreaterThan(0);
    const manifest = JSON.parse(
      await fs.readFile(path.join(takeRoot, "manifest.json"), "utf8"),
    ) as { artifacts: Array<{ kind: string; relative_path: string }> };
    for (const track of [microphone, tab]) {
      expect(
        manifest.artifacts.some(
          (artifact) => artifact.kind === "audio" && artifact.relative_path === track?.relative_path,
        ),
      ).toBe(true);
    }
  } finally {
    await app.close().catch(() => undefined);
    await fixture.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
