import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionTarget } from "../action-timeline";
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

import { runStoryCommandsInBrowser } from "./story-runner";

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

describe("story browser cursor pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const successes: Array<{ actionDurationMs: number }> = [];

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
      hooks: {
        onStepSucceeded: (step) => {
          successes.push({ actionDurationMs: step.actionDurationMs });
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
    expect(successes).toEqual([{ actionDurationMs: expectedDelayMs }]);
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
});
