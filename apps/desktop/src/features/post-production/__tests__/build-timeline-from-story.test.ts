/**
 * Phase 19-03 — unit tests for the post-production timeline producer.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_POLISH_DOC } from "@/features/editor/polish-sidecar";
import { actionSidecarFps, type RecordingActions } from "@/ipc/actions";
import type { ParseResult } from "@/ipc/parse";
import type { RecordingInfo } from "@/ipc/projects";
import type { RecordingStepTimingSidecar, RecordingTrajectory } from "@/ipc/trajectory";
import {
  buildTimelineFromStory,
  mergeIndependentAnnotations,
  mergeReRecordedAnnotations,
} from "../state/build-timeline-from-story";
import type { AnnotationClip } from "../state/timeline-slice";

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
  source_version: 1,
  confidence: "legacy-approximate",
  recording_path: RECORDING.path,
  cursor_motion_preset: "natural",
  viewport: { width: 1920, height: 1080 },
  capture_rect: { x: 0, y: 0, width: 1920, height: 1080 },
  fps_num: 60,
  fps_den: 1,
  frame_count: 600,
  events: [
    {
      source_index: 0,
      confidence: "legacy-approximate",
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
      cursor_timing: null,
      input_timing: { kind: "click", action_ms: 1_000 },
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
const STORY_AST = STORY.ast!;

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
    frame_count: Math.ceil((tEndMs / 1000) * actionSidecarFps(ACTIONS)),
    events: ACTIONS.events.map((event) => ({
      ...event,
      t_action_ms: Math.min(event.t_action_ms, tEndMs),
      t_end_ms: tEndMs,
    })),
  };
}

function textOverlayStory(
  commands: Array<{ text: string; durationMs: number; stepId?: string | null }>,
): ParseResult {
  const scene = STORY_AST.scenes[0];
  if (!scene) throw new Error("expected story scene fixture");
  return {
    ...STORY,
    ast: {
      ...STORY_AST,
      scenes: [
        {
          ...scene,
          commands: commands.map((command, index) => ({
            verb: "text-overlay" as const,
            text: command.text,
            duration_ms: command.durationMs,
            span: { start: index, end: index + 1, line: index + 1, col: 1 },
            step_id: command.stepId,
          })),
        },
      ],
    },
  };
}

function textOverlayTiming(
  steps: Array<{ ordinal: number; stepId?: string | null; startMs: number }>,
): RecordingStepTimingSidecar {
  return {
    ...STEP_TIMING,
    steps: steps.map((step) => ({
      ordinal: step.ordinal,
      stepId: step.stepId,
      sceneName: "Checkout",
      verb: "text-overlay",
      startMs: step.startMs,
      endMs: step.startMs + 2_000,
      durationMs: 2_000,
      status: "succeeded",
      confidence: "high",
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
    expect(v.sourceSize).toEqual({ width: 1920, height: 1080 });
    expect(v.label).toBe("recording-123.mp4");
  });

  it("falls back to capture rect dimensions when recording dimensions are missing", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: { ...RECORDING, width: 0, height: 0 },
      trajectory: {
        ...TRAJECTORY,
        capture_rect: { x: 0, y: 0, width: 1800, height: 1012 },
      },
    });

    expect(out.video[0]).toMatchObject({
      sourceSize: { width: 1800, height: 1012 },
    });
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
    expect(c.clickEffect).toEqual({
      style: "soft-pulse",
      color: "auto",
      intensity: "normal",
    });
    expect(c.skin).toBe("mac-default");
    expect(c.motionPreset).toBe("natural");
    expect(c.sizeScale).toBe(1.0);
  });

  it("falls back to trajectory when actions are explicitly missing", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: null,
      trajectory: TRAJECTORY,
    });

    expect(out.cursor).toHaveLength(1);
    expect(out.cursor[0]?.trajectoryKind).toBe("trajectory");
    expect(out.cursor[0]?.clickEffect).toEqual({
      style: "soft-pulse",
      color: "auto",
      intensity: "normal",
    });
    expect(out.cursor[0]?.trajectoryDir).toBe(
      "/tmp/projects/p1/recordings/recording-123.trajectory.json",
    );
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
    expect(out.cursor[0]?.clickEffect?.style).toBe("soft-pulse");
    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      id: expect.stringMatching(/^zoom-[a-f0-9]{8}-1000$/),
      startMs: 700,
      origin: "auto",
      center: { x: 0.5, y: 0.5 },
    });
    expect(out.annotations).toHaveLength(0);
  });

  it("extends action-based cursor clips for natural visual travel and click feedback", () => {
    const baseEvent = ACTIONS.events[0];
    const baseTarget = baseEvent?.target;
    if (!baseEvent || !baseTarget) throw new Error("expected action fixture");
    const target = (label: string, center: { x: number; y: number }) => ({
      ...baseTarget,
      label,
      center,
      bounds: { x: center.x - 40, y: center.y - 20, w: 80, h: 40 },
    });
    const actions: RecordingActions = {
      ...ACTIONS,
      viewport: { width: 1280, height: 720 },
      capture_rect: { x: 0, y: 0, width: 1280, height: 720 },
      frame_count: 22,
      events: [
        {
          ...baseEvent,
          step_id: "start",
          ordinal: 2,
          verb: "click",
          t_start_ms: 289,
          t_action_ms: 290,
          t_end_ms: 416,
          input_timing: null,
          target: target("Start", { x: 293.1875, y: 376.59375 }),
          pointer: { button: "left", effect: "click" },
        },
        {
          ...baseEvent,
          step_id: "email",
          ordinal: 3,
          verb: "type",
          t_start_ms: 416,
          t_action_ms: 927,
          t_end_ms: 1108,
          input_timing: null,
          target: target("Email", { x: 491.375, y: 376.59375 }),
          pointer: null,
        },
        {
          ...baseEvent,
          step_id: "submit",
          ordinal: 4,
          verb: "click",
          t_start_ms: 1108,
          t_action_ms: 1108,
          t_end_ms: 1233,
          input_timing: null,
          target: target("Submit", { x: 696.9609375, y: 376.59375 }),
          pointer: { button: "left", effect: "click" },
        },
      ],
    };

    const out = buildTimelineFromStory({
      story: null,
      recording: { ...RECORDING, duration_ms: 0, width: 1280, height: 720 },
      actions,
      trajectory: null,
    });
    const cursor = out.cursor[0];
    expect(cursor).toBeDefined();
    if (!cursor) return;
    expect(cursor.durationMs).toBeGreaterThan(1233);
    expect(cursor.durationMs).toBeGreaterThan(1600);
    expect(out.video[0]?.durationMs).toBe(cursor.durationMs);
    expect(cursor.trajectoryFrameCount).toBe(Math.ceil((cursor.durationMs / 1000) * 60));
  });

  it("uses the recorded motion preset from action sidecars", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: { ...ACTIONS, cursor_motion_preset: "cinematic" },
      trajectory: null,
    });

    expect(out.cursor[0]?.motionPreset).toBe("cinematic");
  });

  it("extends action cursor media coverage for explicit input timing and click feedback", () => {
    const baseEvent = ACTIONS.events[0];
    if (!baseEvent) throw new Error("expected action fixture");
    const actions: RecordingActions = {
      ...ACTIONS,
      frame_count: 1,
      events: [
        {
          ...baseEvent,
          t_start_ms: 0,
          t_action_ms: 2_000,
          t_end_ms: 2_100,
          cursor_timing: {
            motion_preset: "natural",
            start_ms: 1_000,
            arrival_ms: 1_320,
            travel_ms: 320,
            dwell_ms: 680,
          },
          input_timing: {
            kind: "click",
            down_ms: 2_000,
            up_ms: 2_000,
            action_ms: 2_000,
          },
        },
      ],
    };

    const out = buildTimelineFromStory({
      story: null,
      recording: { ...RECORDING, duration_ms: 0 },
      actions,
      trajectory: null,
    });

    const cursor = out.cursor[0];
    expect(cursor?.durationMs).toBeGreaterThanOrEqual(2_520);
    expect(cursor?.trajectoryFrameCount).toBe(
      Math.ceil(((cursor?.durationMs ?? 0) / 1000) * actionSidecarFps(ACTIONS)),
    );
    expect(out.video[0]?.durationMs).toBe(cursor?.durationMs);
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

  it("maps strong action focus to spotlight highlight shape", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: ACTIONS,
      trajectory: null,
      polish: {
        version: 2,
        global: {
          recipe: "dynamic",
          autoZoom: "off",
          actionFocus: "strong",
          autoZoomDurationMs: 800,
          cursor: "smooth",
          cursorSkin: "mac-default",
          cursorSizeScale: 1,
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {},
      },
    });

    expect(out.annotations[0]?.highlight).toMatchObject({
      shape: "spotlight",
      strokePx: 3,
      glowPx: 22,
    });
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
    expect(out.zoom.map((clip) => clip.startMs)).toEqual([700, 4_700, 9_700]);
    expect(out.zoom.map((clip) => clip.durationMs)).toEqual([1_600, 1_600, 1_600]);
    expect(out.zoom.map((clip) => clip.scale)).toEqual([1.28, 1.28, 1.28]);
    expect(out.zoom.map((clip) => clip.origin)).toEqual(["auto", "auto", "auto"]);
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
    expect(out.zoom[0]?.durationMs).toBe(1_600);
  });

  it("preserves dense trajectory clicks for cinematic handoff", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([
        { t_ms: 1_000, x: 960, y: 540, click: true },
        { t_ms: 1_500, x: 1_200, y: 700, click: true },
      ]),
    });

    expect(out.zoom).toHaveLength(2);
    expect(out.zoom[0]).toMatchObject({
      startMs: 700,
      center: { x: 0.5, y: 0.5 },
    });
    expect(out.zoom[1]).toMatchObject({ startMs: 1_200, origin: "auto" });
  });

  it("replaces automatic camera motion with a non-duplicated focus highlight in Reduced Motion", () => {
    const out = buildTimelineFromStory({
      story: null,
      recording: RECORDING,
      actions: ACTIONS,
      trajectory: TRAJECTORY,
      polish: {
        version: 2,
        global: { ...DEFAULT_POLISH_DOC.global, motionMode: "reduced", actionFocus: "off" },
        scenes: {},
        steps: {},
      },
    });

    expect(out.zoom).toHaveLength(0);
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({ label: "Action focus", trackId: "annotations" });
  });

  it("keeps a Reduced Motion focus highlight when the authored annotation is callout-only", () => {
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      actions: ACTIONS,
      trajectory: TRAJECTORY,
      stepTiming: STEP_TIMING,
      polish: {
        version: 2,
        global: { ...DEFAULT_POLISH_DOC.global, motionMode: "reduced", actionFocus: "off" },
        scenes: {},
        steps: { "step-buy": { callout: "Buy now" } },
      },
    });

    expect(out.annotations.some((clip) => clip.text === "Buy now")).toBe(true);
    expect(out.annotations.some((clip) => clip.label === "Action focus")).toBe(true);
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

  it("adds polish-authored zooms and callouts keyed by step_id when step timing is present", () => {
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
          "step-buy": {
            zoom: "strong",
            callout: "Start checkout",
            highlight: true,
          },
        },
      },
    });

    expect(out.zoom).toHaveLength(1);
    expect(out.zoom[0]).toMatchObject({
      id: expect.stringContaining("step-buy"),
      label: "Script zoom",
      scale: 1.5,
      origin: "authored",
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

  it("uses fallback timing for callouts but not target FX when step timing is missing", () => {
    const story: ParseResult = {
      ...STORY,
      ast: {
        ...STORY_AST,
        scenes: [
          {
            ...STORY_AST.scenes[0]!,
            commands: [
              {
                verb: "wait-for",
                target: { kind: "text", value: "Ready" },
                timeout_ms: null,
                span: { start: 0, end: 0, line: 3, col: 5 },
                step_id: "step-wait",
              },
            ],
          },
        ],
      },
    };
    const out = buildTimelineFromStory({
      story,
      recording: RECORDING,
      trajectory: trajectoryWithFrames([{ t_ms: 3_000, x: 400, y: 400, click: false }]),
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-wait": {
            zoom: "strong",
            callout: "Wait for state",
            highlight: true,
          },
        },
      },
    });

    expect(out.zoom).toHaveLength(0);
    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({
      text: "Wait for state",
      startMs: 5_973,
      highlight: undefined,
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.16 } },
    });
  });

  it("uses action timing for polish callouts when step timing sidecar is missing", () => {
    const action = ACTIONS.events[0];
    if (!action) throw new Error("expected action fixture");
    const actions: RecordingActions = {
      ...ACTIONS,
      events: [
        {
          ...action,
          step_id: "step-pay",
          ordinal: 2,
          target: null,
          t_action_ms: 4_000,
          t_end_ms: 4_200,
        },
      ],
    };
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: TRAJECTORY,
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-pay": { callout: "Submit payment", highlight: true },
        },
      },
    });

    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({
      text: "Submit payment",
      startMs: 3_900,
      highlight: undefined,
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.16 } },
    });
  });

  it("allows wait/assert callouts from step timing but disables highlight without bbox", () => {
    const story: ParseResult = {
      ...STORY,
      ast: {
        ...STORY_AST,
        scenes: [
          {
            ...STORY_AST.scenes[0]!,
            commands: [
              {
                verb: "assert",
                target: { kind: "text", value: "Ready" },
                span: { start: 0, end: 0, line: 3, col: 5 },
                step_id: "step-assert",
              },
            ],
          },
        ],
      },
    };
    const stepTiming: RecordingStepTimingSidecar = {
      ...STEP_TIMING,
      steps: [
        {
          ordinal: 1,
          stepId: "step-assert",
          sceneName: "Checkout",
          verb: "assert",
          startMs: 2_000,
          endMs: 2_300,
          durationMs: 300,
          status: "succeeded",
          cursor: null,
          target: null,
          confidence: "medium",
        },
      ],
    };
    const out = buildTimelineFromStory({
      story,
      recording: RECORDING,
      trajectory: TRAJECTORY,
      stepTiming,
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-assert": { callout: "Ready state", highlight: true },
        },
      },
    });

    expect(out.annotations).toHaveLength(1);
    expect(out.annotations[0]).toMatchObject({
      text: "Ready state",
      highlight: undefined,
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.16 } },
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
            highlight: {
              enabled: true,
              radiusPx: 72,
              color: "#00ffaa",
              durationMs: 900,
            },
            sfx: { path: "/sounds/click.wav", gain: 0.8, durationMs: 600 },
          },
        },
      },
    });

    expect(out.cursor).toHaveLength(0);
    expect(out.background).toEqual({
      kind: "solid",
      color: { r: 17, g: 34, b: 51, a: 255 },
      foregroundScale: 0.85,
    });
    expect(out.video[0]?.outgoingTransition).toEqual({
      kind: "dissolve",
      durationMs: 700,
    });
    expect(out.zoom).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("step-buy"),
          durationMs: 1_100,
          target: {
            kind: "fixed-region",
            top_left: { x: 0.2, y: 0.3 },
            size: { x: 0.4, y: 0.5 },
          },
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

  it("clamps polish annotations to the next scene boundary", () => {
    const story: ParseResult = {
      ...STORY,
      ast: {
        ...STORY_AST,
        scenes: [
          STORY_AST.scenes[0]!,
          {
            name: "Summary",
            span: { start: 0, end: 0, line: 6, col: 1 },
            commands: [
              {
                verb: "wait-for",
                target: { kind: "text", value: "Done" },
                timeout_ms: null,
                span: { start: 0, end: 0, line: 7, col: 5 },
                step_id: "step-summary",
              },
            ],
          },
        ],
      },
    };
    const stepTiming: RecordingStepTimingSidecar = {
      ...STEP_TIMING,
      steps: [
        {
          ...STEP_TIMING.steps[0]!,
          stepId: "step-buy",
          sceneName: "Checkout",
          startMs: 2_000,
          endMs: 2_500,
          durationMs: 500,
        },
        {
          ordinal: 3,
          stepId: "step-summary",
          sceneName: "Summary",
          verb: "wait-for",
          startMs: 2_700,
          endMs: 3_100,
          durationMs: 400,
          status: "succeeded",
          cursor: null,
          target: null,
          confidence: "medium",
        },
      ],
    };
    const out = buildTimelineFromStory({
      story,
      recording: RECORDING,
      trajectory: TRAJECTORY,
      stepTiming,
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-buy": {
            callout: {
              text: "Buy now",
              pos: { x: 0.5, y: 0.16 },
              sizePt: 14,
              color: "#f8fafc",
              durationMs: 5_000,
            },
            highlight: {
              enabled: true,
              radiusPx: 56,
              color: "#ffffff",
              durationMs: 5_000,
            },
          },
        },
      },
    });

    const annotation = out.annotations[0];
    expect(annotation?.startMs).toBe(2_125);
    expect(annotation ? annotation.startMs + annotation.durationMs : 0).toBeLessThanOrEqual(2_700);
  });

  it("normalizes action targets from the actions capture rect when trajectory is physical scale", () => {
    const action = ACTIONS.events[0];
    if (!action) throw new Error("expected action fixture");
    const actions: RecordingActions = {
      ...ACTIONS,
      capture_rect: { x: 0, y: 0, width: 1800, height: 1012 },
      events: [
        {
          ...action,
          step_id: "step-buy",
          ordinal: 1,
          target: {
            kind: "element",
            label: "Buy",
            center: { x: 900, y: 506 },
            bounds: { x: 810, y: 456, w: 180, h: 100 },
          },
        },
      ],
    };
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: {
        ...TRAJECTORY,
        capture_rect: { x: 0, y: 0, width: 3600, height: 2024 },
      },
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-buy": { highlight: true },
        },
      },
    });

    expect(out.annotations[0]?.highlight?.center).toEqual({ x: 0.5, y: 0.5 });
    const bounds = out.annotations[0]?.highlight?.bounds;
    expect(bounds?.x).toBeCloseTo(0.45);
    expect(bounds?.y).toBeCloseTo(456 / 1012);
    expect(bounds?.w).toBeCloseTo(0.1);
    expect(bounds?.h).toBeCloseTo(100 / 1012);
  });

  it("normalizes step timing bbox from the step capture rect when trajectory is physical scale", () => {
    const stepTiming: RecordingStepTimingSidecar = {
      ...STEP_TIMING,
      captureRect: { x: 0, y: 0, width: 1800, height: 1012 },
      steps: [
        {
          ...STEP_TIMING.steps[0]!,
          target: {
            selector: "button[name='Buy']",
            bbox: { x: 810, y: 456, w: 180, h: 100 },
            matchKind: "primary",
          },
        },
      ],
    };
    const out = buildTimelineFromStory({
      story: STORY,
      recording: RECORDING,
      trajectory: {
        ...TRAJECTORY,
        capture_rect: { x: 0, y: 0, width: 3600, height: 2024 },
      },
      stepTiming,
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
          background: { kind: "transparent" },
        },
        scenes: {},
        steps: {
          "step-buy": { highlight: true },
        },
      },
    });

    expect(out.annotations[0]?.highlight?.center).toEqual({ x: 0.5, y: 0.5 });
    const bounds = out.annotations[0]?.highlight?.bounds;
    expect(bounds?.x).toBeCloseTo(0.45);
    expect(bounds?.y).toBeCloseTo(456 / 1012);
    expect(bounds?.w).toBeCloseTo(0.1);
    expect(bounds?.h).toBeCloseTo(100 / 1012);
  });

  it("uses parser-provided default and explicit text overlay durations", () => {
    const out = buildTimelineFromStory({
      story: textOverlayStory([
        { text: "Default duration", durationMs: 2_000, stepId: "overlay-default" },
        { text: "Explicit duration", durationMs: 5_000, stepId: "overlay-explicit" },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([
        { ordinal: 1, stepId: "overlay-default", startMs: 1_000 },
        { ordinal: 2, stepId: "overlay-explicit", startMs: 5_000 },
      ]),
    });

    expect(out.annotations.map((clip) => [clip.text, clip.startMs, clip.durationMs])).toEqual([
      ["Default duration", 1_000, 2_000],
      ["Explicit duration", 5_000, 5_000],
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("matches text overlay timing by step id before falling back to ordinal", () => {
    const out = buildTimelineFromStory({
      story: textOverlayStory([
        { text: "By ID", durationMs: 2_000, stepId: "overlay-by-id" },
        { text: "By ordinal", durationMs: 2_000 },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([
        { ordinal: 1, stepId: "different-step", startMs: 250 },
        { ordinal: 99, stepId: "overlay-by-id", startMs: 2_500 },
        { ordinal: 2, startMs: 5_500 },
      ]),
    });

    expect(out.annotations.map((clip) => [clip.text, clip.startMs])).toEqual([
      ["By ID", 2_500],
      ["By ordinal", 5_500],
    ]);
    expect(out.annotations[1]?.id).toMatch(/^text-overlay-[a-f0-9]{8}-ordinal-2$/);
  });

  it("assigns provenance ordinals within the text-overlay group", () => {
    const overlays = textOverlayStory([
      { text: "First", durationMs: 2_000 },
      { text: "Second", durationMs: 2_000 },
    ]);
    const overlayAst = overlays.ast;
    const overlayScene = overlayAst?.scenes[0];
    const firstOverlay = overlayScene?.commands[0];
    const secondOverlay = overlayScene?.commands[1];
    const clickCommand = STORY.ast?.scenes[0]?.commands[0];
    if (!overlayAst || !overlayScene || !firstOverlay || !secondOverlay || !clickCommand) {
      throw new Error("expected story fixtures");
    }
    const story: ParseResult = {
      ...overlays,
      ast: {
        ...overlayAst,
        scenes: [
          {
            ...overlayScene,
            commands: [firstOverlay, clickCommand, secondOverlay],
          },
        ],
      },
    };

    const out = buildTimelineFromStory({
      story,
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([
        { ordinal: 1, startMs: 1_000 },
        { ordinal: 3, startMs: 3_000 },
      ]),
    });

    expect(out.annotations.map((clip) => clip.sourceBinding?.ordinal)).toEqual([1, 2]);
    expect(out.annotations.map((clip) => clip.startMs)).toEqual([1_000, 3_000]);
  });

  it("uses caption defaults, stable recording identity, and source sync metadata", () => {
    const input = {
      story: textOverlayStory([
        { text: "Safe-area caption", durationMs: 2_000, stepId: "caption-step" },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, stepId: "caption-step", startMs: 1_500 }]),
    };
    const first = buildTimelineFromStory(input);
    const second = buildTimelineFromStory(input);
    const clip = first.annotations[0];

    expect(clip).toMatchObject({
      id: expect.stringMatching(/^text-overlay-[a-f0-9]{8}-caption-step$/),
      label: "Text overlay",
      text: "Safe-area caption",
      styleId: "caption",
      pos: { x: 0.5, y: 0.9 },
      sizePt: 20,
      color: "#ffffff",
      align: "center",
      boxStyle: {
        paddingPx: 10,
        radiusPx: 10,
        bgColor: "#111317bf",
        borderColor: null,
      },
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.9 } },
    });
    expect(second.annotations[0]?.id).toBe(clip?.id);
    expect(clip?.syncGroupId).toBe(first.video[0]?.syncGroupId);
    expect(clip?.sourceRevision).toBe(first.video[0]?.sourceRevision);
    expect(clip?.sourceTimeMap).toEqual(first.video[0]?.sourceTimeMap);
    expect(clip?.sourceBinding).toEqual({
      kind: "story-text-overlay",
      stepId: "caption-step",
      ordinal: 1,
    });
  });

  it("clamps text overlays at the recorded media end", () => {
    const out = buildTimelineFromStory({
      story: textOverlayStory([
        { text: "Ending caption", durationMs: 2_000, stepId: "ending-caption" },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, stepId: "ending-caption", startMs: 12_000 }]),
    });

    expect(out.annotations[0]).toMatchObject({ startMs: 12_000, durationMs: 345 });
    expect(out.warnings).toEqual([]);
  });

  it("skips text overlays without timing and returns a structured warning", () => {
    const out = buildTimelineFromStory({
      story: textOverlayStory([
        { text: "Needs timing", durationMs: 2_000, stepId: "missing-timing" },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: null,
    });

    expect(out.annotations).toEqual([]);
    expect(out.warnings).toEqual([
      {
        code: "missing-text-overlay-timing",
        stepId: "missing-timing",
        ordinal: 1,
        message: expect.stringContaining("missing-timing"),
      },
    ]);
  });

  it("skips text overlays starting outside media and returns a structured warning", () => {
    const out = buildTimelineFromStory({
      story: textOverlayStory([{ text: "Too late", durationMs: 2_000 }]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, startMs: RECORDING.duration_ms ?? 0 }]),
    });

    expect(out.annotations).toEqual([]);
    expect(out.warnings).toEqual([
      {
        code: "text-overlay-outside-media",
        stepId: null,
        ordinal: 1,
        message: expect.stringContaining("step 1"),
      },
    ]);
  });

  it("preserves every approved customization while keeping fresh recording data", () => {
    const previous = buildTimelineFromStory({
      story: textOverlayStory([{ text: "Old copy", durationMs: 2_000, stepId: "caption" }]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, stepId: "caption", startMs: 1_000 }]),
    }).annotations[0];
    const nextRecording = { ...RECORDING, path: "/tmp/new-recording.mp4", captured_at: 2 };
    const generated = buildTimelineFromStory({
      story: textOverlayStory([{ text: "New copy", durationMs: 3_000, stepId: "caption" }]),
      recording: nextRecording,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, stepId: "caption", startMs: 4_000 }]),
    }).annotations;
    expect(previous).toBeDefined();
    if (!previous) return;
    const saved: AnnotationClip = {
      ...previous,
      styleId: "hotspot",
      font: {
        kind: "system",
        family: "Inter",
        fullName: "Inter Bold Italic",
        postscriptName: "Inter-BoldItalic",
        faceStyle: "Bold Italic",
        weight: 700,
        style: "italic",
      },
      sizePt: 31,
      color: "#123456",
      align: "right",
      maxWidthPct: 63,
      lineHeight: 1.35,
      letterSpacingPx: 2.5,
      textShadow: { color: "#00000080", blurPx: 8, offsetXpx: 1, offsetYpx: 2 },
      boxStyle: {
        paddingPx: 17,
        radiusPx: 23,
        bgColor: "#abcdefaa",
        borderColor: "#fedcba",
        borderWidthPx: 3,
        shadow: { color: "#11223380", blurPx: 12, offsetXpx: 4, offsetYpx: 5 },
      },
      pos: { x: 0.25, y: 0.75 },
      anchor: { kind: "safe-area", placement: "top" },
      animation: { in: "scale-in", out: "none", durationMs: 333 },
    };

    const result = mergeReRecordedAnnotations(generated, [saved]);

    expect(result.legacyGeneratedCount).toBe(0);
    expect(result.annotations[0]).toMatchObject({
      id: generated[0]?.id,
      text: "New copy",
      startMs: 4_000,
      durationMs: 3_000,
      syncGroupId: generated[0]?.syncGroupId,
      sourceRevision: generated[0]?.sourceRevision,
      sourceTimeMap: generated[0]?.sourceTimeMap,
      sourceBinding: generated[0]?.sourceBinding,
      styleId: "hotspot",
      font: saved.font,
      sizePt: 31,
      color: "#123456",
      align: "right",
      maxWidthPct: 63,
      lineHeight: 1.35,
      letterSpacingPx: 2.5,
      textShadow: saved.textShadow,
      boxStyle: saved.boxStyle,
      pos: { x: 0.25, y: 0.75 },
      anchor: { kind: "safe-area", placement: "top" },
      animation: { in: "scale-in", out: "none", durationMs: 333 },
    });
  });

  it("uses step ids across add, remove, and reorder without assigning another step's style", () => {
    const annotation = (
      id: string,
      stepId: string | null,
      ordinal: number,
      color: string,
    ): AnnotationClip => ({
      id,
      trackId: "annotations",
      startMs: ordinal * 1_000,
      durationMs: 500,
      text: id,
      pos: { x: 0.5, y: 0.5 },
      sizePt: 20,
      color,
      syncGroupId: "recording",
      sourceBinding: { kind: "story-text-overlay", stepId, ordinal },
    });
    const saved = [
      annotation("old-a", "a", 1, "#aaaaaa"),
      annotation("old-removed", "removed", 2, "#bbbbbb"),
      annotation("old-no-id", null, 3, "#cccccc"),
      annotation("old-id-at-ordinal-four", "old-four", 4, "#dddddd"),
    ];
    const generated = [
      annotation("new-added", "added", 1, "#010101"),
      annotation("new-a", "a", 2, "#020202"),
      annotation("new-no-id", null, 3, "#030303"),
      annotation("new-no-id-no-fallback", null, 4, "#040404"),
    ];

    const result = mergeReRecordedAnnotations(generated, saved);

    expect(result.annotations.map((clip) => [clip.id, clip.color])).toEqual([
      ["new-added", "#010101"],
      ["new-a", "#aaaaaa"],
      ["new-no-id", "#cccccc"],
      ["new-no-id-no-fallback", "#040404"],
    ]);
  });

  it("preserves independent annotations and reports legacy generated clips without parsing ids", () => {
    const generated = buildTimelineFromStory({
      story: textOverlayStory([
        { text: "Generated", durationMs: 2_000, stepId: "generated-caption" },
      ]),
      recording: RECORDING,
      trajectory: null,
      stepTiming: textOverlayTiming([{ ordinal: 1, stepId: "generated-caption", startMs: 1_000 }]),
    }).annotations;
    const manual: AnnotationClip = {
      id: "manual-caption",
      trackId: "annotations",
      startMs: 3_000,
      durationMs: 1_000,
      text: "Manual",
      pos: { x: 0.5, y: 0.5 },
      sizePt: 20,
    };
    const staleGenerated: AnnotationClip = {
      ...manual,
      id: generated[0]?.id ?? "text-overlay-looks-parseable",
      syncGroupId: "old-recording",
    };

    const result = mergeReRecordedAnnotations(generated, [manual, staleGenerated]);
    expect(result.annotations.map((clip) => clip.id)).toEqual([generated[0]?.id, manual.id]);
    expect(result.legacyGeneratedCount).toBe(1);
    expect(
      mergeIndependentAnnotations(generated, [manual, staleGenerated]).map((clip) => clip.id),
    ).toEqual([generated[0]?.id, manual.id]);
  });
});
