import type {
  RecordingV4ActionSidecar,
  RecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import { describe, expect, it } from "vitest";
import type { RecordingInfo } from "@/ipc/projects";

import {
  buildTimelineFromStory,
  mergeReRecordedCursorStyle,
} from "../state/build-timeline-from-story";
import type { CursorClip } from "../state/timeline-slice";

const recording: RecordingInfo = {
  path: "/take.sc-recording/master/video.mp4",
  captured_at: 1_700_000_000,
  duration_ms: 2_000,
  width: 1920,
  height: 1080,
  actions_path: "/take.sc-recording/sidecars/actions.json",
  cursor_path: "/take.sc-recording/sidecars/cursor.json",
};

const actions: RecordingV4ActionSidecar = {
  version: 4,
  session_id: "session-v4",
  clock: "active_media_time_us",
  events: [
    {
      step_id: "save",
      ordinal: 1,
      phase: "succeeded",
      verb: "click",
      target: { selector: "#save", bounds: { x: 576, y: 324, width: 128, height: 72 } },
      timing: {
        started_us: 800_000,
        action_us: 1_000_000,
        ended_us: 1_200_000,
        input_us: { action: 1_000_000 },
        presented_us: 1_100_000,
      },
      error_message: null,
      active_media_time_us: 1_200_000,
    },
  ],
};

const cursor: RecordingV4CursorSidecar = {
  version: 4,
  session_id: "session-v4",
  clock: "active_media_time_us",
  geometry: {
    coordinate_width: 1280,
    coordinate_height: 720,
    capture_width: 1920,
    capture_height: 1080,
  },
  samples: [
    { active_media_time_us: 0, x: 0.1, y: 0.1, kind: "default", visible: true, pressed: false },
    {
      active_media_time_us: 1_000_000,
      x: 0.5,
      y: 0.5,
      kind: "pointer",
      visible: true,
      pressed: true,
    },
  ],
};

describe("Recording V4 timeline builder", () => {
  it("builds cursor clips from cursor.json and actions semantics from actions.json", () => {
    const result = buildTimelineFromStory({
      story: null,
      recording,
      actions,
      cursor,
    });

    expect(result.cursor).toEqual([
      expect.objectContaining({
        trajectoryKind: "recording-v4",
        trajectoryDir: recording.cursor_path,
        actionsPath: recording.actions_path,
        trajectoryFrameCount: 2,
      }),
    ]);
    expect(result.zoom).toEqual([
      expect.objectContaining({ startMs: 700, center: { x: 0.5, y: 0.5 } }),
    ]);
  });

  it("preserves authored cursor appearance while replacing source-bound V4 data", () => {
    const generated = buildTimelineFromStory({ story: null, recording, actions, cursor }).cursor;
    const generatedClip = generated[0];
    expect(generatedClip).toBeDefined();
    if (!generatedClip) return;
    const saved: CursorClip = {
      ...generatedClip,
      trajectoryDir: "/old/cursor.json",
      actionsPath: "/old/actions.json",
      skin: "big-arrow",
      motionPreset: "cinematic",
      sizeScale: 1.5,
      colorTint: "#ffaa00",
      clickEffect: { style: "echo", color: "brand", intensity: "strong" },
    };

    expect(mergeReRecordedCursorStyle(generated, [saved])[0]).toMatchObject({
      trajectoryDir: recording.cursor_path,
      actionsPath: recording.actions_path,
      skin: "big-arrow",
      motionPreset: "cinematic",
      sizeScale: 1.5,
      colorTint: "#ffaa00",
      clickEffect: { style: "echo", color: "brand", intensity: "strong" },
    });
  });

  it("keeps semantic action coverage when optional cursor samples end early", () => {
    const result = buildTimelineFromStory({
      story: null,
      recording: { ...recording, duration_ms: null },
      actions,
      cursor: { ...cursor, samples: cursor.samples.slice(0, 1) },
    });
    expect(result.video[0]?.durationMs).toBe(1_200);
    expect(result.cursor[0]?.durationMs).toBe(1_200);
  });
});
