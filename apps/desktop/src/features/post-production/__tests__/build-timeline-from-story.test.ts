/**
 * Phase 19-03 — unit tests for the post-production timeline producer.
 */
import { describe, expect, it } from "vitest";

import type { RecordingInfo } from "@/ipc/projects";
import type { RecordingTrajectory } from "@/ipc/trajectory";

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

describe("buildTimelineFromStory", () => {
  it("builds 1 video clip and 0 cursor clips when trajectory is missing", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: null,
    });
    expect(out.video).toHaveLength(1);
    expect(out.cursor).toHaveLength(0);
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
    expect(c.trajectoryDir).toBe(
      "/tmp/projects/p1/recordings/recording-123.trajectory.json",
    );
    expect(c.trajectoryFps).toBe(60);
    expect(c.trajectoryFrameCount).toBe(720);
    expect(c.skin).toBe("mac-default");
    expect(c.sizeScale).toBe(1.0);
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
});
