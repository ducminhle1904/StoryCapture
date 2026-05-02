import { describe, expect, it } from "vitest";
import type { RecordingActions } from "@/ipc/actions";
import { sampleVirtualCursor } from "../virtual-cursor-path";
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

  it("synthesizes pre-impact travel for zero-window actions", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 800, y: 300 }, { start: 2000, action: 2000, end: 2100 }),
    ]);

    const early = sampleVirtualCursor(actions, 1600);
    expect(early?.x).toBeGreaterThan(0.5);
    expect(early?.x).toBeLessThan(0.8);

    const moving = sampleVirtualCursor(actions, 1800);
    expect(moving?.x).toBeGreaterThan(0.5);
    expect(moving?.x).toBeLessThan(0.8);

    const arrived = sampleVirtualCursor(actions, 1999);
    expect(arrived?.x).toBeGreaterThan(0.79);
    expect(sampleVirtualCursor(actions, 2000)).toMatchObject({ x: 0.8, y: 0.6 });
  });

  it("uses a longer bounded travel window for long-distance zero-window actions", () => {
    const actions = actionsWithEvents(
      [eventWithTarget({ x: 3000, y: 2000 }, { start: 2000, action: 2000, end: 2100 })],
      { width: 3000, height: 2000 },
    );

    const early = sampleVirtualCursor(actions, 1500);
    expect(early?.x).toBeGreaterThan(0.5);
    expect(early?.x).toBeLessThan(1);
  });

  it("uses the selected motion preset for synthetic travel timing", () => {
    const actions = actionsWithEvents(
      [eventWithTarget({ x: 3000, y: 2000 }, { start: 2000, action: 2000, end: 2100 })],
      { width: 3000, height: 2000 },
    );

    const snappy = sampleVirtualCursor(actions, 1000, "snappy");
    const cinematic = sampleVirtualCursor(actions, 1000, "cinematic");

    expect(snappy?.x).toBeCloseTo(0.5);
    expect(cinematic?.x).toBeGreaterThan(0.5);
  });

  it("keeps a minimum visible travel window for short-distance zero-window actions", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 510, y: 250 }, { start: 2000, action: 2000, end: 2100 }),
    ]);

    expect(sampleVirtualCursor(actions, 1600)).toMatchObject({ x: 0.5, y: 0.5 });

    const moving = sampleVirtualCursor(actions, 1800);
    expect(moving?.x).toBeGreaterThan(0.5);
    expect(moving?.x).toBeLessThan(0.51);
  });

  it("interpolates deterministically between tightly spaced zero-window actions", () => {
    const actions = actionsWithEvents([
      eventWithTarget({ x: 800, y: 300 }, { start: 1000, action: 1000, end: 1200 }),
      eventWithTarget({ x: 200, y: 100 }, { start: 1300, action: 1300, end: 1400 }),
    ]);

    const moving = sampleVirtualCursor(actions, 1250);
    expect(moving?.x).toBeGreaterThan(0.18);
    expect(moving?.x).toBeLessThan(0.8);
    expect(moving?.y).toBeGreaterThan(0.18);
    expect(moving?.y).toBeLessThan(0.6);
  });

  it("respects an existing meaningful movement window", () => {
    const moving = sampleVirtualCursor(ACTIONS, 1200);
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
});
