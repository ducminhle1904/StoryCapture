/**
 * Phase 19-03 — unit tests for the post-production timeline producer.
 */
import { describe, expect, it } from "vitest";
import type { RecordingActions } from "@/ipc/actions";
import type { ParseResult } from "@/ipc/parse";
import type { RecordingInfo } from "@/ipc/projects";
import type { RecordingStepTimingSidecar, RecordingTrajectory } from "@/ipc/trajectory";

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

const STEP_TIMING: RecordingStepTimingSidecar = {
  version: 1,
  recordingPath: RECORDING.path,
  storyHash: "hash",
  timebase: "recording-ms",
  status: "completed",
  steps: [
    {
      ordinal: 1,
      stepId: "step-buy",
      sceneName: "Checkout",
      verb: "click",
      startMs: 2_000,
      endMs: 2_500,
      durationMs: 500,
      status: "succeeded",
      cursor: { x: 960, y: 540 },
      target: {
        selector: "button[name='Buy']",
        bbox: { x: 480, y: 240, w: 240, h: 120 },
        matchKind: "primary",
      },
      confidence: "high",
    },
  ],
};

const STORY: ParseResult = {
  diagnostics: [],
  ast: {
    name: "Demo",
    meta: {
      app: null,
      viewport: null,
      theme: null,
      speed: null,
      span: { start: 0, end: 0, line: 1, col: 1 },
    },
    span: { start: 0, end: 0, line: 1, col: 1 },
    scenes: [
      {
        name: "Checkout",
        span: { start: 0, end: 0, line: 1, col: 1 },
        commands: [
          {
            verb: "click",
            target: { kind: "role", value: { role: "button", name: "Buy" } },
            span: { start: 0, end: 0, line: 3, col: 5 },
            step_id: "step-buy",
          },
          {
            verb: "click",
            target: { kind: "role", value: { role: "button", name: "Pay" } },
            span: { start: 0, end: 0, line: 4, col: 5 },
            step_id: "step-pay",
          },
        ],
      },
    ],
  },
};

function trajectoryWithFrames(frames: RecordingTrajectory["frames"]): RecordingTrajectory {
  return {
    ...TRAJECTORY,
    frame_count: frames.length,
    frames,
  };
}

