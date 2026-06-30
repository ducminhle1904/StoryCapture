import { describe, expect, it } from "vitest";
import type { ActionTarget } from "./action-timeline";
import {
  cursorPointForTarget,
  estimateCursorTravelDelayMs,
  initialCursorPoint,
  normalizeCursorTimingSize,
} from "./cursor-timing";

function target(center: { x: number; y: number }, size = 44): ActionTarget {
  return {
    kind: "element",
    label: "Demo target",
    center,
    bounds: {
      x: center.x - size / 2,
      y: center.y - size / 2,
      w: size,
      h: size,
    },
  };
}

describe("host cursor timing", () => {
  it("starts recorded automation at the capture center", () => {
    expect(initialCursorPoint({ width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
  });

  it("mirrors the natural cursor minimum for demo-like field movement", () => {
    const size = { width: 1280, height: 800 };
    const delayMs = estimateCursorTravelDelayMs({
      from: initialCursorPoint(size),
      target: target({ x: 460, y: 320 }),
      size,
    });

    expect(delayMs).toBeGreaterThanOrEqual(320);
  });

  it("clamps invalid sizes and target points to the capture area", () => {
    const size = normalizeCursorTimingSize({ width: 0, height: Number.NaN });

    expect(size).toEqual({ width: 1280, height: 720 });
    expect(cursorPointForTarget(target({ x: 2000, y: -20 }), size)).toEqual({
      x: 1280,
      y: 0,
    });
  });
});
