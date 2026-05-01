/**
 * Phase 19-03 — unit tests for the post-production timeline producer.
 */
import { describe, expect, it } from "vitest";

import type { RecordingInfo } from "@/ipc/projects";
import type { RecordingTrajectory } from "@/ipc/trajectory";
import type { RecordingActions } from "@/ipc/actions";

import { buildTimelineFromStory } from "../state/build-timeline-from-story";

const RECORDING: RecordingInfo = {
  path: "/tmp/projects/p1/recordings/recording-123.mp4",
  captured_at: 1_700_000_000,
  duration_ms: 12_345,
  width: 1920,
  height: 1080,
};

const TRAJECTORY: RecordingTrajectory = {
  recording_path: RECORDING.path,
  capture_rect: { x: 0, y: 0, width: 1920, height: 1080 },
  fps: 60,
  frame_count: 720,
  frames: [],
};

const ACTIONS: RecordingActions = {
  version: 1,
  recording_path: RECORDING.path,
  viewport: { width: 1920, height: 1080 },
  capture_rect: { x: 0, y: 0, width: 1920, height: 1080 },
  fps: 60,
  frame_count: 600,
  events: [
    {
      step_id: "step-1",
      ordinal: 1,
      verb: "click",
      t_start_ms: 900,
      t_action_ms: 1_000,
      t_end_ms: 1_200,
      target: {
        kind: "element",
        label: "Save",
        center: { x: 960, y: 540 },
        bounds: { x: 900, y: 500, w: 120, h: 80 },
      },
      secondary_target: null,
      pointer: { button: "left", effect: "click" },
    },
  ],
};

function trajectoryWithFrames(frames: RecordingTrajectory["frames"]): RecordingTrajectory {
  return {
    ...TRAJECTORY,
    frame_count: frames.length,
    frames,
  };
}

describe("buildTimelineFromStory", () => {
  it("builds 1 video clip and 0 cursor clips when trajectory is missing", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: null,
    });
    expect(out.video).toHaveLength(1);
    expect(out.cursor).toHaveLength(0);
    expect(out.zoom).toHaveLength(0);
    const v = out.video[0]!;
    expect(v.trackId).toBe("video");
    expect(v.startMs).toBe(0);
    expect(v.durationMs).toBe(12_345);
    expect(v.sourcePath).toBe(RECORDING.path);
    expect(v.label).toBe("recording-123.mp4");
  });

  it("emits a cursor clip with derived trajectory path when sidecar present", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: TRAJECTORY,
    });
    expect(out.cursor).toHaveLength(1);
    const c = out.cursor[0]!;
    expect(c.trackId).toBe("cursor");
    expect(c.startMs).toBe(0);
    expect(c.durationMs).toBe(12_345);
    expect(c.trajectoryDir).toBe("/tmp/projects/p1/recordings/recording-123.trajectory.json");
    expect(c.trajectoryFps).toBe(60);
    expect(c.trajectoryFrameCount).toBe(720);
    expect(c.skin).toBe("mac-default");
    expect(c.sizeScale).toBe(1.0);
  });

  it("prefers actions sidecar over trajectory for cursor and zoom clips", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: ACTIONS,
      trajectory: trajectoryWithFrames([{ t_ms: 5_000, x: 1_920, y: 1_080, click: true }]),
    });

    expect(out.cursor).toHaveLength(1);
    expect(out.cursor[0]!.trajectoryDir).toBe(
      "/tmp/projects/p1/recordings/recording-123.actions.json",
    );
    expect(out.cursor[0]!.trajectoryFps).toBe(60);
    expect(out.cursor[0]!.trajectoryFrameCount).toBe(741);
    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      id: expect.stringMatching(/^zoom-[a-f0-9]{8}-1000$/),
      startMs: 800,
      center: { x: 0.5, y: 0.5 },
    });
  });

  it("derives durationMs from trajectory when recording.duration_ms is missing", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      trajectory: TRAJECTORY, // 720 / 60 fps = 12_000 ms
    });
    expect(out.video[0]!.durationMs).toBe(12_000);
    expect(out.cursor[0]!.durationMs).toBe(12_000);
  });

  it("falls back to 60_000 ms when both recording duration and trajectory are missing", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      trajectory: null,
    });
    expect(out.video[0]!.durationMs).toBe(60_000);
  });

  it("is idempotent on identical input", () => {
    const a = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: TRAJECTORY,
    });
    const b = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: TRAJECTORY,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("emits 0 zoom clips when trajectory has no clicked frames", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([
        { t_ms: 1_000, x: 960, y: 540, click: false },
        { t_ms: 5_000, x: 1200, y: 700, click: false },
      ]),
    });

    expect(out.zoom).toHaveLength(0);
  });

  it("emits auto-zoom clips for clicked frames with expected timing and center", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([
        { t_ms: 1_000, x: 960, y: 540, click: true },
        { t_ms: 5_000, x: 1_920, y: 1_080, click: true },
        { t_ms: 10_000, x: 0, y: 0, click: true },
      ]),
    });

    expect(out.zoom).toHaveLength(3);
    expect(out.zoom.map((clip) => clip.startMs)).toEqual([800, 4_800, 9_800]);
    expect(out.zoom.map((clip) => clip.durationMs)).toEqual([800, 800, 800]);
    expect(out.zoom.map((clip) => clip.scale)).toEqual([1.3, 1.3, 1.3]);
    expect(out.zoom.map((clip) => clip.preset)).toEqual(["CALM", "CALM", "CALM"]);
    expect(out.zoom.map((clip) => clip.target)).toEqual([
      { kind: "cursor" },
      { kind: "cursor" },
      { kind: "cursor" },
    ]);
    expect(out.zoom.map((clip) => clip.center)).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
    ]);
  });

  it("clamps auto-zoom start to 0ms", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([{ t_ms: 100, x: 960, y: 540, click: true }]),
    });

    expect(out.zoom[0]!.startMs).toBe(0);
    expect(out.zoom[0]!.durationMs).toBe(800);
  });

  it("debounces clicked frames within 800ms of a prior emitted click", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([
        { t_ms: 1_000, x: 960, y: 540, click: true },
        { t_ms: 1_500, x: 1_200, y: 700, click: true },
      ]),
    });

    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      startMs: 800,
      center: { x: 0.5, y: 0.5 },
    });
  });

  it("generates deterministic auto-zoom ids from stable input", () => {
    const trajectory = trajectoryWithFrames([
      { t_ms: 1_000, x: 960, y: 540, click: true },
      { t_ms: 5_000, x: 1_200, y: 700, click: true },
    ]);
    const a = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory,
    });
    const b = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory,
    });

    expect(a.zoom.map((clip) => clip.id)).toEqual(b.zoom.map((clip) => clip.id));
    expect(a.zoom.map((clip) => clip.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^zoom-[a-f0-9]{8}-1000$/),
        expect.stringMatching(/^zoom-[a-f0-9]{8}-5000$/),
      ]),
    );
  });
});
