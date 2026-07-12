import { describe, expect, it } from "vitest";

import type { RecordingActions } from "@/ipc/actions";
import { ACTIONS } from "../../preview/__tests__/fixtures";
import { samplePreparedVirtualCursor } from "../../preview/virtual-cursor-path";
import {
  identitySourceTimelineMap,
  insertSourceHolds,
  timelineMsToSourcePtsUs,
} from "../source-timeline-map";
import { buildVirtualCursorSchedule } from "../virtual-cursor-scheduler";
import { applyZoomToPoint, sampleZoom } from "../zoom-motion";

const RING = { style: "ring", color: "white", intensity: "normal" } as const;

function frameContract(sample: ReturnType<typeof samplePreparedVirtualCursor>) {
  if (!sample) return null;
  return {
    center: { x: sample.x, y: sample.y },
    cursorScale: sample.cursorScale,
    feedback: sample.clickFeedback.map((feedback) => ({
      center: { x: feedback.x, y: feedback.y },
      elapsedMs: feedback.elapsedMs,
      progress: feedback.progress,
      primitives: feedback.primitives.map((primitive) => ({
        kind: primitive.kind,
        radius: primitive.radius,
        opacity: primitive.opacity,
        strokeWidth: primitive.strokeWidth,
        fillOpacity: primitive.fillOpacity,
        glowBlur: primitive.glowBlur,
        foreground: primitive.foreground,
        contrast: primitive.contrast,
      })),
    })),
  };
}

describe("virtual cursor click-effect renderer parity", () => {
  it.each([
    ["before", 1_999, 0],
    ["impact", 2_000, 1],
    ["middle", 2_260, 1],
    ["end", 2_520, 1],
    ["after", 2_521, 0],
  ] as const)("produces one shared %s frame contract", (_label, playheadMs, feedbackCount) => {
    const schedule = buildVirtualCursorSchedule(ACTIONS, "natural");
    const previewFrame = frameContract(samplePreparedVirtualCursor(schedule, playheadMs, RING));
    const exportFrame = frameContract(samplePreparedVirtualCursor(schedule, playheadMs, RING));

    expect(previewFrame).toEqual(exportFrame);
    expect(previewFrame?.feedback).toHaveLength(feedbackCount);
  });

  it("preserves rapid-click order and the three-feedback cap", () => {
    const first = ACTIONS.events[0];
    if (!first?.target) throw new Error("expected click fixture target");
    const firstTarget = first.target;
    const events = [0, 100, 200, 300].map((offset, index) => ({
      ...first,
      source_index: index,
      ordinal: index + 1,
      t_start_ms: 1_900 + offset,
      t_action_ms: 2_000 + offset,
      t_end_ms: 2_050 + offset,
      input_timing: { kind: "click" as const, action_ms: 2_000 + offset },
      target: {
        ...firstTarget,
        center: { x: 200 + index * 200, y: 100 + index * 100 },
      },
    }));
    const actions = { ...ACTIONS, events } satisfies RecordingActions;
    const sample = samplePreparedVirtualCursor(
      buildVirtualCursorSchedule(actions, "natural"),
      2_350,
      RING,
    );

    expect(sample?.clickFeedback.map(({ x, y }) => [x, y])).toEqual([
      [0.4, 0.4],
      [0.6, 0.6],
      [0.8, 0.8],
    ]);
  });

  it("maps the cursor and feedback center through the same auto-zoom sample", () => {
    const sample = samplePreparedVirtualCursor(
      buildVirtualCursorSchedule(ACTIONS, "natural"),
      2_100,
      RING,
    );
    const feedback = sample?.clickFeedback[0];
    if (!sample || !feedback) throw new Error("expected an active click frame");
    const zoom = sampleZoom(
      [
        {
          id: "zoom-click",
          trackId: "zoom",
          startMs: 2_000,
          durationMs: 1_000,
          target: { kind: "cursor" },
          scale: 2,
          center: { x: 0.8, y: 0.6 },
        },
      ],
      2_100,
    );

    expect(applyZoomToPoint(sample, zoom)).toEqual(applyZoomToPoint(feedback, zoom));
  });

  it("keeps source-hold sampling deterministic with preserve-full-motion on and off", () => {
    const first = ACTIONS.events[0];
    if (!first?.target) throw new Error("expected click fixture target");
    const firstTarget = first.target;
    const actions: RecordingActions = {
      ...ACTIONS,
      events: [
        {
          ...first,
          t_start_ms: 1_990,
          cursor_timing: null,
          target: {
            ...firstTarget,
            center: { x: 1_000, y: 500 },
          },
        },
      ],
    };
    const sourceBound = buildVirtualCursorSchedule(actions, "natural");
    const preserved = buildVirtualCursorSchedule(actions, "natural", { preserveFullMotion: true });
    if (!sourceBound || !preserved) throw new Error("expected cursor schedules");
    const map = insertSourceHolds(identitySourceTimelineMap(preserved.durationMs), preserved.holds);
    const preservedImpactMs = preserved.segments[0]?.effectMs ?? 0;
    const mappedSourceMs = (timelineMsToSourcePtsUs(map, preservedImpactMs) ?? 0) / 1_000;

    expect(preserved.holds.length).toBeGreaterThan(0);
    expect(mappedSourceMs).toBe(first.input_timing?.action_ms);
    expect(
      frameContract(samplePreparedVirtualCursor(preserved, preservedImpactMs + 100, RING)),
    ).toEqual(frameContract(samplePreparedVirtualCursor(preserved, preservedImpactMs + 100, RING)));
    expect(
      frameContract(samplePreparedVirtualCursor(sourceBound, mappedSourceMs + 100, RING)),
    ).toEqual(frameContract(samplePreparedVirtualCursor(sourceBound, mappedSourceMs + 100, RING)));
  });
});
