import { describe, expect, it } from "vitest";

import { nextWindowBoundsForViewport } from "./viewport-fit.mjs";

describe("nextWindowBoundsForViewport", () => {
  it("reports done when the inner viewport already matches the target", () => {
    const out = nextWindowBoundsForViewport(
      { width: 1960, height: 1140 },
      { w: 1920, h: 1080 },
      { width: 1920, height: 1080 },
    );

    expect(out.done).toBe(true);
    expect(out.deltaWidth).toBe(0);
    expect(out.deltaHeight).toBe(0);
    expect(out.nextBounds).toBeNull();
  });

  it("adds the residual delta onto the current outer bounds", () => {
    const out = nextWindowBoundsForViewport(
      { width: 1920, height: 1080 },
      { w: 1900, h: 1030 },
      { width: 1920, height: 1080 },
    );

    expect(out.done).toBe(false);
    expect(out.deltaWidth).toBe(20);
    expect(out.deltaHeight).toBe(50);
    expect(out.nextBounds).toEqual({ width: 1940, height: 1130 });
  });

  it("handles overshoot by shrinking the outer bounds", () => {
    const out = nextWindowBoundsForViewport(
      { width: 1980, height: 1160 },
      { w: 1940, h: 1100 },
      { width: 1920, height: 1080 },
    );

    expect(out.done).toBe(false);
    expect(out.deltaWidth).toBe(-20);
    expect(out.deltaHeight).toBe(-20);
    expect(out.nextBounds).toEqual({ width: 1960, height: 1140 });
  });
});
