import { describe, expect, it, vi } from "vitest";

import type { VirtualCursorSample } from "../preview/virtual-cursor-path";
import { sampleCursorClickEffect } from "../state/cursor-click-effect";
import { drawExportCursorSample } from "./export-compositor-app";

interface CanvasCall {
  name: string;
  args: unknown[];
  alpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  shadowBlur: number;
  shadowColor: string;
  strokeStyle: string | CanvasGradient | CanvasPattern;
}

function createCanvasMock() {
  const calls: CanvasCall[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "#000",
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: "transparent",
    strokeStyle: "#000",
  } as unknown as CanvasRenderingContext2D;
  const record = (name: string, args: unknown[]) => {
    calls.push({
      name,
      args,
      alpha: ctx.globalAlpha,
      fillStyle: ctx.fillStyle,
      lineWidth: ctx.lineWidth,
      shadowBlur: ctx.shadowBlur,
      shadowColor: ctx.shadowColor,
      strokeStyle: ctx.strokeStyle,
    });
  };
  for (const name of [
    "save",
    "restore",
    "beginPath",
    "closePath",
    "fill",
    "stroke",
    "arc",
    "translate",
    "scale",
    "drawImage",
    "moveTo",
    "lineTo",
  ] as const) {
    Object.assign(ctx, { [name]: vi.fn((...args: unknown[]) => record(name, args)) });
  }
  return { calls, ctx };
}

function sampleWithFeedback(
  style: "ring" | "soft-pulse" | "echo" | "press",
  elapsedMs: number,
): VirtualCursorSample {
  const frame = sampleCursorClickEffect({ style, color: "brand", intensity: "normal" }, elapsedMs);
  if (!frame) throw new Error(`expected an active ${style} frame`);
  return {
    x: 0.5,
    y: 0.5,
    clickFeedback: [
      {
        x: 0.25,
        y: 0.75,
        elapsedMs,
        progress: frame.progress,
        primitives: frame.primitives,
      },
    ],
    cursorScale: frame.cursorScale,
  };
}

const NO_ZOOM = { center: { x: 960, y: 540 }, scale: 1 };

