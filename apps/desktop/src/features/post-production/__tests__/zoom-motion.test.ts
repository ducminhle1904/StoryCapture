import { describe, expect, it } from "vitest";
import { applyZoomToBounds, applyZoomToPoint } from "../state/zoom-motion";

describe("zoom-motion", () => {
  it("maps normalized points through crop-safe zoom", () => {
    expect(applyZoomToPoint({ x: 0.5, y: 0.5 }, { center: { x: 0.5, y: 0.5 }, scale: 2 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(
      applyZoomToPoint({ x: 0.25, y: 0.25 }, { center: { x: 0.5, y: 0.5 }, scale: 2 }),
    ).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      applyZoomToPoint({ x: 0.75, y: 0.75 }, { center: { x: 0.5, y: 0.5 }, scale: 2 }),
    ).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("clamps zoom center before mapping edge points and bounds", () => {
    const edgePoint = applyZoomToPoint(
      { x: 0.05, y: 0.95 },
      { center: { x: 0.05, y: 0.95 }, scale: 2 },
    );
    expect(edgePoint.x).toBeCloseTo(0.1);
    expect(edgePoint.y).toBeCloseTo(0.9);
    expect(
      applyZoomToBounds(
        { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        { center: { x: 0.5, y: 0.5 }, scale: 2 },
      ),
    ).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});
