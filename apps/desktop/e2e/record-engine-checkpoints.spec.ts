import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startCursorSyncFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

test("commits a canonical take with one durable segment per scene", async () => {
  const fixture = await startCursorSyncFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-checkpoints-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const storySource = `story "Checkpoint E2E" {
meta {
  app: "${fixture.url}"
  viewport: 320x240
}
scene "First" {
  wait 1000ms
}
scene "Second" {
  wait 1000ms
}
}`;

  const app = await electron.launch({
    args: [desktopDir, `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_RECORDING_AV_MODE: "unified",
      STORYCAPTURE_RECORDING_BUNDLE_MODE: "required",
      STORYCAPTURE_RECORDING_CHECKPOINT_MODE: "shadow",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "shadow",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
      STORYCAPTURE_RECORDING_HEALTH_MODE: "observe",
      STORYCAPTURE_RECORDING_HEALTH_HUD_MODE: "shadow",
      STORYCAPTURE_CAPTURE_BACKEND_MODE: "contract_shadow",
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
          viewportWidth: 320,
          viewportHeight: 240,
          fps: 30,
          replaceExisting: false,
          partition: "record-engine-checkpoints-e2e",
          purpose: "recording",
          visible: false,
        })) as string;
      },
      { url: fixture.url },
    );

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
            audio_device_id: null,
            include_cursor: true,
          },
          onEvent: null,
        })) as { id: string };
      },
      { projectFolder, streamId },
    );

    await renderer.evaluate(
      async ({ projectFolder, recordingSessionId, storySource, streamId }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        await invoke("launch_automation", {
          streamId,
          projectFolder,
          storySource,
          recordingSessionId,
          onEvent: null,
        });
      },
      {
        projectFolder,
        recordingSessionId: recordingSession.id,
        storySource,
        streamId,
      },
    );

    const takesRoot = path.join(projectFolder, "exports", "takes");
    const takeEntries = (await fs.readdir(takesRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
    expect(takeEntries).toHaveLength(1);
    const takeRoot = path.join(takesRoot, takeEntries[0].name);
    const manifest = JSON.parse(
      await fs.readFile(path.join(takeRoot, "manifest.json"), "utf8"),
    ) as {
      verdict: string;
      session_id: string;
      outcome: unknown;
      artifacts: Array<{ kind: string; relative_path: string }>;
    };
    expect(manifest.session_id).toBe(recordingSession.id);
    expect(["passed", "repairable"], JSON.stringify(manifest.outcome)).toContain(manifest.verdict);
    expect(
      manifest.artifacts.some(
        (artifact) => artifact.kind === "health" && artifact.relative_path === "engine-health.json",
      ),
    ).toBe(true);
    const engineHealth = JSON.parse(
      await fs.readFile(path.join(takeRoot, "engine-health.json"), "utf8"),
    ) as {
      version: number;
      latest: { schema_version: number; session_id: string; sequence: number };
    };
    expect(engineHealth).toMatchObject({
      version: 1,
      latest: { schema_version: 1, session_id: recordingSession.id },
    });
    expect(engineHealth.latest.sequence).toBeGreaterThan(0);
    const health = JSON.parse(await fs.readFile(path.join(takeRoot, "health.json"), "utf8")) as {
      capture_backend: {
        contract_version: number;
        selected_backend_id: string;
        resolved_target_identity: string;
      };
    };
    expect(health.capture_backend).toMatchObject({
      contract_version: 1,
      selected_backend_id: "electron_author_preview",
      resolved_target_identity: `author_preview:${streamId}`,
    });

    const segmentsRoot = path.join(takeRoot, "segments");
    const checkpointJournal = await fs.readFile(
      path.join(segmentsRoot, "checkpoints.v1.jsonl"),
      "utf8",
    );
    expect(
      manifest.artifacts.filter((artifact) => artifact.kind === "segment"),
      checkpointJournal,
    ).toHaveLength(2);
    const sceneDirs = (await fs.readdir(segmentsRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    expect(sceneDirs).toHaveLength(2);
    const attemptFiles: string[] = [];
    for (const sceneDir of sceneDirs) {
      const files = await fs.readdir(path.join(segmentsRoot, sceneDir.name));
      const media = files.filter((file) => file.endsWith(".mp4"));
      expect(media).toHaveLength(1);
      attemptFiles.push(...media);
    }
    expect(attemptFiles.sort()).toEqual(["attempt-000001.mp4", "attempt-000002.mp4"]);
    expect(checkpointJournal.match(/"type":"scene_attempt_committed"/g)).toHaveLength(2);
    expect(checkpointJournal.match(/"type":"step_checkpoint_committed"/g)).toHaveLength(2);
    expect(checkpointJournal).not.toContain("live_state_handle");

    const diagnostic = spawnSync(
      process.execPath,
      [
        path.join(desktopDir, "scripts", "recording-diagnostics.mjs"),
        "--input",
        userDataDir,
        "--session",
        recordingSession.id,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(diagnostic.status, diagnostic.stderr || diagnostic.stdout).toBe(0);
    const trace = JSON.parse(diagnostic.stdout) as {
      status: string;
      take_id: string;
      terminal: { verdict: string; reason_code: string };
      artifacts: Array<{ path: string }>;
      issues: unknown[];
    };
    expect(trace).toMatchObject({
      status: "coherent",
      take_id: takeEntries[0].name,
      issues: [],
    });
    expect(["passed", "repairable"]).toContain(trace.terminal.verdict);
    expect(trace.artifacts).toContainEqual(expect.objectContaining({ path: "manifest.json" }));

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
