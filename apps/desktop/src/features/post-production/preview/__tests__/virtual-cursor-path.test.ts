import { describe, expect, it } from "vitest";
import type { RecordingActions } from "@/ipc/actions";
import {
  buildVirtualCursorSchedule,
  virtualCursorVisualDurationMs,
} from "../../state/virtual-cursor-scheduler";
import { samplePreparedVirtualCursor, sampleVirtualCursor } from "../virtual-cursor-path";
import { ACTIONS } from "./fixtures";

function actionsWithEvents(
  events: RecordingActions["events"],
  size = { width: 1000, height: 500 },
) {
  return {
    ...ACTIONS,
    viewport: size,
    capture_rect: { x: 0, y: 0, width: size.width, height: size.height },
    events,
  } satisfies RecordingActions;
}

function eventWithTarget(
  center: { x: number; y: number },
  timing: { start: number; action: number; end: number },
): RecordingActions["events"][number] {
  const target = ACTIONS.events[0].target;
  if (!target) throw new Error("ACTIONS fixture must include a target");

  return {
    ...ACTIONS.events[0],
    t_start_ms: timing.start,
    t_action_ms: timing.action,
    t_end_ms: timing.end,
    cursor_timing: null,
    input_timing: null,
    target: {
      ...target,
      center,
    },
  };
}

