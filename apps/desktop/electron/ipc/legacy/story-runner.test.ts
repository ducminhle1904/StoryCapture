import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actionsSidecarPath,
  type ActionTarget,
  type ActionTimelineEvent,
} from "../action-timeline";
import { estimateCursorTravelDelayMs, initialCursorPoint } from "../cursor-timing";
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
  storyBrowserExecutionProfile: (options?: { captureRecordingFrames?: boolean }) => ({
    typingMode: "incremental",
    captureRecordingFrames: options?.captureRecordingFrames ?? false,
    settleDelayForCommand: () => 0,
  }),
  targetsPathFor: (storyPath: string) => `${storyPath}.targets.json`,
}));

vi.mock("./recording", () => ({
  stopRecording: vi.fn(),
}));

import { authorSession } from "./capture-preview";
import { recordingSessions } from "./shared";
import {
  commandContributesCursorEvent,
  commandGetsPreActionPacing,
  launchAutomationCommand,
  rebaseActionEventsToFirstCursorInteraction,
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

function fakeContents(targets: ActionTarget[]) {
  const pendingTargets = [...targets];
  let latestTarget: ActionTarget | null = null;
  const sendInputEvent = vi.fn();
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("resolvedTargetGeometry")) {
      latestTarget = pendingTargets.shift() ?? latestTarget;
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
  };
}

function fakeContentsByLabel(targets: Record<string, ActionTarget>) {
  const sendInputEvent = vi.fn();
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("resolvedTargetGeometry")) {
      for (const [label, actionTarget] of Object.entries(targets)) {
        if (script.includes(label)) return actionTarget;
      }
      return null;
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
  };
}

describe("story browser cursor pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
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
    expect(commandContributesCursorEvent(command("wait-for", "Heading"))).toBe(false);
    expect(commandContributesCursorEvent(command("assert", "Heading"))).toBe(false);
    expect(commandGetsPreActionPacing(command("wait-for", "Heading"))).toBe(false);
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
  });

  it("waits for cursor travel before sending recorded click input", async () => {
    const size = { width: 1280, height: 800 };
    const clickTarget = target("Sign in", { x: 460, y: 320 });
    const contents = fakeContents([clickTarget]);
    const expectedDelayMs = estimateCursorTravelDelayMs({
      from: initialCursorPoint(size),
      target: clickTarget,
      size,
    });
    const successes: Array<{
      actionDurationMs: number;
      timing?: {
        stepStartedAtMs: number;
        actionAtMs: number;
        stepEndedAtMs: number;
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

    await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
    expect(contents.sendInputEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseMove",
      x: clickTarget.center.x,
      y: clickTarget.center.y,
    });
    expect(successes).toHaveLength(1);
    expect(successes[0]?.actionDurationMs).toBe(expectedDelayMs);
    expect(successes[0]?.timing?.stepStartedAtMs).toBe(0);
    expect(successes[0]?.timing?.actionAtMs).toBeCloseTo(expectedDelayMs / 2);
    expect(successes[0]?.timing?.stepEndedAtMs).toBeCloseTo(expectedDelayMs / 2);
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

  it("excludes non-interaction targets from recorded action sidecars", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-actions-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "recording.mp4");
    const contents = fakeContentsByLabel({
      Login: target("Login", { x: 640, y: 170 }),
      "EMAIL ADDRESS": target("EMAIL ADDRESS", { x: 460, y: 320 }),
      PASSWORD: target("PASSWORD", { x: 460, y: 390 }),
      "SIGN IN": target("SIGN IN", { x: 460, y: 470 }),
    });
    vi.mocked(authorSession).mockReturnValue({
      window: { webContents: contents },
    } as never);
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

    const run = launchAutomationCommand(
      {
        streamId: "author-preview",
        recordingSessionId: "recording-1",
        projectFolder: dir,
        storySource: `story "Demo" {
scene "Login" {
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
    expect(sidecar.events.map((event: { verb: string; target: { label: string } | null }) => ({
      verb: event.verb,
      label: event.target?.label,
    }))).toEqual([
      { verb: "type", label: "EMAIL ADDRESS" },
      { verb: "type", label: "PASSWORD" },
      { verb: "click", label: "SIGN IN" },
    ]);
  });
});
