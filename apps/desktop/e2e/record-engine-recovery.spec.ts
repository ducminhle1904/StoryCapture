import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { startRecordEngineRepairFixtureServer } from "./fixture-server";

const desktopDir = path.resolve(import.meta.dirname, "..");

interface RecoveryJournal {
  journal_id: string;
  session_id: string;
  staging_root: string;
  declared_artifacts: Array<{
    kind: string;
    relative_path: string;
    durable: boolean;
  }>;
}

async function launchRecoveryApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
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
      STORYCAPTURE_RECORDING_RECOVERY_MODE: "manual",
      STORYCAPTURE_RECORDING_REPAIR_MODE: "manual_hybrid",
      STORYCAPTURE_RUNTIME_TARGET_MODE: "enforce",
    },
  });
}

async function rendererFor(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() => app.windows().some((window) => window.url().startsWith("http://127.0.0.1:1420")))
    .toBe(true);
  const renderer = app.windows().find((window) => window.url().startsWith("http://127.0.0.1:1420"));
  if (!renderer) throw new Error("StoryCapture renderer window did not open");
  await renderer.waitForFunction(() =>
    Boolean((window as never as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
  );
  return renderer;
}

async function readJournalForSession(
  journalRoot: string,
  sessionId: string,
): Promise<RecoveryJournal | null> {
  const entries = await fs.readdir(journalRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const journal = JSON.parse(
      await fs.readFile(path.join(journalRoot, entry.name), "utf8"),
    ) as RecoveryJournal;
    if (journal.session_id === sessionId) return journal;
  }
  return null;
}

test("salvages a committed scene after process loss without resuming browser input", async () => {
  const fixture = await startRecordEngineRepairFixtureServer();
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-recovery-e2e-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-user-data-e2e-"));
  const repairStepId = "018f0d6f-7b73-7b4d-ae3d-2ed3f4f72930";
  const storySource = `story "Recovery E2E" {
meta {
  app: "${fixture.url}"
  viewport: 320x240
}
scene "Committed before crash" {
  wait 500ms
}
scene "Interrupted repair" {
  navigate "${fixture.url}/step"
  click testid "step-repair-target" # @id=${repairStepId}
}
}`;
  let firstApp: ElectronApplication | null = null;
  let recoveredApp: ElectronApplication | null = null;

  try {
    firstApp = await launchRecoveryApp(userDataDir);
    const renderer = await rendererFor(firstApp);
    const runtimeUserDataDir = await firstApp.evaluate(({ app }) => app.getPath("userData"));
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
          partition: "record-engine-recovery-e2e",
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
        const automation = await import("/src/ipc/automation.ts");
        const state: {
          error: string | null;
          repair: {
            phase: string;
            repairToken: string;
            sessionId: string;
            stepId: string;
          } | null;
        } = { error: null, repair: null };
        (
          window as unknown as {
            __recordEngineRecoveryE2E: typeof state;
          }
        ).__recordEngineRecoveryE2E = state;
        void automation
          .launchAutomation(
            { projectFolder, recordingSessionId, storySource, streamId },
            (event) => {
              if (event.type !== "repair-required") return;
              state.repair = {
                phase: event.phase,
                repairToken: event.repair_token,
                sessionId: event.session_id,
                stepId: event.step_id,
              };
            },
          )
          .catch((error) => {
            state.error = error instanceof Error ? error.message : String(error);
          });
      },
      {
        projectFolder,
        recordingSessionId: recordingSession.id,
        storySource,
        streamId,
      },
    );

    await expect
      .poll(
        () =>
          renderer.evaluate(
            () =>
              (
                window as unknown as {
                  __recordEngineRecoveryE2E?: { repair: unknown };
                }
              ).__recordEngineRecoveryE2E?.repair ?? null,
          ),
        { timeout: 20_000 },
      )
      .not.toBeNull();
    const repair = await renderer.evaluate(
      () =>
        (
          window as unknown as {
            __recordEngineRecoveryE2E: {
              error: string | null;
              repair: {
                phase: string;
                repairToken: string;
                sessionId: string;
                stepId: string;
              };
            };
          }
        ).__recordEngineRecoveryE2E,
    );
    expect(repair.error).toBeNull();
    expect(repair.repair).toMatchObject({
      phase: "pre_input",
      sessionId: recordingSession.id,
      stepId: repairStepId,
    });

    const journalRoot = path.join(runtimeUserDataDir, "recording-journal");
    await expect
      .poll(async () => {
        const journal = await readJournalForSession(journalRoot, recordingSession.id);
        return journal?.declared_artifacts.some(
          (artifact) => artifact.kind === "segment" && artifact.durable,
        );
      })
      .toBe(true);
    const journal = await readJournalForSession(journalRoot, recordingSession.id);
    if (!journal) throw new Error("recording recovery journal missing");
    const segment = journal.declared_artifacts.find(
      (artifact) => artifact.kind === "segment" && artifact.durable,
    );
    if (!segment) throw new Error("committed scene segment missing from recovery journal");
    const segmentPath = path.join(journal.staging_root, segment.relative_path);
    const segmentHash = createHash("sha256")
      .update(await fs.readFile(segmentPath))
      .digest("hex");

    const exited = new Promise<void>((resolve) => {
      firstApp?.process().once("exit", () => resolve());
    });
    expect(firstApp.process().kill("SIGKILL")).toBe(true);
    await exited;
    firstApp = null;

    recoveredApp = await launchRecoveryApp(userDataDir);
    const recoveredRenderer = await rendererFor(recoveredApp);
    expect(recoveredApp.windows().some((window) => window.url().startsWith(fixture.url))).toBe(
      false,
    );

    const interrupted = await recoveredRenderer.evaluate(async () => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      return (await invoke("list_interrupted_recordings", { version: 1 })) as {
        recordings: Array<{ journal_id: string; take_id: string }>;
      };
    });
    expect(interrupted.recordings).toContainEqual(
      expect.objectContaining({ journal_id: journal.journal_id }),
    );

    const staleRepairError = await recoveredRenderer.evaluate(
      async ({ repairToken, sessionId }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        try {
          await invoke("resolve_recording_repair", {
            session: sessionId,
            repair_token: repairToken,
            action: "retry_step",
          });
          return "accepted";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      {
        repairToken: repair.repair.repairToken,
        sessionId: recordingSession.id,
      },
    );
    expect(staleRepairError).toContain("recording repair session is not live");

    const recovered = await recoveredRenderer.evaluate(async (journalId) => {
      const invoke = (
        window as never as {
          __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke;
      return (await invoke("recover_interrupted_recording", {
        version: 1,
        journal_id: journalId,
        request_id: "record-engine-recovery-e2e",
      })) as { bundle_path: string; verdict: string };
    }, journal.journal_id);
    expect(["repairable", "failed"]).toContain(recovered.verdict);

    const manifest = JSON.parse(
      await fs.readFile(path.join(recovered.bundle_path, "manifest.json"), "utf8"),
    ) as {
      verdict: string;
      artifacts: Array<{
        kind: string;
        relative_path: string;
        sha256: string;
      }>;
    };
    expect(manifest.verdict).toBe(recovered.verdict);
    expect(manifest.verdict).not.toBe("passed");
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "segment",
        relative_path: segment.relative_path,
        sha256: segmentHash,
      }),
    );
    expect(
      createHash("sha256")
        .update(await fs.readFile(path.join(recovered.bundle_path, segment.relative_path)))
        .digest("hex"),
    ).toBe(segmentHash);
  } finally {
    await firstApp?.close().catch(() => undefined);
    await recoveredApp?.close().catch(() => undefined);
    await fixture.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
