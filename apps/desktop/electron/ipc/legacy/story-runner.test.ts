import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingActionLandmarkRecorder } from "../action-landmarks";
import {
  type ActionCursorTiming,
  type ActionInputTiming,
  type ActionTarget,
} from "../automation-action";
import { estimateCursorTravelDelayMs, initialCursorPoint } from "../cursor-timing";
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

vi.mock("../recording-observability", () => ({
  recordEngineLog: vi.fn(async () => null),
}));

import { recordEngineLog } from "../recording-observability";
import { recordingSessions } from "./shared";
import {
  commandContributesCursorEvent,
  commandGetsPreActionPacing,
  executeParsedCommand,
  runStoryCommandsInBrowser,
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

function typeProbe(script: string, value: string, active = true) {
  const saltLiteral = script.match(
    /new TextEncoder\(\)\.encode\(((?:"(?:\\.|[^"])*")) \+ value\)/,
  )?.[1];
  const salt = saltLiteral ? JSON.parse(saltLiteral) : "";
  return {
    found: true,
    connected: true,
    active,
    tag: "input",
    inputType: "text",
    valueLength: Array.from(value).length,
    valueHash: createHash("sha256")
      .update(salt + value)
      .digest("hex"),
    selectionStart: value.length,
    selectionEnd: value.length,
    targetFingerprint: "input:nth-of-type(1)",
    pageOrigin: "http://localhost.test",
  };
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
  let typedValue = "";
  let replaceOnNextInsert = false;
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
    if (script.includes("crypto.subtle.digest")) return typeProbe(script, typedValue);
    if (script.includes("focusTypeTarget(resolved, null)")) replaceOnNextInsert = true;
    return true;
  });
  return {
    getURL: () => "http://localhost.test",
    loadURL: vi.fn(),
    getOwnerBrowserWindow: () => ({
      getContentBounds: () => ({ width: 1280, height: 800 }),
    }),
    sendInputEvent,
    insertText: vi.fn((text: string) => {
      typedValue = replaceOnNextInsert ? text : typedValue + text;
      replaceOnNextInsert = false;
    }),
    executeJavaScript,
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
    })),
    isDestroyed: () => false,
  };
}

function nativeTypeContents(options?: {
  initialValue?: string;
  afterInsert?: (value: string, inserted: string, insertionCount: number) => string;
  detachAfterInsert?: number;
  inactiveAfterInsert?: boolean;
}) {
  const base = fakeContents([]);
  let value = options?.initialValue ?? "";
  let replaceOnNextInsert = false;
  let insertionCount = 0;
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("focusTypeTarget(resolved, null)")) replaceOnNextInsert = true;
    if (script.includes("focusTypeTarget")) return true;
    if (script.includes("crypto.subtle.digest")) {
      if (options?.detachAfterInsert === insertionCount) return { found: false };
      return typeProbe(script, value, !(options?.inactiveAfterInsert && insertionCount > 0));
    }
    return true;
  });
  const insertText = vi.fn((text: string) => {
    insertionCount += 1;
    value = replaceOnNextInsert ? text : value + text;
    replaceOnNextInsert = false;
    value = options?.afterInsert?.(value, text, insertionCount) ?? value;
  });
  const sendInputEvent = vi.fn((event: { type: string; keyCode?: string }) => {
    if (event.type === "keyDown" && event.keyCode === "Backspace") value = "";
  });
  return { ...base, executeJavaScript, insertText, sendInputEvent, value: () => value };
}

