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
import { RecordingMediaClock } from "../recording-media-clock";
import { RecordingPauseGate } from "../recording-pause-gate";
import { AUTOMATION_RECORDING_TAIL_DURATION_MS } from "../recording-tail";
import type { ParsedCommand } from "../story-parser";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/storycapture-test",
  },
  BrowserWindow: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
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
  stopRecording: vi.fn(),
}));

vi.mock("../recording-observability", () => ({
  recordEngineLog: vi.fn(async () => null),
}));

import { recordEngineLog } from "../recording-observability";
import { authorSession } from "./capture-preview";
import { stopRecording } from "./recording";
import { recordingSessions } from "./shared";
import {
  commandContributesCursorEvent,
  commandGetsPreActionPacing,
  executeParsedCommand,
  launchAutomationCommand,
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

  it("does not invent input landmarks for hover", async () => {
    const actionTarget = target("Menu", { x: 240, y: 180 });
    const contents = fakeContents([actionTarget]);
    const landmarks: string[] = [];
    await executeParsedCommand(contents as never, command("hover", "Menu"), "/tmp", {
      resolvedTarget: actionTarget,
      onInputSideEffect: (kind) => landmarks.push(kind),
    });
    expect(landmarks).toEqual([]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(recordEngineLog).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    expect(commandContributesCursorEvent(command("upload", "Avatar"))).toBe(false);
    expect(commandContributesCursorEvent(command("drag", "Card"))).toBe(false);
    expect(commandContributesCursorEvent(command("wait-for", "Heading"))).toBe(false);
    expect(commandContributesCursorEvent(command("assert", "Heading"))).toBe(false);
    expect(commandGetsPreActionPacing(command("wait-for", "Heading"))).toBe(false);
    expect(commandContributesCursorEvent(textOverlay("Welcome", 2_000))).toBe(false);
    expect(commandGetsPreActionPacing(textOverlay("Welcome", 2_000))).toBe(false);
  });

  it("enforces source, first-frame, and pre-input recording readiness in order", async () => {
    const contents = fakeContents([target("Sign in", { x: 460, y: 320 })]);
    const order: string[] = [];
    contents.sendInputEvent.mockImplementation((event) => {
      if (event.type === "mouseDown") order.push("input");
    });
    const requireRecordingReadiness = vi.fn(async (state: string) => {
      order.push(state);
    });

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [command("click", "Sign in")],
      projectFolder: "/tmp/storycapture-test",
      storySource: "",
      targets: { version: 1, steps: {} },
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: true,
        settleDelayForCommand: () => 0,
      },
      requireRecordingReadiness,
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(order).toEqual([
      "source_ready",
      "first_frame_committed",
      "pre_input_frame_committed",
      "input",
    ]);
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
      executionProfile: {
        typingMode: "instant",
        captureRecordingFrames: false,
        settleDelayForCommand: () => 0,
      },
      recordingSessionId: "recording-detach",
      hooks: { onStepFailed: (_ordinal, error) => failures.push(error) },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ succeeded: 0, failed: 1 });
    expect(prepareCalls).toBe(1);
    expect(failures[0]).toMatchObject({
      message: expect.stringContaining("detached after 3 attempts"),
    });
    expect(
      vi
        .mocked(recordEngineLog)
        .mock.calls.filter(([entry]) => entry.event === "recording.target.retry_scheduled"),
    ).toHaveLength(3);
    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recording.target.failed",
        context: expect.objectContaining({
          session_id: "recording-detach",
          reason_code: "detach_retries_exhausted",
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
      commands: [command("wait-for", "Missing")],
      projectFolder: dir,
      storySource: "",
      targets: { version: 1, steps: {} },
      recordingSessionId: "recording-safe-target-log",
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
    const targetFailure = vi
      .mocked(recordEngineLog)
      .mock.calls.find(([entry]) => entry.event === "recording.target.failed")?.[0];
    expect(targetFailure).toMatchObject({
      context: {
        session_id: "recording-safe-target-log",
        ordinal: 1,
        phase: "target_resolution",
        reason_code: "target_not_found",
      },
      details: { verb: "wait-for", timeout_ms: 5_000 },
    });
    expect(JSON.stringify(targetFailure)).not.toContain("Missing");
  });

  it("logs an actions sidecar write failure without changing the legacy outcome", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-sidecar-failure-"));
    tempDirs.push(dir);
    const blockedParent = path.join(dir, "not-a-directory");
    await fs.writeFile(blockedParent, "blocked");
    const mediaClock = new RecordingMediaClock({ fpsNum: 60, fpsDen: 1 });
    mediaClock.commitFrame(true);
    const session = {
      id: "recording-sidecar-failure",
      outputPath: path.join(blockedParent, "recording.mp4"),
      target: { kind: "author_preview", stream_id: "author-preview" },
      width: 1280,
      height: 800,
      frameCrop: null,
      mediaClock,
    } as never;
    const event: ActionTimelineEvent = {
      step_id: null,
      ordinal: 1,
      verb: "click",
      t_start_ms: 0,
      t_action_ms: 1,
      t_end_ms: 2,
      target: null,
      secondary_target: null,
      pointer: null,
    };

    await expect(writeRecordingActionsSidecarBestEffort(session, [event])).resolves.toBeUndefined();

    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "recording.sidecar.write_failed",
        context: {
          session_id: "recording-sidecar-failure",
          phase: "actions_sidecar",
          reason_code: "write_failed",
        },
        details: { sidecar_kind: "actions", event_count: 1 },
      }),
    );
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
      requestedFps: 60,
    } as never);
    vi.mocked(stopRecording).mockClear();

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
    const outcome = await run;

    expect(outcome).toMatchObject({
      story: {
        total_steps: 5,
        succeeded: 5,
        failed: 0,
        exit_reason: "completed",
        failed_ordinal: null,
      },
      recording: { status: "ready_to_finalize", result: null },
    });
    expect(stopRecording).not.toHaveBeenCalled();
    await expect(fs.stat(`${outputPath}.steps.json`)).resolves.toBeDefined();

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
