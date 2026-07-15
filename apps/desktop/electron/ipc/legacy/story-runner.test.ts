import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingActionLandmarkRecorder } from "../action-landmarks";
import {
  type ActionCursorTiming,
  type ActionInputTiming,
  type ActionTarget,
  type ActionTimelineEvent,
  actionsSidecarPath,
} from "../action-timeline";
import { estimateCursorTravelDelayMs, initialCursorPoint } from "../cursor-timing";
import {
  discoverCommittedSceneAttempts,
  disposeRecordingCheckpoints,
  recordingCheckpointsForSession,
  registerRecordingCheckpoints,
} from "../recording-checkpoints";
import { RecordingMediaClock } from "../recording-media-clock";
import { RecordingPauseGate } from "../recording-pause-gate";
import { invalidateRecordingRepair, recordingRepairController } from "../recording-repair";
import { recordEngineLog } from "../recording-observability";
import { AUTOMATION_RECORDING_TAIL_DURATION_MS } from "../recording-tail";
import { type ParsedCommand, parseStorySource } from "../story-parser";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/storycapture-test",
  },
  BrowserWindow: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("../recording-observability", () => ({
  recordEngineLog: vi.fn(async () => null),
}));

vi.mock("./capture-preview", () => ({
  authorSession: vi.fn(),
  captureAutomationRecordingTail: vi.fn(),
  ensureRecordingFramesCoverElapsedTime: vi.fn(),
  invalidateAuthorPreviewPaintForContents: vi.fn(),
  normalizedTargetRecord: (value: unknown) => value,
  recordingFrameCommitBudgetMs: () => 500,
  storyBrowserExecutionProfile: (options?: { captureRecordingFrames?: boolean }) => ({
    typingMode: "incremental",
    captureRecordingFrames: options?.captureRecordingFrames ?? false,
    cursorMotionPreset: "natural",
    minCursorLeadMs: 320,
    injectCursorPath: true,
    targetStabilityThresholdPx: 8,
    settleDelayForCommand: () => 0,
  }),
  targetsPathFor: (storyPath: string) => `${storyPath}.targets.json`,
}));

vi.mock("./recording", () => ({
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  stopRecording: vi.fn(),
}));

import { authorSession } from "./capture-preview";
import { stopRecording } from "./recording";
import { type RecordingSession, recordingSessions } from "./shared";
import {
  commandContributesCursorEvent,
  commandGetsPreActionPacing,
  commandMutatesCapturedPage,
  executeParsedCommand,
  launchAutomationCommand,
  liveSceneEntryUrlForRepair,
  rebaseActionEventsToFirstCursorInteraction,
  runStoryCommandsInBrowser,
  writeRecordingActionsSidecarBestEffort,
} from "./story-runner";

const tempDirs: string[] = [];

function target(label: string, center: { x: number; y: number }): ActionTarget {
  return {
    kind: "element",
    label,
    center,
    bounds: {
      x: center.x - 22,
      y: center.y - 22,
      w: 44,
      h: 44,
    },
  };
}

function command(verb: string, label: string): ParsedCommand {
  return {
    verb,
    target: { kind: "label", value: label },
  } as ParsedCommand;
}

function textOverlay(text: string, durationMs: number): ParsedCommand {
  return {
    verb: "text-overlay",
    text,
    duration_ms: durationMs,
  } as ParsedCommand;
}

function fakeContents(targets: ActionTarget[]) {
  const pendingTargets = [...targets];
  let latestTarget: ActionTarget | null = null;
  const sendInputEvent = vi.fn();
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("resolvedTargetGeometry")) {
      latestTarget = pendingTargets.shift() ?? latestTarget;
      if (script.includes("resolvedTargetReadiness")) {
        return latestTarget
          ? { status: "ready", target: latestTarget }
          : { status: "not_ready", reason: "not_found" };
      }
      return latestTarget;
    }
    return true;
  });
  return {
    getURL: () => "http://localhost.test",
    loadURL: vi.fn(),
    getOwnerBrowserWindow: () => ({
      getContentBounds: () => ({ width: 1280, height: 800 }),
    }),
    sendInputEvent,
    executeJavaScript,
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
    })),
    isDestroyed: () => false,
  };
}

function fakeContentsByLabel(targets: Record<string, ActionTarget>) {
  const sendInputEvent = vi.fn();
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("resolvedTargetGeometry")) {
      for (const [label, actionTarget] of Object.entries(targets)) {
        if (script.includes(label)) {
          return script.includes("resolvedTargetReadiness")
            ? { status: "ready", target: actionTarget }
            : actionTarget;
        }
      }
      return script.includes("resolvedTargetReadiness")
        ? { status: "not_ready", reason: "not_found" }
        : null;
    }
    return true;
  });
  return {
    getURL: () => "http://localhost.test",
    loadURL: vi.fn(),
    getOwnerBrowserWindow: () => ({
      getContentBounds: () => ({ width: 1280, height: 800 }),
    }),
    sendInputEvent,
    executeJavaScript,
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
    })),
    isDestroyed: () => false,
  };
}

