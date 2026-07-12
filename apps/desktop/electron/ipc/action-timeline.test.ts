import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseActionSidecar } from "../../src/ipc/action-sidecar";
import {
  type ActionTimelineRecordingSession,
  actionsSidecarPath,
  actionTimelineEventFromStep,
  deriveActionCaptureRect,
  recordingActionsFromSession,
  writeActionsSidecarAtomic,
} from "./action-timeline";
import { RecordingMediaClock } from "./recording-media-clock";

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
      scrollTiming: {
        start_ms: 100,
        end_ms: 300,
        duration_ms: 200,
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
      scroll_timing: {
        start_ms: 100,
        end_ms: 300,
        duration_ms: 200,
      },
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

  it("serializes authoritative landmarks as a v3 sidecar that round-trips", () => {
    const mediaClock = new RecordingMediaClock({ fpsNum: 60, fpsDen: 1 });
    for (let frame = 0; frame < 3; frame += 1) mediaClock.commitFrame(true);
    const event = actionTimelineEventFromStep({
      ordinal: 1,
      command: { verb: "click", step_id: "step-click" },
      stepStartedAtMs: 0,
      actionAtMs: 17,
      stepEndedAtMs: 34,
      target: {
        kind: "element",
        label: "Submit",
        center: { x: 40, y: 50 },
        bounds: { x: 20, y: 30, w: 40, h: 40 },
      },
      cursorTiming: {
        motion_preset: "natural",
        start_ms: 0,
        arrival_ms: 17,
        travel_ms: 17,
        dwell_ms: 0,
      },
      inputTiming: { kind: "click", down_ms: 17, up_ms: 17, action_ms: 17 },
      landmarks: {
        delivery: "browser_injected",
        cursorPath: {
          interpolation: "media-frame-linear-v1",
          samples: [
            { frameIndex: 0, ptsUs: 0, x: 10, y: 20 },
            { frameIndex: 1, ptsUs: 16_667, x: 40, y: 50 },
          ],
          arrival: { frameIndex: 1, ptsUs: 16_667 },
        },
        input: {
          down: { frameIndex: 1, ptsUs: 16_667 },
          up: { frameIndex: 1, ptsUs: 16_667 },
          action: { frameIndex: 1, ptsUs: 16_667 },
        },
        presentation: {
          status: "presented",
          firstPostInputFrame: { frameIndex: 2, ptsUs: 33_333 },
          firstPostInputPaint: { frameIndex: 2, ptsUs: 33_333 },
        },
      },
    });
    const dto = recordingActionsFromSession(
      recordingSession({ frameSeq: 3, mediaClock }),
      [event],
      { cursorMotionPreset: "natural", version: 3 },
    );

    expect(dto.version).toBe(3);
    expect(dto.media_clock).toMatchObject({ fps_num: 60, fps_den: 1, frame_count: 3 });
    expect(parseActionSidecar(dto)?.events[0]).toMatchObject({
      confidence: "authoritative",
      cursor_path: { arrival: { frame_index: 1, pts_us: 16_667 } },
      input_landmarks: { action: { frame_index: 1, pts_us: 16_667 } },
      presentation: { status: "presented" },
    });

    const compatible = recordingActionsFromSession(
      recordingSession({ frameSeq: 3, mediaClock }),
      [event],
      { cursorMotionPreset: "natural", version: 2 },
    );
    expect(compatible.events[0]).toMatchObject({
      t_start_ms: 0,
      t_action_ms: 17,
      t_end_ms: 33,
      cursor_timing: { arrival_ms: 17 },
      input_timing: { action_ms: 17, down_ms: 17, up_ms: 17 },
    });
    expect(compatible.events[0]).not.toHaveProperty("cursor_path");
  });
});