describe("story browser cursor pacing", () => {
  it.each([
    ["click", ["down", "up", "action"]],
    ["type", ["down", "up", "text_start", "text_end", "action"]],
    ["fill", ["down", "up", "text_start", "text_end", "action"]],
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

  it("maps CSS target coordinates into a zoomed native surface", async () => {
    const actionTarget = target("Control", { x: 240, y: 180 });
    const contents = fakeContents([actionTarget]);

    await executeParsedCommand(contents as never, command("click", "Control"), "/tmp", {
      resolvedTarget: actionTarget,
      inputCoordinateScale: 0.75,
    });

    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseDown",
      x: 180,
      y: 135,
      button: "left",
      clickCount: 1,
    });
  });

  it("uses browser-native grapheme insertion and re-resolves a reactive target", async () => {
    vi.useRealTimers();
    const contents = nativeTypeContents({ inactiveAfterInsert: true });
    const inputTarget = target("Search Wikipedia", { x: 240, y: 180 });

    await executeParsedCommand(
      contents as never,
      { ...command("type", "Search Wikipedia"), text: "ElectronJS" },
      "/tmp",
      {
        resolvedTarget: inputTarget,
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    expect(contents.value()).toBe("ElectronJS");
    expect(contents.insertText).toHaveBeenCalledTimes(10);
    expect(
      contents.executeJavaScript.mock.calls.filter(([script]) =>
        script.includes("focusTypeTarget"),
      ),
    ).toHaveLength(10);
  });

  it("clears an existing value when browser-native type text is empty", async () => {
    vi.useRealTimers();
    const contents = nativeTypeContents({ initialValue: "existing" });

    await executeParsedCommand(
      contents as never,
      { ...command("type", "Search Wikipedia"), text: "" },
      "/tmp",
      {
        resolvedTarget: target("Search Wikipedia", { x: 240, y: 180 }),
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    expect(contents.value()).toBe("");
    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "Backspace",
    });
  });

  it("inserts Unicode text by grapheme instead of code point", async () => {
    vi.useRealTimers();
    const contents = nativeTypeContents();
    const value = "👨‍👩‍👧‍👦é";

    await executeParsedCommand(
      contents as never,
      { ...command("type", "Unicode"), text: value },
      "/tmp",
      {
        resolvedTarget: target("Unicode", { x: 240, y: 180 }),
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    expect(contents.insertText.mock.calls.map(([text]) => text)).toEqual(["👨‍👩‍👧‍👦", "é"]);
    expect(contents.value()).toBe(value);
  });

  it("fails safely when a typed target detaches", async () => {
    vi.useRealTimers();
    const contents = nativeTypeContents({ detachAfterInsert: 1 });
    const secret = "private-secret";

    const execution = executeParsedCommand(
      contents as never,
      { ...command("type", "Secret"), text: secret },
      "/tmp",
      {
        resolvedTarget: target("Secret", { x: 240, y: 180 }),
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    await expect(execution).rejects.toMatchObject({
      reason: "target_detached",
      diagnostics: { expectedLength: 1, actualLength: null },
    });
    await expect(execution).rejects.not.toThrow(secret);
  });

  it("rejects controlled overwrites with privacy-safe mismatch diagnostics", async () => {
    vi.useRealTimers();
    const secret = "private-secret";
    const contents = nativeTypeContents({ afterInsert: () => "controlled-value" });

    const execution = executeParsedCommand(
      contents as never,
      { ...command("type", "Secret"), text: secret },
      "/tmp",
      {
        resolvedTarget: target("Secret", { x: 240, y: 180 }),
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    await expect(execution).rejects.toMatchObject({
      reason: "value_mismatch",
      diagnostics: {
        expectedLength: 1,
        actualLength: 16,
        expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        actualHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(execution).rejects.not.toThrow(secret);
  });

  it("does not cap long browser-native type input", async () => {
    vi.useRealTimers();
    const contents = nativeTypeContents();
    const value = "x".repeat(201);

    await executeParsedCommand(
      contents as never,
      { ...command("type", "Notes"), text: value },
      "/tmp",
      {
        resolvedTarget: target("Notes", { x: 240, y: 180 }),
        executionProfile: {
          typingMode: "instant",
          captureRecordingFrames: false,
          settleDelayForCommand: () => 0,
        },
      },
    );

    expect(contents.insertText).toHaveBeenCalledTimes(201);
    expect(contents.value()).toBe(value);
  });

  it("keeps fill on the full-value DOM path", async () => {
    const contents = fakeContents([]);
    const value = "filled at once";

    await executeParsedCommand(
      contents as never,
      { ...command("fill", "Email"), text: value },
      "/tmp",
      { resolvedTarget: target("Email", { x: 240, y: 180 }) },
    );

    expect(contents.insertText).not.toHaveBeenCalled();
    expect(contents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining(value));
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
    expect(commandContributesCursorEvent(command("fill", "Email"))).toBe(true);
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

  it("does not fail a completed step when the simulator frame capture is unavailable", async () => {
    const frameDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-frame-failure-"));
    tempDirs.push(frameDir);
    const contents = fakeContents([]);
    contents.capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
    const frames: Array<{ screenshot_path: string | null }> = [];

    const run = runStoryCommandsInBrowser({
      contents: contents as never,
      commands: [textOverlay("Already completed", 100)],
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
    expect(frames).toMatchObject([{ screenshot_path: null }]);
  });

  it("re-resolves a semantic target after the prepared target detaches", async () => {
    const replacement = target("Search Wikipedia", { x: 520, y: 240 });
    let readinessCalls = 0;
    let prepareCalls = 0;
    const baseContents = fakeContents([]);
    const contents = {
      ...baseContents,
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
        return baseContents.executeJavaScript(script);
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
    expect(contents.insertText.mock.calls.map(([text]) => text).join("")).toBe("ElectronJS");
    expect(
      contents.executeJavaScript.mock.calls.some(([script]) => script.includes("ElectronJS")),
    ).toBe(false);
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
      setTimeout(() => actionLandmarks.commitFrame({ frameIndex: 2, ptsUs: 33_333 }), 500);
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
      delivery: "browser_injected",
      cursorPath: { arrival: committed },
      input: {
        action: { frameIndex: 1 },
        text_start: committed,
        text_end: { frameIndex: 1 },
      },
      presentation: { status: "presented", firstPostInputFrame: { frameIndex: 2 } },
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


});
