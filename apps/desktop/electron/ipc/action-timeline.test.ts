import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  actionsSidecarPath,
  actionTimelineEventFromStep,
  deriveActionCaptureRect,
  recordingActionsFromSession,
  writeActionsSidecarAtomic,
  type ActionTimelineRecordingSession,
} from "./action-timeline";

const tempDirs: string[] = [];

function recordingSession(
  overrides: Partial<ActionTimelineRecordingSession> = {},
): ActionTimelineRecordingSession {
  return {
    outputPath: "/tmp/demo/recording-1.mp4",
    width: 1280,
    height: 720,
    outputWidth: 1280,
    outputHeight: 720,
    fps: 60,
    frameSeq: 120,
    target: { kind: "author_preview" },
    frameCrop: null,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("action timeline sidecar helpers", () => {
  it("derives the actions sidecar path next to the recording", () => {
    expect(actionsSidecarPath("/tmp/demo/recording.mp4")).toBe("/tmp/demo/recording.actions.json");
    expect(actionsSidecarPath("/tmp/demo/recording")).toBe("/tmp/demo/recording.actions.json");
  });

  it("writes the actions sidecar atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-actions-"));
    tempDirs.push(dir);
    const file = path.join(dir, "recording.actions.json");
    const dto = recordingActionsFromSession(recordingSession({ outputPath: file }), [
      actionTimelineEventFromStep({
        ordinal: 1,
        command: { verb: "click", step_id: "step-1" },
        stepStartedAtMs: 100,
        actionAtMs: 220,
        stepEndedAtMs: 300,
        target: {
          kind: "element",
          label: "Save",
          center: { x: 640, y: 360 },
          bounds: { x: 600, y: 340, w: 80, h: 40 },
        },
      }),
    ]);

    await writeActionsSidecarAtomic(file, dto);

    expect(await fs.readdir(dir)).toEqual(["recording.actions.json"]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      version: 1,
      recording_path: file,
      viewport: { width: 1280, height: 720 },
      capture_rect: { x: 0, y: 0, width: 1280, height: 720 },
      fps: 60,
      frame_count: 120,
      events: [
        {
          step_id: "step-1",
          ordinal: 1,
          verb: "click",
          pointer: { button: "left", effect: "click" },
        },
      ],
    });
  });

  it("uses author-preview viewport coordinates for capture rect", () => {
    expect(
      deriveActionCaptureRect(
        recordingSession({
          width: 1440,
          height: 900,
          outputWidth: 1920,
          outputHeight: 1080,
        }),
      ),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it("constructs a clamped timeline event from step timing", () => {
    expect(
      actionTimelineEventFromStep({
        ordinal: 2,
        command: { verb: "type", step_id: "" },
        stepStartedAtMs: 500.4,
        actionAtMs: 900.6,
        stepEndedAtMs: 700.2,
        target: {
          kind: "element",
          label: "Email",
          center: { x: 320, y: 240 },
          bounds: { x: 300, y: 220, w: 40, h: 40 },
        },
      }),
    ).toEqual({
      step_id: null,
      ordinal: 2,
      verb: "type",
      t_start_ms: 500,
      t_action_ms: 700,
      t_end_ms: 700,
      target: {
        kind: "element",
        label: "Email",
        center: { x: 320, y: 240 },
        bounds: { x: 300, y: 220, w: 40, h: 40 },
      },
      secondary_target: null,
      pointer: null,
    });
  });

  it("writes explicit cursor timing fields for v2 action sidecars", () => {
    const event = actionTimelineEventFromStep({
      ordinal: 1,
      command: { verb: "click", step_id: "step-click" },
      stepStartedAtMs: 100,
      actionAtMs: 500,
      stepEndedAtMs: 620,
      target: {
        kind: "element",
        label: "Submit",
        center: { x: 640, y: 360 },
        bounds: { x: 600, y: 340, w: 80, h: 40 },
      },
      cursorTiming: {
        motion_preset: "natural",
        start_ms: 100,
        arrival_ms: 420,
        travel_ms: 320,
        dwell_ms: 80,
      },
      inputTiming: {
        kind: "click",
        down_ms: 500,
        up_ms: 500,
        action_ms: 500,
      },
    });
    const dto = recordingActionsFromSession(recordingSession(), [event], {
      cursorMotionPreset: "natural",
    });

    expect(dto.version).toBe(2);
    expect(dto.cursor_motion_preset).toBe("natural");
    expect(dto.events[0]).toMatchObject({
      t_start_ms: 100,
      t_action_ms: 500,
      cursor_timing: {
        motion_preset: "natural",
        start_ms: 100,
        arrival_ms: 420,
        travel_ms: 320,
        dwell_ms: 80,
      },
      input_timing: {
        kind: "click",
        down_ms: 500,
        up_ms: 500,
        action_ms: 500,
      },
    });
  });
});