describe("sampleVirtualCursor", () => {
  it("starts at the center before the first action begins", () => {
    expect(sampleVirtualCursor(ACTIONS, 500)).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("lands on the target at action time", () => {
    expect(sampleVirtualCursor(ACTIONS, 2000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("holds the final target after the action ends", () => {
    expect(sampleVirtualCursor(ACTIONS, 8000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("returns click ripple state during the click feedback window", () => {
    const sample = sampleVirtualCursor(ACTIONS, 2100);

    expect(sample?.ripple).toMatchObject({ x: 0.8, y: 0.6 });
    expect(sample?.ripple?.progress).toBeGreaterThan(0);
    expect(sample?.ripple?.opacity).toBeGreaterThan(0);
  });

  it("returns null when actions are unavailable", () => {
    expect(sampleVirtualCursor(null, 1000)).toBeNull();
  });

  it("samples a prepared schedule with wrapper parity", () => {
    const schedule = buildVirtualCursorSchedule(ACTIONS, "natural");

    for (const timeMs of [999, 1000, 1500, 2000, 2001, 2520]) {
      expect(samplePreparedVirtualCursor(schedule, timeMs)).toEqual(
        sampleVirtualCursor(ACTIONS, timeMs, "natural"),
      );
    }
  });

  it("snaps zero-window actions at the input boundary", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 800, y: 300 }, { start: 2000, action: 2000, end: 2100 }),
    ]);

    expect(sampleVirtualCursor(actions, 1600)).toMatchObject({ x: 0.5, y: 0.5 });
    expect(sampleVirtualCursor(actions, 1999)).toMatchObject({ x: 0.5, y: 0.5 });
    expect(sampleVirtualCursor(actions, 2000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("does not move a long-distance zero-window action before input", () => {
    const actions = actionsWithEvents(
      [eventWithTarget({ x: 3000, y: 2000 }, { start: 2000, action: 2000, end: 2100 })],
      { width: 3000, height: 2000 },
    );

    expect(sampleVirtualCursor(actions, 1999)).toMatchObject({ x: 0.5, y: 0.5 });
    expect(sampleVirtualCursor(actions, 2000)).toMatchObject({ x: 1, y: 1 });
  });

  it("uses the selected motion preset for synthetic travel timing", () => {
    const actions = actionsWithEvents(
      [eventWithTarget({ x: 3000, y: 2000 }, { start: 0, action: 2000, end: 2100 })],
      { width: 3000, height: 2000 },
    );

    const snappy = sampleVirtualCursor(actions, 1000, "snappy");
    const cinematic = sampleVirtualCursor(actions, 1000, "cinematic");

    expect(snappy?.x).toBeCloseTo(0.5);
    expect(cinematic?.x).toBeGreaterThan(0.5);
  });

  it("keeps a minimum requested travel window when the event window allows it", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 510, y: 250 }, { start: 1500, action: 2000, end: 2100 }),
    ]);

    expect(sampleVirtualCursor(actions, 1600)).toMatchObject({ x: 0.5, y: 0.5 });

    const moving = sampleVirtualCursor(actions, 1800);
    expect(moving?.x).toBeGreaterThan(0.5);
    expect(moving?.x).toBeLessThan(0.51);
  });

  it("holds then snaps between tightly spaced zero-window actions", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 800, y: 300 }, { start: 1000, action: 1000, end: 1200 }),
      eventWithTarget({ x: 200, y: 100 }, { start: 1300, action: 1300, end: 1400 }),
    ]);

    expect(sampleVirtualCursor(actions, 1250)).toMatchObject({ x: 0.8, y: 0.6 });
    expect(sampleVirtualCursor(actions, 1300)).toMatchObject({ x: 0.2, y: 0.2 });
  });

  it("respects an existing meaningful movement window", () => {
    const moving = sampleVirtualCursor(ACTIONS, 1500);
    expect(moving?.x).toBeGreaterThan(0.5);
    expect(moving?.x).toBeLessThan(0.8);
  });

  it("uses a curved path instead of a straight line during travel", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 900, y: 250 }, { start: 1000, action: 2000, end: 2100 }),
    ]);

    const moving = sampleVirtualCursor(actions, 1500);

    expect(moving?.x).toBeGreaterThan(0.5);
    expect(moving?.x).toBeLessThan(0.9);
    expect(moving?.y).not.toBeCloseTo(0.5, 4);
  });

  it("compresses quick natural motion at the next semantic action time", () => {
    const start = eventWithTarget(
      { x: 293.1875, y: 376.59375 },
      { start: 289, action: 290, end: 416 },
    );
    const email = {
      ...eventWithTarget({ x: 491.375, y: 376.59375 }, { start: 416, action: 927, end: 1108 }),
      verb: "type",
      pointer: null,
    };
    const submit = eventWithTarget(
      { x: 696.9609375, y: 376.59375 },
      { start: 1108, action: 1108, end: 1233 },
    );
    const actions = actionsWithEvents([start, email, submit], { width: 1280, height: 720 });

    const atSemanticClick = sampleVirtualCursor(actions, 1108, "natural");
    expect(atSemanticClick?.x).toBeCloseTo(696.9609375 / 1280);
    expect(atSemanticClick?.ripple).not.toBeNull();

    const afterInput = sampleVirtualCursor(actions, 1300, "natural");
    expect(afterInput?.x).toBeCloseTo(696.9609375 / 1280);
    expect(afterInput?.ripple).not.toBeNull();
  });

  it("prefers explicit sidecar cursor timing and delays click ripple until input time", () => {
    const event = {
      ...eventWithTarget({ x: 800, y: 300 }, { start: 0, action: 2_000, end: 2_100 }),
      cursor_timing: {
        motion_preset: "natural" as const,
        start_ms: 1_000,
        arrival_ms: 1_320,
        travel_ms: 320,
        dwell_ms: 180,
      },
      input_timing: {
        kind: "click" as const,
        down_ms: 1_500,
        up_ms: 1_500,
        action_ms: 1_500,
      },
    };
    const actions = actionsWithEvents([event]);

    const schedule = buildVirtualCursorSchedule(actions, "natural");

    expect(schedule?.segments[0]).toMatchObject({
      startMs: 1_000,
      arrivalMs: 1_320,
      travelMs: 320,
      effectMs: 1_500,
    });
    expect(sampleVirtualCursor(actions, 1_400, "natural")?.ripple).toBeNull();
    expect(sampleVirtualCursor(actions, 1_520, "natural")?.ripple).toMatchObject({
      x: 0.8,
      y: 0.6,
    });
  });

  it("ignores non-interaction sidecar events when scheduling cursor movement", () => {
    const waitFor = {
      ...eventWithTarget({ x: 640, y: 170 }, { start: 1015, action: 1127, end: 12_000 }),
      verb: "wait-for",
      pointer: null,
    };
    const email = {
      ...eventWithTarget({ x: 460, y: 320 }, { start: 1127, action: 1604, end: 2415 }),
      verb: "type",
      pointer: null,
    };
    const password = {
      ...eventWithTarget({ x: 460, y: 390 }, { start: 2415, action: 2758, end: 3272 }),
      verb: "type",
      pointer: null,
    };
    const signIn = eventWithTarget({ x: 460, y: 470 }, { start: 3272, action: 3593, end: 3715 });
    const actions = actionsWithEvents([waitFor, email, password, signIn], {
      width: 1280,
      height: 720,
    });

    const schedule = buildVirtualCursorSchedule(actions, "natural");

    expect(schedule?.segments.map((segment) => segment.event.verb)).toEqual([
      "type",
      "type",
      "click",
    ]);
    expect(schedule?.segments[0]?.from).toEqual({ x: 640, y: 360 });
    expect(sampleVirtualCursor(actions, 1100, "natural")).toMatchObject({ x: 0.5, y: 0.5 });
    expect(virtualCursorVisualDurationMs(actions, "natural")).toBeLessThan(waitFor.t_end_ms);
  });

  it("returns no virtual cursor schedule for sidecars with only non-interaction events", () => {
    const waitFor = {
      ...eventWithTarget({ x: 640, y: 170 }, { start: 1015, action: 1127, end: 12_000 }),
      verb: "wait-for",
      pointer: null,
    };
    const actions = actionsWithEvents([waitFor], { width: 1280, height: 720 });

    expect(buildVirtualCursorSchedule(actions, "natural")).toBeNull();
    expect(virtualCursorVisualDurationMs(actions, "natural")).toBe(0);
    expect(sampleVirtualCursor(actions, 1127, "natural")).toBeNull();
  });

  it("does not treat unsupported upload sidecar events as cursor interactions", () => {
    const upload = {
      ...eventWithTarget({ x: 640, y: 170 }, { start: 1015, action: 1127, end: 1200 }),
      verb: "upload",
      pointer: null,
    };
    const click = eventWithTarget({ x: 460, y: 470 }, { start: 1500, action: 1900, end: 2000 });
    const actions = actionsWithEvents([upload, click], { width: 1280, height: 720 });

    expect(
      buildVirtualCursorSchedule(actions, "natural")?.segments.map((segment) => segment.event.verb),
    ).toEqual(["click"]);
  });
});