function actionsEndingAt(tEndMs: number): RecordingActions {
  return {
    ...ACTIONS,
    frame_count: Math.ceil((tEndMs / 1000) * ACTIONS.fps),
    events: ACTIONS.events.map((event) => ({
      ...event,
      t_action_ms: Math.min(event.t_action_ms, tEndMs),
      t_end_ms: tEndMs,
    })),
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
    const v = out.video[0];
    expect(v).toBeDefined();
    if (!v) return;
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
    const c = out.cursor[0];
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.trackId).toBe("cursor");
    expect(c.startMs).toBe(0);
    expect(c.durationMs).toBe(12_345);
    expect(c.trajectoryDir).toBe("/tmp/projects/p1/recordings/recording-123.trajectory.json");
    expect(c.trajectoryFps).toBe(60);
    expect(c.trajectoryFrameCount).toBe(720);
    expect(c.skin).toBe("mac-default");
    expect(c.motionPreset).toBe("natural");
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
    expect(out.cursor[0]?.trajectoryDir).toBe(
      "/tmp/projects/p1/recordings/recording-123.actions.json",
    );
    expect(out.cursor[0]?.trajectoryFps).toBe(60);
    expect(out.cursor[0]?.trajectoryFrameCount).toBe(741);
    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      id: expect.stringMatching(/^zoom-[a-f0-9]{8}-1000$/),
      startMs: 800,
      center: { x: 0.5, y: 0.5 },
    });
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({
      id: expect.stringMatching(/^action-focus-[a-f0-9]{8}-step-1-1000$/),
      startMs: 940,
      durationMs: 700,
      text: "",
      anchor: { kind: "target", stepId: "step-1", placement: "top" },
      highlight: {
        center: { x: 0.5, y: 0.5 },
        radiusPx: 56,
        color: "#ffffff",
        durationMs: 700,
      },
    });
  });

  it("lets action focus be disabled independently from auto zoom", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: ACTIONS,
      trajectory: null,
      polish: {
        version: 2,
        global: {
          recipe: "dynamic",
          autoZoom: "standard",
          actionFocus: "off",
          autoZoomDurationMs: 800,
          cursor: "smooth",
          cursorSkin: "mac-default",
          cursorSizeScale: 1,
          background: { kind: "gradient", presetId: "runway-dark" },
        },
        scenes: {},
        steps: {},
      },
    });

    expect(out.zoom).toHaveLength(1);
    expect(out.annotations).toHaveLength(0);
  });

  it("derives durationMs from trajectory when recording.duration_ms is missing", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      trajectory: TRAJECTORY, // 720 / 60 fps = 12_000 ms
    });
    expect(out.video[0]?.durationMs).toBe(12_000);
    expect(out.cursor[0]?.durationMs).toBe(12_000);
  });

  it("uses recording.duration_ms over actions and trajectory", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: { ...RECORDING, duration_ms: 40_064 },
      actions: actionsEndingAt(17_142),
      trajectory: trajectoryWithFrames([{ t_ms: 40_887, x: 960, y: 540, click: false }]),
    });

    expect(out.video[0]?.durationMs).toBe(40_064);
    expect(out.cursor[0]?.durationMs).toBe(40_064);
  });

  it("uses trajectory final timestamp before actions when recording.duration_ms is missing", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      actions: actionsEndingAt(17_142),
      trajectory: trajectoryWithFrames([{ t_ms: 40_887, x: 960, y: 540, click: false }]),
    });

    expect(out.video[0]?.durationMs).toBe(40_887);
    expect(out.cursor[0]?.durationMs).toBe(40_887);
  });

  it("uses action sidecar only as legacy fallback when recording and trajectory durations are unavailable", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      actions: actionsEndingAt(17_142),
      trajectory: null,
    });

    expect(out.video[0]?.durationMs).toBe(17_142);
  });

  it("falls back to 60_000 ms when recording duration, trajectory, and actions are missing", () => {
    const noDuration: RecordingInfo = { ...RECORDING, duration_ms: null };
    const out = buildTimelineFromStory({
      story: null,
      recording: noDuration,
      trajectory: null,
    });
    expect(out.video[0]?.durationMs).toBe(60_000);
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
    expect(out.zoom.map((clip) => clip.scale)).toEqual([1.35, 1.35, 1.35]);
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

    expect(out.zoom[0]?.startMs).toBe(0);
    expect(out.zoom[0]?.durationMs).toBe(800);
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

  it("adds polish-authored zooms and callouts keyed by step_id", () => {
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: TRAJECTORY,
      polish: {
        version: 2,
        global: {
          recipe: "dynamic",
          autoZoom: "off",
          actionFocus: "off",
          autoZoomDurationMs: 800,
          cursor: "smooth",
          cursorSkin: "mac-default",
          cursorSizeScale: 1,
          background: { kind: "gradient", presetId: "runway-dark" },
        },
        scenes: {},
        steps: {
          "step-buy": { zoom: "strong", callout: "Start checkout", highlight: true },
        },
      },
    });

    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      id: expect.stringContaining("step-buy"),
      label: "Script zoom",
      scale: 1.65,
    });
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({
      id: expect.stringContaining("step-buy"),
      text: "Start checkout",
      trackId: "annotations",
      pos: { x: 0.5, y: 0.16 },
      sizePt: 14,
      color: "#f8fafc",
    });
  });

  it("uses recording step timing and target bbox for polish-authored clips", () => {
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: TRAJECTORY,
      stepTiming: STEP_TIMING,
      polish: {
        version: 2,
        global: {
          recipe: "dynamic",
          autoZoom: "off",
          actionFocus: "off",
          autoZoomDurationMs: 800,
          cursor: "smooth",
          cursorSkin: "mac-default",
          cursorSizeScale: 1,
          background: { kind: "gradient", presetId: "runway-dark" },
        },
        scenes: {},
        steps: {
          "step-buy": { zoom: "strong", callout: "Start checkout" },
        },
      },
    });

    expect(out.zoom[0]).toMatchObject({
      startMs: 1_975,
      center: { x: 0.3125, y: 0.2777777777777778 },
    });
    expect(out.annotations[0]?.startMs).toBe(2_125);
  });

  it("maps v2 editor polish into cursor, background, sound, highlight, zoom target, and transition state", () => {
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: TRAJECTORY,
      stepTiming: STEP_TIMING,
      polish: {
        version: 2,
        global: {
          recipe: "calm",
          autoZoom: "subtle",
          actionFocus: "standard",
          autoZoomDurationMs: 1_200,
          cursor: "hidden",
          cursorSkin: "big-arrow",
          cursorSizeScale: 1.4,
          background: { kind: "solid", color: "#112233" },
          bgm: { path: "/sounds/bgm.wav", gain: 0.35 },
        },
        scenes: {
          Checkout: { transitionOut: "dissolve", transitionDurationMs: 700 },
        },
        steps: {
          "step-buy": {
            zoom: "standard",
            zoomTarget: {
              kind: "fixed-region",
              topLeft: { x: 0.2, y: 0.3 },
              size: { x: 0.4, y: 0.5 },
            },
            zoomScale: 1.8,
            zoomDurationMs: 1_100,
            callout: {
              text: "Start checkout",
              pos: { x: 0.25, y: 0.75 },
              sizePt: 30,
              color: "#ffcc00",
              durationMs: 2_000,
            },
            highlight: { enabled: true, radiusPx: 72, color: "#00ffaa", durationMs: 900 },
            sfx: { path: "/sounds/click.wav", gain: 0.8, durationMs: 600 },
          },
        },
      },
    });

    expect(out.cursor).toHaveLength(0);
    expect(out.background).toEqual({ kind: "solid", color: { r: 17, g: 34, b: 51, a: 255 } });
    expect(out.video[0]?.outgoingTransition).toEqual({ kind: "dissolve", durationMs: 700 });
    expect(out.zoom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("step-buy"),
          durationMs: 1_100,
          target: { kind: "fixed-region", top_left: { x: 0.2, y: 0.3 }, size: { x: 0.4, y: 0.5 } },
          scale: 1.8,
          preset: "CALM",
        }),
      ]),
    );
    expect(out.annotations[0]).toMatchObject({
      text: "Start checkout",
      pos: { x: 0.25, y: 0.75 },
      sizePt: 30,
      color: "#ffcc00",
      highlight: {
        center: { x: 0.3125, y: 0.2777777777777778 },
        radiusPx: 72,
        color: "#00ffaa",
        durationMs: 900,
      },
    });
    expect(out.sound).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^bgm-/),
        path: "/sounds/bgm.wav",
        kind: "bgm",
        gain: 0.35,
      }),
      expect.objectContaining({
        id: expect.stringContaining("step-buy"),
        path: "/sounds/click.wav",
        kind: "sfx",
        gain: 0.8,
      }),
    ]);
  });

  it("uses action targets for step-authored highlight centers when step timing is missing", () => {
    const action = ACTIONS.events[0];
    if (!action) throw new Error("expected action fixture");
    const actions: RecordingActions = {
      ...ACTIONS,
      events: [
        {
          ...action,
          step_id: "step-buy",
          ordinal: 1,
          target: {
            kind: "element",
            label: "Buy",
            center: { x: 1536, y: 810 },
            bounds: { x: 1480, y: 780, w: 112, h: 60 },
          },
        },
      ],
    };
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: null,
      actions,
      polish: {
        version: 2,
        global: {
          recipe: "dynamic",
          autoZoom: "off",
          actionFocus: "off",
          autoZoomDurationMs: 800,
          cursor: "smooth",
          cursorSkin: "mac-default",
          cursorSizeScale: 1,
          background: { kind: "gradient", presetId: "runway-dark" },
        },
        scenes: {},
        steps: {
          "step-buy": { highlight: true },
        },
      },
    });

    expect(out.annotations[0]?.highlight?.center).toEqual({ x: 0.8, y: 0.75 });
  });
});
