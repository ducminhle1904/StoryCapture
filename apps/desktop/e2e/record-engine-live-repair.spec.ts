import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { startRecordEngineRepairFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

type RepairLimitMode = "expiry" | "exhaustion";

interface RepairLimitEvent {
  type: string;
  allowed_actions?: string[];
  attempt?: number;
  expires_at_ms?: number;
  repair_token?: string;
  session_id?: string;
}

async function runRepairLimitScenario(mode: RepairLimitMode): Promise<{
  events: RepairLimitEvent[];
  lateResolutionError: string | null;
  manifestVerdict: string;
}> {
  const fixture = await startRecordEngineRepairFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), `storycapture-${mode}-e2e-`));
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `storycapture-${mode}-user-data-e2e-`),
  );
  const stepId =
    mode === "expiry"
      ? "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72930"
      : "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72931";
  const storySource = `story "Repair ${mode} E2E" {
meta {
  app: "${fixture.url}"
  viewport: 320x240
}
scene "Repair limit" {
  navigate "${fixture.url}/initial"
  wait-for testid "repair-limit-target" timeout 250ms # @id=${stepId}
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
      STORYCAPTURE_RECORDING_REPAIR_MODE: "manual_hybrid",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "shadow",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
      STORYCAPTURE_RUNTIME_TARGET_MODE: "enforce",
    },
  });

  try {
    if (mode === "expiry") {
      await app.evaluate(() => {
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
          handler: (...args: unknown[]) => void,
          timeout?: number,
          ...args: unknown[]
        ) =>
          originalSetTimeout(
            () => handler(...args),
            timeout === 10 * 60_000 ? 75 : timeout,
          )) as typeof globalThis.setTimeout;
      });
    }

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
          initialUrl: `${url}/initial`,
          viewportWidth: 320,
          viewportHeight: 240,
          fps: 30,
          replaceExisting: false,
          partition: "record-engine-repair-limits-e2e",
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
    const run = await renderer.evaluate(
      async ({ mode, projectFolder, recordingSessionId, storySource, streamId }) => {
        const automation = await import("/src/ipc/automation.ts");
        const events: RepairLimitEvent[] = [];
        const repairEvents: RepairLimitEvent[] = [];
        const resolutions: Array<Promise<unknown>> = [];
        await automation.launchAutomation(
          { projectFolder, recordingSessionId, storySource, streamId },
          (event) => {
            const snapshot: RepairLimitEvent = { type: event.type };
            if (event.type === "repair-required") {
              Object.assign(snapshot, {
                allowed_actions: [...event.allowed_actions],
                attempt: event.attempt,
                expires_at_ms: event.expires_at_ms,
                repair_token: event.repair_token,
                session_id: event.session_id,
              });
              repairEvents.push(snapshot);
              if (mode === "exhaustion") {
                const action = event.allowed_actions.includes("retry_step")
                  ? "retry_step"
                  : "abort_keep_salvage";
                resolutions.push(
                  automation.resolveRecordingRepair({
                    sessionId: event.session_id,
                    repairToken: event.repair_token,
                    action,
                  }),
                );
              }
            }
            events.push(snapshot);
          },
        );
        await Promise.all(resolutions);
        let lateResolutionError: string | null = null;
        const firstRepair = repairEvents[0];
        if (mode === "expiry" && firstRepair?.session_id && firstRepair.repair_token) {
          try {
            await automation.resolveRecordingRepair({
              sessionId: firstRepair.session_id,
              repairToken: firstRepair.repair_token,
              action: "abort_keep_salvage",
            });
          } catch (error) {
            lateResolutionError = error instanceof Error ? error.message : String(error);
          }
        }
        return { events, lateResolutionError };
      },
      {
        mode,
        projectFolder,
        recordingSessionId: recordingSession.id,
        storySource,
        streamId,
      },
    );

    const takesRoot = path.join(projectFolder, "exports", "takes");
    await expect
      .poll(async () => {
        try {
          return (await fs.readdir(takesRoot, { withFileTypes: true })).some(
            (entry) => entry.isDirectory() && !entry.name.startsWith("."),
          );
        } catch {
          return false;
        }
      })
      .toBe(true);
    const takeEntry = (await fs.readdir(takesRoot, { withFileTypes: true })).find(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
    if (!takeEntry) throw new Error("repair-limit take was not committed");
    const manifest = JSON.parse(
      await fs.readFile(path.join(takesRoot, takeEntry.name, "manifest.json"), "utf8"),
    ) as { verdict: string };

    await renderer.evaluate(async (id) => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      await invoke("stop_author_preview", { streamId: id });
    }, streamId);
    return { ...run, manifestVerdict: manifest.verdict };
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

test("retries one live step and one scene, then publishes an immutable stitched revision", async () => {
  const fixture = await startRecordEngineRepairFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-repair-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const retryStepId = "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72920";
  const unsafeStepId = "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72921";
  const storySource = `story "Live repair E2E" {
meta {
  app: "${fixture.url}"
  viewport: 320x240
}
scene "Stable" {
  wait 500ms
}
scene "Step repairable" {
  navigate "${fixture.url}/step"
  click testid "step-repair-target" # @id=${retryStepId}
}
scene "Unsafe scene repairable" {
  navigate "${fixture.url}/unsafe-scene"
  drag testid "unsafe-source" to testid "unsafe-destination" # @id=${unsafeStepId}
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
      STORYCAPTURE_RECORDING_REPAIR_MODE: "manual_hybrid",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "shadow",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
      STORYCAPTURE_RUNTIME_TARGET_MODE: "enforce",
      STORYCAPTURE_DRAG_EXECUTION_MODE: "on",
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
          initialUrl: `${url}/initial`,
          viewportWidth: 320,
          viewportHeight: 240,
          fps: 30,
          replaceExisting: false,
          partition: "record-engine-repair-e2e",
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

    const repairRun = await renderer.evaluate(
      async ({
        fixtureUrl,
        projectFolder,
        recordingSessionId,
        retryStepId,
        storySource,
        streamId,
        unsafeStepId,
      }) => {
        const automation = await import("/src/ipc/automation.ts");
        const events: Array<{
          type: string;
          allowed_actions?: string[];
          phase?: string;
          step_id?: string;
        }> = [];
        const resolutions: Array<Promise<unknown>> = [];
        const replayErrors: string[] = [];
        await automation.launchAutomation(
          { projectFolder, recordingSessionId, storySource, streamId },
          (event) => {
            events.push(event);
            if (event.type === "repair-required") {
              if (event.step_id === retryStepId) {
                if (event.phase !== "pre_input" || !event.allowed_actions.includes("retry_step")) {
                  throw new Error("pre-input retry_step was not offered");
                }
                resolutions.push(
                  fetch(`${fixtureUrl}/arm-step-repair`).then((response) => {
                    if (!response.ok) throw new Error("step repair fixture did not arm");
                    const args = {
                      sessionId: event.session_id,
                      repairToken: event.repair_token,
                      action: "retry_step" as const,
                    };
                    return automation.resolveRecordingRepair(args).then(async () => {
                      try {
                        await automation.resolveRecordingRepair(args);
                        replayErrors.push("accepted");
                      } catch (error) {
                        replayErrors.push(error instanceof Error ? error.message : String(error));
                      }
                    });
                  }),
                );
                return;
              }
              if (event.step_id !== unsafeStepId) {
                throw new Error("unexpected repair step");
              }
              if (
                event.phase !== "input_emitted_presentation_pending" ||
                event.allowed_actions.includes("retry_step") ||
                !event.allowed_actions.includes("retry_scene")
              ) {
                throw new Error("unsafe input was not escalated to retry_scene");
              }
              resolutions.push(
                automation.resolveRecordingRepair({
                  sessionId: event.session_id,
                  repairToken: event.repair_token,
                  action: "retry_scene",
                }),
              );
            }
          },
        );
        await Promise.all(resolutions);
        return { events, replayErrors };
      },
      {
        fixtureUrl: fixture.url,
        projectFolder,
        recordingSessionId: recordingSession.id,
        retryStepId,
        storySource,
        streamId,
        unsafeStepId,
      },
    );
    const repairEvents = repairRun.events;
    expect(repairRun.replayErrors).toHaveLength(1);
    expect(repairRun.replayErrors[0]).toContain("recording_repair_rejected");
    expect(
      repairEvents
        .filter((event) => event.type === "repair-required")
        .map((event) => ({ phase: event.phase, stepId: event.step_id })),
    ).toEqual([
      { phase: "pre_input", stepId: retryStepId },
      { phase: "input_emitted_presentation_pending", stepId: unsafeStepId },
    ]);

    const takesRoot = path.join(projectFolder, "exports", "takes");
    const takeEntries = (await fs.readdir(takesRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
    expect(takeEntries).toHaveLength(1);
    const takeRoot = path.join(takesRoot, takeEntries[0].name);
    const revision = JSON.parse(
      await fs.readFile(path.join(takeRoot, "revisions", "current.json"), "utf8"),
    ) as {
      revision_id: string;
      selected_attempts: Array<{
        attempt_id: string;
        scene_id: string;
        media_path: string;
        media_sha256: string;
      }>;
      actions_path: string | null;
    };
    expect(revision.selected_attempts.map((attempt) => attempt.attempt_id)).toEqual([
      "attempt-000001",
      "attempt-000003",
      "attempt-000005",
    ]);
    await expect(
      fs.stat(path.join(takeRoot, "media", "original-session.mp4")),
    ).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(
      fs.stat(path.join(takeRoot, "revisions", revision.revision_id, "media", "video.mp4")),
    ).resolves.toMatchObject({ size: expect.any(Number) });
    const journal = await fs.readFile(
      path.join(takeRoot, "segments", "checkpoints.v1.jsonl"),
      "utf8",
    );
    expect(journal.match(/"type":"scene_attempt_failed"/g)).toHaveLength(2);
    expect(journal.match(/"type":"scene_attempt_committed"/g)).toHaveLength(3);
    const firstSceneMedia = (
      await fs.readdir(
        path.join(takeRoot, "segments", revision.selected_attempts[0]?.scene_id ?? "missing"),
      )
    ).filter((file) => file.endsWith(".mp4"));
    expect(firstSceneMedia).toEqual(["attempt-000001.mp4"]);
    const firstSelection = revision.selected_attempts[0];
    if (!firstSelection) throw new Error("first scene selection missing");
    const firstSegmentBytes = await fs.readFile(path.join(takeRoot, firstSelection.media_path));
    expect(createHash("sha256").update(firstSegmentBytes).digest("hex")).toBe(
      firstSelection.media_sha256,
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(takeRoot, "manifest.json"), "utf8"),
    ) as { artifacts: Array<{ relative_path: string }> };
    const artifactPaths = manifest.artifacts.map((artifact) => artifact.relative_path);
    expect(artifactPaths).toEqual(
      expect.arrayContaining([
        "media/original-session.mp4",
        "revisions/current.json",
        `revisions/${revision.revision_id}/media/video.mp4`,
      ]),
    );
    const canonicalActions = JSON.parse(
      await fs.readFile(path.join(takeRoot, "sidecars", "actions.json"), "utf8"),
    ) as { version: number; events: Array<{ step_id: string }> };
    expect(canonicalActions.version).toBe(3);
    expect(canonicalActions.events.map((event) => event.step_id)).toEqual([
      retryStepId,
      unsafeStepId,
    ]);

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

test("expires an unanswered live repair and keeps only salvage", async () => {
  const startedAt = Date.now();
  const run = await runRepairLimitScenario("expiry");
  const repairEvents = run.events.filter((event) => event.type === "repair-required");

  expect(repairEvents).toHaveLength(1);
  expect(repairEvents[0]).toMatchObject({
    attempt: 0,
    allowed_actions: expect.arrayContaining(["retry_step", "abort_keep_salvage"]),
  });
  expect(repairEvents[0]?.expires_at_ms).toBeGreaterThan(startedAt + 9 * 60_000);
  expect(run.lateResolutionError).toContain("recording repair session is not live");
  expect(run.manifestVerdict).not.toBe("passed");
});

test("removes step retry after three live repair attempts", async () => {
  const run = await runRepairLimitScenario("exhaustion");
  const repairEvents = run.events.filter((event) => event.type === "repair-required");

  expect(repairEvents.map((event) => event.attempt)).toEqual([0, 1, 2, 3]);
  for (const event of repairEvents.slice(0, 3)) {
    expect(event.allowed_actions).toContain("retry_step");
  }
  expect(repairEvents[3]?.allowed_actions).not.toContain("retry_step");
  expect(repairEvents[3]?.allowed_actions).not.toContain("use_candidate_and_retry");
  expect(repairEvents[3]?.allowed_actions).toEqual(
    expect.arrayContaining(["retry_scene", "abort_keep_salvage"]),
  );
  expect(run.lateResolutionError).toBeNull();
  expect(run.manifestVerdict).not.toBe("passed");
});