describe("story browser cursor pacing", () => {
  it("offers scene restore only from an explicit navigation or the first-scene app entry", () => {
    const firstScene = {
      verb: "wait",
      scene_id: "scene-first",
      scene_ordinal: 1,
    } as ParsedCommand;
    const navigatedScene = {
      verb: "navigate",
      url: "https://app.example.test/settings",
      scene_id: "scene-settings",
      scene_ordinal: 2,
    } as ParsedCommand;
    const implicitLaterScene = {
      verb: "click",
      scene_id: "scene-later",
      scene_ordinal: 3,
    } as ParsedCommand;
    const commands = [firstScene, navigatedScene, implicitLaterScene];
    const storySource = `story "Demo" {
      meta {
        app: "https://app.example.test/start"
      }
      scene "First" {
        wait 1ms
      }
    }`;

    expect(liveSceneEntryUrlForRepair(commands, "scene-first", storySource)).toBe(
      "https://app.example.test/start",
    );
    expect(liveSceneEntryUrlForRepair(commands, "scene-settings", storySource)).toBe(
      "https://app.example.test/settings",
    );
    expect(liveSceneEntryUrlForRepair(commands, "scene-later", storySource)).toBeNull();
  });

  it("writes a valid empty v3 sidecar for a strict zero-interaction recording", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_MODE", "strict");
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_LEGACY_KILL_SWITCH", "0");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-actions-v3-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "recording.mp4");
    const session = {
      id: "session-empty-v3",
      outputPath,
      width: 1280,
      height: 720,
      outputWidth: 1280,
      outputHeight: 720,
      fps: 30,
      frameSeq: 0,
      target: { kind: "author_preview" },
      frameCrop: null,
      mediaClock: new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 }),
    } as RecordingSession;

    await writeRecordingActionsSidecarBestEffort(session, []);

    const written = JSON.parse(await fs.readFile(actionsSidecarPath(outputPath), "utf8"));
    expect(written.version).toBe(3);
    expect(written.events).toEqual([]);
    expect(written.media_clock.clock).toBe("encoded_video_pts");
  });

  it("uses the typed event when an actions sidecar cannot be written", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_MODE", "strict");
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_LEGACY_KILL_SWITCH", "0");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-actions-failure-"));
    tempDirs.push(dir);
    const blocker = path.join(dir, "not-a-directory");
    await fs.writeFile(blocker, "blocked");
    const session = {
      id: "session-sidecar-failure",
      outputPath: path.join(blocker, "recording.mp4"),
      width: 1280,
      height: 720,
      outputWidth: 1280,
      outputHeight: 720,
      fps: 30,
      frameSeq: 0,
      target: { kind: "author_preview" },
      frameCrop: null,
      mediaClock: new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 }),
    } as RecordingSession;

    await expect(writeRecordingActionsSidecarBestEffort(session, [])).rejects.toBeDefined();
    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recording.sidecar.write_failed",
        context: expect.objectContaining({
          session_id: session.id,
          phase: "actions",
          reason_code: "sidecar_write_failed",
        }),
        details: { sidecar_kind: "actions" },
      }),
    );
  });

  it("commits one immutable checkpoint segment per parsed scene", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-runner-scenes-"));
    tempDirs.push(dir);
    const segmentsDir = path.join(dir, "segments");
    const sessionId = "runner-scene-checkpoints";
    const coordinator = registerRecordingCheckpoints({
      sessionId,
      segmentsDir,
      width: 2,
      height: 2,
      fps: 30,
      declareArtifacts: async () => {},
      encoderFactory: ({ partialPath, finalPath }) => ({
        write: async () => {},
        finish: async () => {
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(partialPath, "segment");
          await fs.rename(partialPath, finalPath);
        },
        abort: async () => fs.rm(partialPath, { force: true }),
      }),
    });
    const story = parseStorySource(`story "Checkpoint demo" {
scene "First" {
  wait 0ms
}
scene "Second" {
  wait 0ms
}
}`).ast;
    const commands = story?.scenes.flatMap((scene) => scene.commands) as ParsedCommand[];
    const masterClock = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });
    const captureSceneTail = vi.fn(async () => {});

    const result = await runStoryCommandsInBrowser({
      contents: fakeContents([]) as never,
      commands,
      projectFolder: dir,
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingCheckpointSessionId: sessionId,
      recordingMediaClockSnapshot: () => masterClock.snapshot(),
      captureSceneTail,
      requestFrameCommit: async () => {
        const landmark = masterClock.commitFrame(true);
        if (!landmark)
          return { status: "degraded" as const, reason: "frame_capture_failed" as const };
        await coordinator.recordFrame(new Uint8Array(16), landmark);
        return { status: "committed" as const, landmark };
      },
      captureStateSnapshot: () => ({ frames_dropped: 0 }),
    });

    expect(result).toMatchObject({ succeeded: 2, failed: 0, exitReason: "completed" });
    expect(captureSceneTail).toHaveBeenCalledTimes(2);
    await expect(discoverCommittedSceneAttempts(segmentsDir)).resolves.toHaveLength(2);
    await disposeRecordingCheckpoints(sessionId);
  });

  it("keeps the monolithic result authoritative when shadow checkpoints diverge", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-runner-shadow-"));
    tempDirs.push(dir);
    const sessionId = "runner-shadow-divergence";
    const coordinator = registerRecordingCheckpoints({
      sessionId,
      segmentsDir: path.join(dir, "segments"),
      width: 2,
      height: 2,
      fps: 30,
      declareArtifacts: async () => {},
      encoderFactory: () => ({
        write: async () => {
          throw new Error("synthetic encoder failure");
        },
        finish: async () => {},
        abort: async () => {},
      }),
    });
    const story = parseStorySource(`story "Checkpoint demo" {
scene "First" {
  wait 0ms
}
}`).ast;
    const commands = story?.scenes.flatMap((scene) => scene.commands) as ParsedCommand[];
    const masterClock = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });

    const result = await runStoryCommandsInBrowser({
      contents: fakeContents([]) as never,
      commands,
      projectFolder: dir,
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingCheckpointSessionId: sessionId,
      recordingMediaClockSnapshot: () => masterClock.snapshot(),
      requestFrameCommit: async () => {
        const landmark = masterClock.commitFrame(true);
        if (!landmark)
          return { status: "degraded" as const, reason: "frame_capture_failed" as const };
        await coordinator.recordFrame(new Uint8Array(16), landmark);
        return { status: "committed" as const, landmark };
      },
    });

    expect(result).toMatchObject({ succeeded: 1, failed: 0, exitReason: "completed" });
    expect(recordingCheckpointsForSession(sessionId)).toBeNull();
  });

  it("pauses for a phase-safe repair decision and aborts with salvage", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_REPAIR_MODE", "manual_hybrid");
    vi.stubEnv("STORYCAPTURE_UPLOAD_EXECUTION_MODE", "off");
    const sessionId = "runner-live-repair";
    const controller = recordingRepairController(sessionId);
    const pauseGate = new RecordingPauseGate();
    const pauseRecordingForRepair = vi.fn(async () => undefined);
    const resumeRecordingForRepair = vi.fn(async () => undefined);
    const eventSpy = vi.fn((event: { repair_token: string; allowed_actions: string[] }) => {
      controller.resolve({
        session_id: sessionId,
        repair_token: event.repair_token,
        action: "abort_keep_salvage",
      });
    });
    const failedSpy = vi.fn();
    const upload = {
      ...command("upload", "File"),
      path: "assets/demo.txt",
      step_id: "step-upload",
      scene_id: "scene-upload",
      scene_name: "Upload",
      scene_ordinal: 1,
      step_ordinal: 1,
    } as ParsedCommand;

    const result = await runStoryCommandsInBrowser({
      contents: fakeContents([]) as never,
      commands: [upload],
      projectFolder: "/tmp",
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingRepairSessionId: sessionId,
      pauseGate,
      pauseRecordingForRepair,
      resumeRecordingForRepair,
      onRepairRequired: eventSpy,
      hooks: { onStepFailed: failedSpy },
    });

    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "repair-required",
        phase: "pre_input",
        allowed_actions: expect.arrayContaining(["retry_step", "abort_keep_salvage"]),
      }),
    );
    expect(result).toMatchObject({ failed: 1, exitReason: "failed" });
    expect(failedSpy).toHaveBeenCalledTimes(1);
    expect(pauseRecordingForRepair).toHaveBeenCalledTimes(1);
    expect(resumeRecordingForRepair).not.toHaveBeenCalled();
    expect(pauseRecordingForRepair.mock.invocationCallOrder[0]).toBeLessThan(
      eventSpy.mock.invocationCallOrder[0] as number,
    );
    expect(pauseGate.state).toBe("running");
    invalidateRecordingRepair(sessionId);
  });

  it("awaits a timed-out presentation without replaying browser input", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_REPAIR_MODE", "manual_hybrid");
    const sessionId = "runner-presentation-repair";
    const controller = recordingRepairController(sessionId);
    const pauseGate = new RecordingPauseGate();
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    actionLandmarks.commitFrame({ frameIndex: 0, ptsUs: 0 });
    let frameIndex = 0;
    const pauseRecordingForRepair = vi.fn(async () => undefined);
    const resumeRecordingForRepair = vi.fn(async () => undefined);
    const failedSpy = vi.fn();
    const succeededSpy = vi.fn();
    const eventSpy = vi.fn(
      (event: {
        allowed_actions: string[];
        phase: string;
        reason_code: string;
        repair_token: string;
      }) => {
        controller.resolve({
          session_id: sessionId,
          repair_token: event.repair_token,
          action: "await_presentation",
        });
        setTimeout(() => {
          frameIndex += 1;
          actionLandmarks.notePaint();
          actionLandmarks.commitFrame({ frameIndex, ptsUs: frameIndex * 33_333 });
        }, 10);
      },
    );
    const contents = fakeContents([target("Delayed control", { x: 460, y: 320 })]);
    const click = {
      ...command("click", "Delayed control"),
      step_id: "step-presentation",
      scene_id: "scene-presentation",
      scene_name: "Presentation",
      scene_ordinal: 1,
      step_ordinal: 1,
    } as ParsedCommand;

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [click],
      projectFolder: "/tmp",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        cursorMotionPreset: "natural",
        injectCursorPath: true,
        settleDelayForCommand: () => 0,
      },
      recordingRepairSessionId: sessionId,
      pauseGate,
      pauseRecordingForRepair,
      resumeRecordingForRepair,
      onRepairRequired: eventSpy,
      actionLandmarks,
      requestFrameCommit: async () => {
        frameIndex += 1;
        const landmark = { frameIndex, ptsUs: frameIndex * 33_333 };
        actionLandmarks.commitFrame(landmark);
        return { status: "committed" as const, landmark };
      },
      hooks: { onStepFailed: failedSpy, onStepSucceeded: succeededSpy },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0, exitReason: "completed" });
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "input_emitted_presentation_pending",
        reason_code: "presentation_timeout",
        allowed_actions: expect.arrayContaining(["await_presentation"]),
      }),
    );
    expect(
      contents.sendInputEvent.mock.calls.filter(([event]) => event.type === "mouseDown"),
    ).toHaveLength(1);
    expect(pauseRecordingForRepair).toHaveBeenCalledTimes(1);
    expect(resumeRecordingForRepair).toHaveBeenCalledTimes(1);
    expect(failedSpy).not.toHaveBeenCalled();
    expect(succeededSpy).toHaveBeenCalledTimes(1);
    invalidateRecordingRepair(sessionId);
  });

  it.each([
    ["click", ["down", "up", "action"]],
    ["type", ["down", "up", "text_start", "text_end", "action"]],
    ["select", ["down", "up", "text_start", "text_end", "action"]],
  ] as const)("records %s landmarks at the browser side effects", async (verb, expected) => {
    const actionTarget = target("Control", { x: 240, y: 180 });
    const contents = fakeContents([actionTarget]);
    const landmarks: string[] = [];

    await executeParsedCommand(contents as never, command(verb, "Control"), "/tmp", {
      resolvedTarget: actionTarget,
      beforeInputSideEffect: () => landmarks.push("armed"),
      onInputSideEffect: (kind) => landmarks.push(kind),
    });

    expect(landmarks).toEqual(["armed", ...expected]);
  });

  it("executes upload through CDP and returns only privacy-safe asset metadata", async () => {
    vi.stubEnv("STORYCAPTURE_UPLOAD_EXECUTION_MODE", "on");
    const inputTarget = {
      ...target("Upload file", { x: 320, y: 220 }),
      kind: "file_input",
    };
    const sendCommand = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.setFileInputFiles") return {};
      throw new Error(`unexpected method ${method}`);
    });
    const contents = {
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("file =")) {
          return { count: 1, basename: "sample.txt", byteSize: 12 };
        }
        if (script.includes("setAttribute")) return { ok: true, accept: ".txt" };
        return null;
      }),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand,
      },
    };
    const landmarks: string[] = [];

    const result = await executeParsedCommand(
      contents as never,
      {
        verb: "upload",
        target: { kind: "selector", value: "#file" },
        path: "assets/sample.txt",
      } as ParsedCommand,
      "/project",
      {
        resolvedTarget: inputTarget,
        resolvedUploadAsset: {
          absolutePath: "/project/assets/sample.txt",
          projectRelativePath: "assets/sample.txt",
          basename: "sample.txt",
          byteSize: 12,
        },
        onInputSideEffect: (kind) => landmarks.push(kind),
      },
    );

    expect(result).toMatchObject({
      target: inputTarget,
      uploadAsset: {
        projectRelativePath: "assets/sample.txt",
        basename: "sample.txt",
        byteSize: 12,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/project/");
    expect(landmarks).toEqual(["action"]);
    expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      files: ["/project/assets/sample.txt"],
      nodeId: 2,
    });
  });

  it("records a hover action landmark without inventing button input", async () => {
    const actionTarget = target("Menu", { x: 240, y: 180 });
    const contents = fakeContents([actionTarget]);
    const landmarks: string[] = [];
    await executeParsedCommand(contents as never, command("hover", "Menu"), "/tmp", {
      resolvedTarget: actionTarget,
      onInputSideEffect: (kind) => landmarks.push(kind),
    });
    expect(landmarks).toEqual(["action"]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(recordEngineLog).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    recordingSessions.clear();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("classifies only user-visible interaction commands as cursor events", () => {
    expect(commandContributesCursorEvent(command("click", "Sign in"))).toBe(true);
    expect(commandContributesCursorEvent(command("type", "Email"))).toBe(true);
    expect(commandContributesCursorEvent(command("hover", "Menu"))).toBe(true);
    expect(commandContributesCursorEvent(command("select", "Plan"))).toBe(true);
    expect(commandContributesCursorEvent(command("upload", "Avatar"))).toBe(true);
    expect(commandContributesCursorEvent(command("drag", "Card"))).toBe(true);
    expect(commandContributesCursorEvent(command("wait-for", "Heading"))).toBe(false);
    expect(commandContributesCursorEvent(command("assert", "Heading"))).toBe(false);
    expect(commandGetsPreActionPacing(command("wait-for", "Heading"))).toBe(false);
    expect(commandContributesCursorEvent(textOverlay("Welcome", 2_000))).toBe(false);
    expect(commandGetsPreActionPacing(textOverlay("Welcome", 2_000))).toBe(false);
  });

  it("executes the promoted sidecar primary in runtime-target enforce mode", async () => {
    vi.stubEnv("STORYCAPTURE_RUNTIME_TARGET_MODE", "enforce");
    const contents = fakeContentsByLabel({ Primary: target("Primary", { x: 360, y: 220 }) });
    const succeeded = vi.fn();
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [{ ...command("click", "Story"), step_id: "step-1", timeout_ms: 500 }],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: {
        version: 1,
        steps: {
          "step-1": {
            primary: { kind: "label", value: "Primary" },
            fallbacks: [{ kind: "label", value: "Fallback" }],
          },
        },
      },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onStepSucceeded: succeeded },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(
      (succeeded.mock.calls[0][0].result as { runtimeTarget?: { candidate: unknown } })
        .runtimeTarget,
    ).toMatchObject({ candidate: { source: "sidecar_primary", fallbackIndex: null } });
    expect(contents.sendInputEvent).toHaveBeenCalled();
  });

  it("uses the first ready stored fallback after primary and story target fail", async () => {
    vi.stubEnv("STORYCAPTURE_RUNTIME_TARGET_MODE", "enforce");
    const contents = fakeContentsByLabel({ Fallback: target("Fallback", { x: 420, y: 260 }) });
    const succeeded = vi.fn();
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [{ ...command("click", "Story"), step_id: "step-1", timeout_ms: 500 }],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: {
        version: 1,
        steps: {
          "step-1": {
            primary: { kind: "label", value: "Primary" },
            fallbacks: [{ kind: "label", value: "Fallback" }],
          },
        },
      },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onStepSucceeded: succeeded },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(
      (
        succeeded.mock.calls[0][0].result as {
          runtimeTarget?: { candidate: unknown; attempts: unknown[] };
        }
      ).runtimeTarget,
    ).toMatchObject({
      candidate: { source: "sidecar_fallback", fallbackIndex: 0 },
      attempts: [
        { source: "sidecar_primary", reason: "not_found" },
        { source: "story_target", reason: "not_found" },
      ],
    });
  });

  it("fails once with an ordered sanitized trail when candidates are exhausted", async () => {
    vi.stubEnv("STORYCAPTURE_RUNTIME_TARGET_MODE", "enforce");
    const contents = fakeContentsByLabel({});
    const failed = vi.fn();
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [{ ...command("click", "Story"), step_id: "step-1", timeout_ms: 100 }],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: {
        version: 1,
        steps: {
          "step-1": {
            primary: { kind: "label", value: "Primary" },
            fallbacks: [{ kind: "label", value: "Fallback" }],
          },
        },
      },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onStepFailed: failed },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 0, failed: 1, exitReason: "failed" });
    expect(failed).toHaveBeenCalledOnce();
    const error = failed.mock.calls[0][1] as Error & {
      reason?: string;
      attempts?: unknown[];
    };
    expect(error).toMatchObject({
      reason: "target_candidates_exhausted",
      attempts: [
        { source: "sidecar_primary", reason: "not_found" },
        { source: "story_target", reason: "not_found" },
        { source: "sidecar_fallback", reason: "not_found" },
      ],
    });
    expect(JSON.stringify(error)).not.toContain("Primary");
    expect(JSON.stringify(error)).not.toContain("Fallback");
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("guards every command that can mutate the captured page", () => {
    for (const verb of ["navigate", "scroll", "click", "type", "hover", "select", "upload"]) {
      expect(commandMutatesCapturedPage({ verb } as ParsedCommand)).toBe(true);
    }
    for (const verb of [
      "wait",
      "pause",
      "text-overlay",
      "wait-for",
      "wait-for-visible",
      "assert",
      "assert-visible",
      "screenshot",
    ]) {
      expect(commandMutatesCapturedPage({ verb } as ParsedCommand)).toBe(false);
    }
  });

  it("waits the full text overlay duration without browser or input side effects", async () => {
    const contents = fakeContents([]);
    const inputSideEffect = vi.fn();
    let completed = false;
    const execution = executeParsedCommand(
      contents as never,
      textOverlay("Welcome", 30_001),
      "/tmp",
      { onInputSideEffect: inputSideEffect },
    ).then((result) => {
      completed = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(execution).resolves.toEqual({});
    expect(contents.loadURL).not.toHaveBeenCalled();
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
    expect(contents.capturePage).not.toHaveBeenCalled();
    expect(inputSideEffect).not.toHaveBeenCalled();
  });

  it("runs text overlays sequentially and preserves their step timing hooks", async () => {
    const contents = fakeContents([]);
    const started: Array<[number, number]> = [];
    const succeeded: Array<{
      ordinal: number;
      durationMs: number;
      actionDurationMs: number;
      timing?: { stepStartedAtMs: number; actionAtMs: number; stepEndedAtMs: number };
    }> = [];
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [textOverlay("First", 250), textOverlay("Second", 400)],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: {
        onStepStarted: (ordinal) => started.push([ordinal, Date.now()]),
        onStepSucceeded: (step) => succeeded.push(step),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({
      succeeded: 2,
      failed: 0,
      exitReason: "completed",
      durationMs: 650,
    });
    expect(started).toEqual([
      [1, 0],
      [2, 250],
    ]);
    expect(succeeded).toMatchObject([
      {
        ordinal: 1,
        durationMs: 250,
        actionDurationMs: 250,
        timing: { stepStartedAtMs: 0, actionAtMs: 0, stepEndedAtMs: 250 },
      },
      {
        ordinal: 2,
        durationMs: 400,
        actionDurationMs: 400,
        timing: { stepStartedAtMs: 250, actionAtMs: 250, stepEndedAtMs: 650 },
      },
    ]);
  });

  it("freezes a text overlay delay while recording is paused", async () => {
    const pauseGate = new RecordingPauseGate();
    const started: number[] = [];
    const succeeded: number[] = [];
    const run = runStoryCommandsInBrowser({
      contents: fakeContents([]) as never,
      commands: [textOverlay("Paused", 1_000), textOverlay("Next", 100)],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      pauseGate,
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: {
        onStepStarted: (ordinal) => started.push(ordinal),
        onStepSucceeded: ({ ordinal }) => succeeded.push(ordinal),
      },
    });

    await vi.advanceTimersByTimeAsync(250);
    pauseGate.pause();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(started).toEqual([1]);
    expect(succeeded).toEqual([]);

    pauseGate.resume();
    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 2, failed: 0 });
    expect(started).toEqual([1, 2]);
    expect(succeeded).toEqual([1, 2]);
  });

  it("cancels an active text overlay delay without failing or starting the next step", async () => {
    const pauseGate = new RecordingPauseGate();
    const started: number[] = [];
    const succeeded = vi.fn();
    const failed = vi.fn();
    const run = runStoryCommandsInBrowser({
      contents: fakeContents([]) as never,
      commands: [textOverlay("Cancel me", 1_000), textOverlay("Never starts", 100)],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      pauseGate,
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: {
        onStepStarted: (ordinal) => started.push(ordinal),
        onStepSucceeded: succeeded,
        onStepFailed: failed,
      },
    });

    await vi.advanceTimersByTimeAsync(250);
    pauseGate.cancel();

    await expect(run).resolves.toMatchObject({
      succeeded: 0,
      failed: 0,
      exitReason: "cancelled",
    });
    expect(started).toEqual([1]);
    expect(succeeded).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("captures the normal post-step frame after a text overlay delay", async () => {
    const frameDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-text-overlay-"));
    tempDirs.push(frameDir);
    const contents = fakeContents([]);
    const frames: Array<{ duration_ms: number; screenshot_path: string | null }> = [];
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [textOverlay("Capture me", 100)],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      frameDir,
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onFrameCaptured: (_ordinal, frame) => frames.push(frame) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(contents.capturePage).toHaveBeenCalledTimes(1);
    expect(frames).toMatchObject([
      {
        duration_ms: 100,
        screenshot_path: path.join(frameDir, "step-0001.png"),
      },
    ]);
    await expect(fs.stat(path.join(frameDir, "step-0001.png"))).resolves.toBeDefined();
  });

  it("re-resolves a semantic target after the prepared target detaches", async () => {
    const replacement = target("Search Wikipedia", { x: 520, y: 240 });
    let readinessCalls = 0;
    let prepareCalls = 0;
    const contents = {
      ...fakeContents([]),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("resolvedTargetReadiness")) {
          readinessCalls += 1;
          if (readinessCalls === 1) {
            return { status: "not_ready", reason: "outside_viewport" };
          }
          return { status: "ready", target: replacement };
        }
        if (script.includes("viewportDiagonal")) {
          prepareCalls += 1;
          return null;
        }
        return true;
      }),
    };
    const successes: ActionTarget[] = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [{ ...command("type", "Search Wikipedia"), text: "ElectronJS" }],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onStepSucceeded: ({ result }) => successes.push(result.target as ActionTarget) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(prepareCalls).toBe(1);
    expect(successes).toEqual([replacement]);
  });

  it("bounds repeated detach recovery and reports the final attempt", async () => {
    let prepareCalls = 0;
    let readinessCalls = 0;
    const contents = {
      ...fakeContents([]),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("resolvedTargetReadiness")) {
          readinessCalls += 1;
          return readinessCalls === 1
            ? { status: "not_ready", reason: "outside_viewport" }
            : { status: "not_ready", reason: "detached" };
        }
        if (script.includes("viewportDiagonal")) {
          prepareCalls += 1;
          return null;
        }
        return true;
      }),
    };
    const failures: unknown[] = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [{ ...command("type", "Search Wikipedia"), text: "ElectronJS" }],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingSessionId: "recording-target-retry",
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: { onStepFailed: (_ordinal, error) => failures.push(error) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 0, failed: 1 });
    expect(prepareCalls).toBe(1);
    expect(failures[0]).toMatchObject({
      message: expect.stringContaining("detached after 3 attempts"),
    });
    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recording.target.retry_scheduled",
        context: expect.objectContaining({
          session_id: "recording-target-retry",
          reason_code: "detached",
        }),
      }),
    );
  });

  it("does not retry a cancelled scroll as a detached target", async () => {
    let prepareCalls = 0;
    const contents = {
      ...fakeContents([]),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("resolvedTargetReadiness")) {
          return { status: "not_ready", reason: "outside_viewport" };
        }
        if (script.includes("viewportDiagonal")) {
          prepareCalls += 1;
          return { distance: 1_000, viewportDiagonal: 1_000, planCount: 1 };
        }
        return true;
      }),
    };

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Search Wikipedia")],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      pauseGate: {
        waitUntilRunning: async () => true,
        waitForDelay: async () => false,
      } as never,
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ failed: 0, exitReason: "cancelled" });
    expect(prepareCalls).toBe(1);
  });

  it("rebases recorded cursor events to the first visible interaction", () => {
    const sourceEvents: ActionTimelineEvent[] = [
      {
        step_id: null,
        ordinal: 3,
        verb: "type",
        t_start_ms: 900,
        t_action_ms: 900,
        t_end_ms: 1400,
        target: target("Email", { x: 460, y: 320 }),
        secondary_target: null,
        pointer: null,
        cursor_timing: {
          motion_preset: "natural",
          start_ms: 900,
          arrival_ms: 1220,
          travel_ms: 320,
          dwell_ms: 0,
        },
        input_timing: {
          kind: "type",
          down_ms: 1400,
          up_ms: 1400,
          action_ms: 1400,
          text_start_ms: 1400,
          text_end_ms: 1400,
        },
      },
      {
        step_id: null,
        ordinal: 4,
        verb: "click",
        t_start_ms: 2100,
        t_action_ms: 2100,
        t_end_ms: 2250,
        target: target("Sign in", { x: 460, y: 470 }),
        secondary_target: null,
        pointer: { button: "left", effect: "click" },
      },
    ];

    const events = rebaseActionEventsToFirstCursorInteraction(sourceEvents);

    expect(events.map((event) => [event.t_start_ms, event.t_action_ms, event.t_end_ms])).toEqual([
      [0, 0, 500],
      [1200, 1200, 1350],
    ]);
    expect(events[0]?.cursor_timing).toMatchObject({
      start_ms: 0,
      arrival_ms: 320,
      travel_ms: 320,
    });
    expect(events[0]?.input_timing).toMatchObject({
      action_ms: 500,
      text_start_ms: 500,
      text_end_ms: 500,
    });
  });

  it("waits for cursor travel before sending recorded click input", async () => {
    const size = { width: 1280, height: 800 };
    const clickTarget = target("Sign in", { x: 460, y: 320 });
    const contents = fakeContents([clickTarget]);
    const expectedDelayMs = Math.max(
      320,
      estimateCursorTravelDelayMs({
        from: initialCursorPoint(size),
        target: clickTarget,
        size,
      }),
    );
    const readinessDelayMs = 16;
    const revalidationDelayMs = 100;
    const totalDelayMs = readinessDelayMs + expectedDelayMs + revalidationDelayMs;
    const successes: Array<{
      actionDurationMs: number;
      timing?: {
        stepStartedAtMs: number;
        actionAtMs: number;
        stepEndedAtMs: number;
        cursorTiming?: ActionCursorTiming | null;
        inputTiming?: ActionInputTiming | null;
      };
    }> = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Sign in")],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: size,
        settleDelayForCommand: () => 0,
      },
      recordingClockMs: () => Date.now() / 2,
      hooks: {
        onStepSucceeded: (step) => {
          successes.push({ actionDurationMs: step.actionDurationMs, timing: step.timing });
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(readinessDelayMs);
    expect(contents.sendInputEvent.mock.calls.some(([event]) => event.type === "mouseDown")).toBe(
      false,
    );

    await vi.runAllTimersAsync();
    await run;

    const events = contents.sendInputEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === "mouseMove").length).toBeGreaterThan(1);
    expect(events).toContainEqual({
      type: "mouseMove",
      x: clickTarget.center.x,
      y: clickTarget.center.y,
    });
    expect(events.findIndex((event) => event.type === "mouseDown")).toBeGreaterThan(
      events.findIndex((event) => event.type === "mouseMove"),
    );
    expect(successes).toHaveLength(1);
    expect(successes[0]?.actionDurationMs).toBe(totalDelayMs);
    expect(successes[0]?.timing?.stepStartedAtMs).toBe(0);
    expect(successes[0]?.timing?.actionAtMs).toBeCloseTo(totalDelayMs / 2);
    expect(successes[0]?.timing?.stepEndedAtMs).toBeCloseTo(totalDelayMs / 2);
    expect(successes[0]?.timing?.cursorTiming).toMatchObject({
      motion_preset: "natural",
      start_ms: readinessDelayMs / 2,
    });
    expect(successes[0]?.timing?.inputTiming).toMatchObject({
      kind: "click",
    });
    expect(successes[0]?.timing?.inputTiming?.action_ms).toBe(Math.round(totalDelayMs / 2));
  });

  it("continues type input when cursor arrival cannot be committed to a frame", async () => {
    const inputTarget = target("Search Wikipedia", { x: 460, y: 320 });
    const contents = fakeContents([inputTarget]);
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    const typeCommand = {
      verb: "type",
      target: { kind: "role", value: { role: "textbox", name: "Search Wikipedia" } },
      text: "ElectronJS",
    } as ParsedCommand;
    const requestFrameCommit = vi.fn(async () => ({
      status: "degraded" as const,
      reason: "frame_commit_timeout" as const,
    }));

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [typeCommand],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingSessionId: "recording-readiness",
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        settleDelayForCommand: () => 0,
      },
      actionLandmarks,
      requestFrameCommit,
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(requestFrameCommit).toHaveBeenCalledTimes(1);
    expect(
      contents.executeJavaScript.mock.calls.some(([script]) => script.includes("ElectronJS")),
    ).toBe(true);
    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recording.readiness.degraded",
        context: expect.objectContaining({
          session_id: "recording-readiness",
          phase: "cursor_arrival",
          reason_code: "frame_commit_timeout",
        }),
      }),
    );
  });

  it("records healthy type landmarks from an explicitly committed frame", async () => {
    const inputTarget = target("Search Wikipedia", { x: 460, y: 320 });
    const contents = fakeContents([inputTarget]);
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    const committed = { frameIndex: 0, ptsUs: 0 };
    const successfulSteps: Array<{ timing?: { landmarks?: unknown } }> = [];
    const requestFrameCommit = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      actionLandmarks.commitFrame(committed);
      setTimeout(() => actionLandmarks.commitFrame({ frameIndex: 1, ptsUs: 16_667 }), 10);
      return { status: "committed" as const, landmark: committed };
    });

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [
        {
          verb: "type",
          target: { kind: "role", value: { role: "textbox", name: "Search Wikipedia" } },
          text: "ElectronJS",
        } as ParsedCommand,
      ],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        settleDelayForCommand: () => 0,
      },
      actionLandmarks,
      requestFrameCommit,
      frameSyncTimeoutMs: 1_000,
      hooks: { onStepSucceeded: (step) => successfulSteps.push(step) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(successfulSteps[0]?.timing?.landmarks).toMatchObject({
      cursorPath: { arrival: committed },
      input: { action: committed, text_start: committed, text_end: committed },
      presentation: { status: "presented", firstPostInputFrame: { frameIndex: 1 } },
    });
  });

  it("executes a framed drag with ordered landmarks and guaranteed release", async () => {
    vi.stubEnv("STORYCAPTURE_DRAG_EXECUTION_MODE", "on");
    vi.stubEnv("STORYCAPTURE_RUNTIME_TARGET_MODE", "off");
    const source = target("Source", { x: 260, y: 300 });
    const destination = target("Destination", { x: 620, y: 340 });
    const contents = fakeContentsByLabel({ Source: source, Destination: destination });
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    const committed = { frameIndex: 0, ptsUs: 0 };
    const successfulSteps: Array<{
      result?: unknown;
      timing?: { landmarks?: unknown };
    }> = [];
    const requestFrameCommit = vi.fn(async () => {
      actionLandmarks.commitFrame(committed);
      setTimeout(() => actionLandmarks.commitFrame({ frameIndex: 1, ptsUs: 33_333 }), 300);
      return { status: "committed" as const, landmark: committed };
    });

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [
        {
          verb: "drag",
          from: { kind: "label", value: "Source" },
          to: { kind: "label", value: "Destination" },
        } as ParsedCommand,
      ],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        cursorMotionPreset: "natural",
        injectCursorPath: true,
        settleDelayForCommand: () => 0,
      },
      actionLandmarks,
      requestFrameCommit,
      frameSyncTimeoutMs: 1_000,
      hooks: { onStepSucceeded: (step) => successfulSteps.push(step) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(
      contents.sendInputEvent.mock.calls.filter(([event]) => event.type === "mouseDown"),
    ).toHaveLength(1);
    expect(
      contents.sendInputEvent.mock.calls.filter(([event]) => event.type === "mouseUp"),
    ).toHaveLength(1);
    expect(successfulSteps[0]?.result).toMatchObject({
      source,
      target: destination,
      pointer: { button: "left", effect: "drag" },
    });
    expect(successfulSteps[0]?.timing?.landmarks).toMatchObject({
      cursorPath: { arrival: committed },
      input: { down: committed, up: committed, action: committed },
      presentation: { status: "presented", firstPostInputFrame: { frameIndex: 1 } },
    });
  });

  it("does not send drag mouse-down when the source arrival barrier degrades", async () => {
    vi.stubEnv("STORYCAPTURE_DRAG_EXECUTION_MODE", "on");
    vi.stubEnv("STORYCAPTURE_RUNTIME_TARGET_MODE", "off");
    const contents = fakeContentsByLabel({
      Source: target("Source", { x: 260, y: 300 }),
      Destination: target("Destination", { x: 620, y: 340 }),
    });
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [
        {
          verb: "drag",
          from: { kind: "label", value: "Source" },
          to: { kind: "label", value: "Destination" },
        } as ParsedCommand,
      ],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        cursorMotionPreset: "natural",
        injectCursorPath: true,
        settleDelayForCommand: () => 0,
      },
      actionLandmarks: new RecordingActionLandmarkRecorder(),
      requestFrameCommit: async () => ({
        status: "degraded",
        reason: "frame_capture_failed",
      }),
      frameSyncTimeoutMs: 100,
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 0, failed: 1, exitReason: "failed" });
    expect(contents.sendInputEvent.mock.calls.some(([event]) => event.type === "mouseDown")).toBe(
      false,
    );
  });

  it.each([
    "click",
    "select",
  ] as const)("continues %s input when frame synchronization degrades", async (verb) => {
    const contents = fakeContents([target("Control", { x: 460, y: 320 })]);
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    const parsedCommand = {
      ...command(verb, "Control"),
      ...(verb === "select" ? { value: "Option A" } : {}),
    } as ParsedCommand;

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [parsedCommand],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        settleDelayForCommand: () => 0,
      },
      actionLandmarks,
      requestFrameCommit: async () => ({
        status: "degraded",
        reason: "frame_capture_failed",
      }),
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(
      contents.sendInputEvent.mock.calls.filter(([event]) => event.type === "mouseDown"),
    ).toHaveLength(1);
  });

  it("cancels before input when the recording frame request is cancelled", async () => {
    const contents = fakeContents([target("Search Wikipedia", { x: 460, y: 320 })]);
    const actionLandmarks = new RecordingActionLandmarkRecorder();
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [
        {
          verb: "type",
          target: { kind: "role", value: { role: "textbox", name: "Search Wikipedia" } },
          text: "ElectronJS",
        } as ParsedCommand,
      ],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: { width: 1280, height: 800 },
        settleDelayForCommand: () => 0,
      },
      actionLandmarks,
      requestFrameCommit: async () => ({ status: "cancelled" }),
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({
      succeeded: 0,
      failed: 0,
      exitReason: "cancelled",
    });
    expect(
      contents.executeJavaScript.mock.calls.some(([script]) => script.includes("ElectronJS")),
    ).toBe(false);
  });

  it("freezes cursor travel and browser input while recording is paused", async () => {
    const size = { width: 1280, height: 800 };
    const clickTarget = target("Sign in", { x: 460, y: 320 });
    const contents = fakeContents([clickTarget]);
    const pauseGate = new RecordingPauseGate();
    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Sign in")],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: size,
        settleDelayForCommand: () => 0,
      },
      pauseGate,
    });

    await vi.advanceTimersByTimeAsync(100);
    pauseGate.pause();
    const eventCountAtPause = contents.sendInputEvent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(contents.sendInputEvent).toHaveBeenCalledTimes(eventCountAtPause);
    expect(contents.sendInputEvent.mock.calls.some(([event]) => event.type === "mouseDown")).toBe(
      false,
    );

    pauseGate.resume();
    await vi.runAllTimersAsync();
    await run;

    expect(contents.sendInputEvent.mock.calls.some(([event]) => event.type === "mouseDown")).toBe(
      true,
    );
  });

  it("uses the final resolved target for input after a large layout shift", async () => {
    const size = { width: 1280, height: 800 };
    const initialTarget = target("Sign in", { x: 460, y: 320 });
    const shiftedTarget = target("Sign in", { x: 760, y: 520 });
    const contents = fakeContents([initialTarget, initialTarget, shiftedTarget]);

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Sign in")],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: size,
        cursorMotionPreset: "natural",
        minCursorLeadMs: 320,
        injectCursorPath: true,
        targetStabilityThresholdPx: 8,
        settleDelayForCommand: () => 0,
      },
    });

    await vi.runAllTimersAsync();
    await run;

    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseDown",
      x: shiftedTarget.center.x,
      y: shiftedTarget.center.y,
      button: "left",
      clickCount: 1,
    });
  });

  it("keeps demo-like recorded actions within the planned capture duration", async () => {
    const size = { width: 1280, height: 800 };
    const commands = [
      command("wait-for", "Heading"),
      { ...command("type", "Email"), text: "demo@example.com" },
      { ...command("type", "Password"), text: "password" },
      command("click", "Sign in"),
    ] as ParsedCommand[];
    const contents = fakeContents([
      target("Heading", { x: 640, y: 170 }),
      target("Email", { x: 460, y: 320 }),
      target("Password", { x: 460, y: 390 }),
      target("Sign in", { x: 460, y: 470 }),
    ]);
    const stepStarts = new Map<number, number>();
    const eventEnds: number[] = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands,
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "incremental",
        captureRecordingFrames: true,
        captureSize: size,
        settleDelayForCommand: (parsedCommand) => (parsedCommand.verb === "type" ? 180 : 120),
      },
      hooks: {
        onStepStarted: (ordinal) => {
          stepStarts.set(ordinal, Date.now());
        },
        onStepSucceeded: (step) => {
          const startedAt = stepStarts.get(step.ordinal) ?? Date.now() - step.durationMs;
          eventEnds.push(startedAt + step.durationMs);
        },
      },
    });

    await vi.runAllTimersAsync();
    const result = await run;
    const maxActionEndMs = Math.max(...eventEnds);
    const plannedFrameDurationMs =
      (Math.ceil(((result.durationMs + AUTOMATION_RECORDING_TAIL_DURATION_MS) / 1000) * 60) / 60) *
      1000;

    expect(maxActionEndMs).toBeGreaterThan(1133);
    expect(plannedFrameDurationMs).toBeGreaterThanOrEqual(maxActionEndMs);
  });

  it("captures one best-effort failure screenshot without replacing the primary error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-failure-"));
    tempDirs.push(dir);
    const contents = fakeContents([]);
    const failures: Array<{ error: unknown; screenshotPath?: string | null }> = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Missing")],
      projectFolder: dir,
      storySource: "",
      targets: { version: 1, steps: {} },
      failureFrameDir: path.join(dir, "diagnostics"),
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      hooks: {
        onStepFailed: (_ordinal, error, screenshotPath) => failures.push({ error, screenshotPath }),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ failed: 1, exitReason: "failed" });
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.screenshotPath).toMatch(/failure-step-0001\.png$/);
    await expect(fs.stat(failures[0]?.screenshotPath ?? "")).resolves.toBeDefined();
  });

  it("excludes non-interaction targets from recorded action sidecars", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-actions-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "recording");
    const contents = fakeContentsByLabel({
      Login: target("Login", { x: 640, y: 170 }),
      "EMAIL ADDRESS": target("EMAIL ADDRESS", { x: 460, y: 320 }),
      PASSWORD: target("PASSWORD", { x: 460, y: 390 }),
      "SIGN IN": target("SIGN IN", { x: 460, y: 470 }),
    });
    vi.mocked(authorSession).mockReturnValue({
      window: { webContents: contents },
    } as never);
    const mediaClock = new RecordingMediaClock({ fpsNum: 60, fpsDen: 1 });
    for (let frame = 0; frame < 240; frame += 1) mediaClock.commitFrame(true);
    recordingSessions.set("recording-1", {
      id: "recording-1",
      projectFolder: dir,
      outputPath,
      target: { kind: "author_preview" },
      width: 1280,
      height: 800,
      outputWidth: 1280,
      outputHeight: 800,
      fps: 60,
      startedAt: Date.now(),
      paused: false,
      lifecycle: "recording",
      mediaClock,
      pauseGate: new RecordingPauseGate(),
      eventTarget: contents,
      eventChannelId: null,
      heartbeat: undefined,
      captureTimer: null,
      framesDir: dir,
      frameSeq: 240,
      framesDropped: 0,
      skippedTicks: 0,
      encoderBackpressureEvents: 0,
      sourceFramesReceived: 0,
      captureInFlight: null,
      audioPath: null,
      frameCrop: null,
      loggedAuthorPreviewFrame: false,
      requestedFps: 60,
    } as never);
    vi.mocked(stopRecording).mockImplementationOnce(async () => {
      await expect(fs.stat(`${outputPath}.steps.json`)).resolves.toBeDefined();
      return {} as Awaited<ReturnType<typeof stopRecording>>;
    });

    const run = launchAutomationCommand(
      {
        streamId: "author-preview",
        recordingSessionId: "recording-1",
        projectFolder: dir,
        storySource: `story "Demo" {
scene "Login" {
  text-overlay "Sign in securely" 2000ms # @id=11111111-1111-4111-8111-111111111111
  wait-for heading "Login" timeout 10ms
  type field "EMAIL ADDRESS" "demo@example.com"
  type field "PASSWORD" "password"
  click button "SIGN IN"
}
}`,
      },
      { isDestroyed: () => false, send: vi.fn() } as never,
    );

    await vi.runAllTimersAsync();
    await run;

    const sidecar = JSON.parse(await fs.readFile(actionsSidecarPath(outputPath), "utf8"));
    expect(sidecar.version).toBe(2);
    expect(sidecar.cursor_motion_preset).toBe("natural");
    expect(
      sidecar.events.map((event: { verb: string; target: { label: string } | null }) => ({
        verb: event.verb,
        label: event.target?.label,
      })),
    ).toEqual([
      { verb: "type", label: "EMAIL ADDRESS" },
      { verb: "type", label: "PASSWORD" },
      { verb: "click", label: "SIGN IN" },
    ]);
    expect(
      sidecar.events.every(
        (event: { cursor_timing?: unknown; input_timing?: unknown }) =>
          event.cursor_timing && event.input_timing,
      ),
    ).toBe(true);

    const stepTimingPath = `${outputPath}.steps.json`;
    const stepTiming = JSON.parse(await fs.readFile(stepTimingPath, "utf8"));
    expect(stepTiming).toMatchObject({
      version: 1,
      recordingPath: outputPath,
      storyHash: expect.any(String),
      timebase: "recording-ms",
      status: "completed",
      captureRect: { x: 0, y: 0, width: 1280, height: 800 },
    });
    expect(stepTiming.steps).toHaveLength(5);
    expect(stepTiming.steps[0]).toMatchObject({
      ordinal: 1,
      stepId: "11111111-1111-4111-8111-111111111111",
      sceneName: "Login",
      verb: "text-overlay",
      status: "succeeded",
      target: null,
      confidence: "high",
    });
  });
});