describe("export virtual cursor canvas renderer", () => {
  it.each([
    ["ring", 260],
    ["soft-pulse", 150],
    ["echo", 180],
    ["press", 110],
  ] as const)("draws shared %s primitives with explicit fill, dual-tone stroke, and glow", (style, elapsedMs) => {
    const { calls, ctx } = createCanvasMock();
    const sample = sampleWithFeedback(style, elapsedMs);

    drawExportCursorSample(ctx, sample, null, 1, NO_ZOOM, 1920, 1080);

    const primitiveCount = sample.clickFeedback[0]?.primitives.length ?? 0;
    const arcs = calls.filter((call) => call.name === "arc");
    const fills = calls.filter((call) => call.name === "fill");
    const strokes = calls.filter((call) => call.name === "stroke");
    expect(arcs).toHaveLength(primitiveCount);
    expect(fills.length).toBeGreaterThanOrEqual(primitiveCount + 1);
    expect(strokes).toHaveLength(primitiveCount * 2 + 1);

    const primitive = sample.clickFeedback[0]?.primitives[0];
    expect(primitive).toBeDefined();
    expect(strokes[0]).toMatchObject({
      alpha: primitive?.opacity,
      lineWidth: (primitive?.strokeWidth ?? 0) + 2,
      shadowBlur: 0,
      shadowColor: "transparent",
      strokeStyle: primitive?.contrast,
    });
    expect(strokes[1]).toMatchObject({
      alpha: primitive?.opacity,
      lineWidth: primitive?.strokeWidth,
      shadowBlur: primitive?.glowBlur,
      shadowColor: primitive?.foreground,
      strokeStyle: primitive?.foreground,
    });
  });

  it("draws overlapping feedback oldest-to-newest before the cursor", () => {
    const { calls, ctx } = createCanvasMock();
    const ring = sampleWithFeedback("ring", 160).clickFeedback[0];
    if (!ring) throw new Error("expected ring feedback");
    const sample: VirtualCursorSample = {
      x: 0.8,
      y: 0.2,
      clickFeedback: [
        { ...ring, x: 0.2, y: 0.3 },
        { ...ring, x: 0.6, y: 0.7 },
      ],
      cursorScale: 1,
    };
    const image = {} as HTMLImageElement;

    drawExportCursorSample(ctx, sample, image, 1, NO_ZOOM, 1920, 1080);

    expect(
      calls.filter((call) => call.name === "arc").map((call) => call.args.slice(0, 2)),
    ).toEqual([
      [384, 324],
      [1152, 756],
    ]);
    expect(calls.findIndex((call) => call.name === "drawImage")).toBeGreaterThan(
      calls.findLastIndex((call) => call.name === "stroke"),
    );
  });

  it("applies zoom once and scales design geometry from 1080p to 4K", () => {
    const { calls, ctx } = createCanvasMock();
    const sample = sampleWithFeedback("ring", 260);
    const feedback = sample.clickFeedback[0];
    if (!feedback?.primitives[0]) throw new Error("expected ring primitive");
    sample.x = 0.6;
    sample.y = 0.5;
    sample.clickFeedback[0] = { ...feedback, x: 0.6, y: 0.5 };
    const image = {} as HTMLImageElement;
    const zoom = { center: { x: 1920, y: 1080 }, scale: 2 };

    drawExportCursorSample(ctx, sample, image, 1, zoom, 3840, 2160);

    expect(calls.find((call) => call.name === "translate")?.args).toEqual([2688, 1080]);
    expect(calls.find((call) => call.name === "arc")?.args.slice(0, 3)).toEqual([
      2688,
      1080,
      feedback.primitives[0].radius * 2,
    ]);
    expect(calls.find((call) => call.name === "drawImage")?.args).toEqual([image, -2, -2, 64, 64]);
  });

  it("scales image and fallback cursors around a fixed hotspot for Press", () => {
    const pressed = sampleWithFeedback("press", 80);
    const image = {} as HTMLImageElement;
    const imageMock = createCanvasMock();
    const fallbackMock = createCanvasMock();

    drawExportCursorSample(imageMock.ctx, pressed, image, 1.5, NO_ZOOM, 1920, 1080);
    drawExportCursorSample(fallbackMock.ctx, pressed, null, 1.5, NO_ZOOM, 1920, 1080);

    for (const calls of [imageMock.calls, fallbackMock.calls]) {
      expect(calls.find((call) => call.name === "translate")?.args).toEqual([960, 540]);
      expect(calls.find((call) => call.name === "scale")?.args).toEqual([
        pressed.cursorScale,
        pressed.cursorScale,
      ]);
    }
    expect(imageMock.calls.find((call) => call.name === "drawImage")?.args).toEqual([
      image,
      -1.5,
      -1.5,
      48,
      48,
    ]);
    expect(fallbackMock.calls.find((call) => call.name === "moveTo")?.args).toEqual([0, 0]);
  });

  it("renders none and trajectory samples without stale click feedback", () => {
    expect(
      sampleCursorClickEffect({ style: "none", color: "auto", intensity: "normal" }, 0),
    ).toBeNull();
    const { calls, ctx } = createCanvasMock();
    const trajectorySample: VirtualCursorSample = {
      x: 0.4,
      y: 0.6,
      clickFeedback: [],
      cursorScale: 1,
    };

    drawExportCursorSample(ctx, trajectorySample, null, 1, NO_ZOOM, 1920, 1080);

    expect(calls.filter((call) => call.name === "arc")).toHaveLength(0);
    expect(calls.find((call) => call.name === "translate")?.args).toEqual([768, 648]);
    expect(calls.find((call) => call.name === "scale")?.args).toEqual([1, 1]);
  });
});
