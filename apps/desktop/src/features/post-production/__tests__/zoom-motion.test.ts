import { describe, expect, it } from "vitest";
import {
  applyZoomToBounds,
  applyZoomToPoint,
  resolveZoomMotion,
  sampleZoom,
  zoomTiming,
} from "../state/zoom-motion";
import type { ZoomClip } from "../state/timeline-slice";

function zoomClip(overrides: Partial<ZoomClip> = {}): ZoomClip {
  return {
    id: "zoom-1",
    trackId: "zoom",
    startMs: 1_000,
    durationMs: 1_600,
    target: { kind: "cursor" },
    center: { x: 0.5, y: 0.5 },
    scale: 1.28,
    ...overrides,
  };
}

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

  it("allocates cinematic phases from duration and scale", () => {
    expect(zoomTiming(zoomClip())).toEqual({ inEndMs: 1_506, outStartMs: 2_094 });
    const stronger = zoomTiming(zoomClip({ scale: 1.5 }));
    expect(stronger.inEndMs).toBe(1_533);
    expect(stronger.outStartMs).toBe(2_067);
  });

  it("samples zoom-in, hold, zoom-out, and exact boundaries", () => {
    const clip = zoomClip();
    const timing = zoomTiming(clip);
    expect(sampleZoom([clip], clip.startMs)).toEqual({ center: { x: 0.5, y: 0.5 }, scale: 1 });
    expect(sampleZoom([clip], timing.inEndMs).scale).toBeCloseTo(1.28);
    expect(sampleZoom([clip], timing.outStartMs).scale).toBeCloseTo(1.28);
    const zoomOutMidpoint = timing.outStartMs + (clip.startMs + clip.durationMs - timing.outStartMs) / 2;
    expect(sampleZoom([clip], zoomOutMidpoint).scale).toBeCloseTo(1.035);
    expect(sampleZoom([clip], clip.startMs + clip.durationMs - 50).scale).toBeLessThan(1.001);
    expect(sampleZoom([clip], clip.startMs + clip.durationMs)).toEqual({
      center: { x: 0.5, y: 0.5 },
      scale: 1,
    });
  });

  it("hands dense automatic zooms directly between targets", () => {
    const clips = [
      zoomClip({ id: "auto-1", origin: "auto", center: { x: 0.2, y: 0.2 } }),
      zoomClip({
        id: "auto-2",
        origin: "auto",
        startMs: 2_200,
        center: { x: 0.8, y: 0.8 },
        scale: 1.5,
      }),
    ];
    const resolved = resolveZoomMotion(clips);
    expect(resolved).toHaveLength(1);
    expect(sampleZoom(clips, 2_200).scale).toBeCloseTo(1.28);
    expect(sampleZoom(clips, 2_475).scale).toBeGreaterThan(1.28);
  });

  it("keeps authored overlaps independent and treats missing origin as authored", () => {
    const motions = resolveZoomMotion([
      zoomClip({ id: "legacy" }),
      zoomClip({ id: "authored", origin: "authored", startMs: 1_300 }),
    ]);
    expect(motions).toHaveLength(2);
    expect(sampleZoom([zoomClip({ center: { x: -1, y: 2 }, scale: 2 })], 1_550).center).toEqual({
      x: 0.25,
      y: 0.75,
    });
  });

  it("ignores invalid clips and compresses short clip phases without crossing", () => {
    const short = zoomClip({ durationMs: 200 });
    const timing = zoomTiming(short);
    expect(timing.inEndMs).toBeLessThanOrEqual(timing.outStartMs);
    expect(timing.outStartMs).toBeLessThanOrEqual(short.startMs + short.durationMs);
    expect(resolveZoomMotion([zoomClip({ durationMs: 0 }), zoomClip({ startMs: Number.NaN })])).toEqual(
      [],
    );
  });
});
