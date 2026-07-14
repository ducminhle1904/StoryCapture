import { describe, expect, it, vi } from "vitest";

import type { VirtualCursorSample } from "../preview/virtual-cursor-path";
import type { Graph, TextBox } from "../state/compute-graph";
import { sampleCursorClickEffect } from "../state/cursor-click-effect";
import {
  drawExportCursorSample,
  drawExportTextBox,
  layoutExportTextBox,
  loadExportTextFonts,
  segmentTextGraphemes,
} from "./export-compositor-app";

interface CanvasCall {
  name: string;
  args: unknown[];
  alpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

function createCanvasMock() {
  const calls: CanvasCall[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "#000",
    font: "10px sans-serif",
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: "transparent",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    strokeStyle: "#000",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;
  const record = (name: string, args: unknown[]) => {
    calls.push({
      name,
      args,
      alpha: ctx.globalAlpha,
      fillStyle: ctx.fillStyle,
      font: ctx.font,
      lineWidth: ctx.lineWidth,
      shadowBlur: ctx.shadowBlur,
      shadowColor: ctx.shadowColor,
      shadowOffsetX: ctx.shadowOffsetX,
      shadowOffsetY: ctx.shadowOffsetY,
      strokeStyle: ctx.strokeStyle,
      textAlign: ctx.textAlign,
      textBaseline: ctx.textBaseline,
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
    "fillText",
    "moveTo",
    "lineTo",
    "quadraticCurveTo",
  ] as const) {
    Object.assign(ctx, { [name]: vi.fn((...args: unknown[]) => record(name, args)) });
  }
  Object.assign(ctx, {
    measureText: vi.fn((text: string) => ({ width: Array.from(text).length * 10 })),
  });
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

const CUSTOM_TEXT_BOX: TextBox = {
  t_start_ms: 0,
  t_end_ms: 1_000,
  text: "AB CD\nE",
  pos: { x: 0.5, y: 0.5 },
  font: {
    kind: "system",
    family: "Example Sans",
    fullName: "Example Sans Semibold Italic",
    postscriptName: "ExampleSans-SemiboldItalic",
    faceStyle: "Semibold Italic",
    weight: 600,
    style: "italic",
  },
  size_pt: 20,
  color: { r: 240, g: 241, b: 242, a: 255 },
  align: "right",
  max_width_pct: 25,
  line_height: 1.5,
  letter_spacing_px: 2,
  text_shadow: {
    color: { r: 17, g: 34, b: 51, a: 128 },
    blur_px: 7,
    offset_x_px: 1.5,
    offset_y_px: 2,
  },
  box_style: {
    padding_px: 4,
    radius_px: 6,
    bg_color: { r: 34, g: 51, b: 68, a: 204 },
    border_color: { r: 254, g: 220, b: 186, a: 153 },
    border_width_px: 2.5,
    shadow: {
      color: { r: 1, g: 2, b: 3, a: 102 },
      blur_px: 9,
      offset_x_px: -2,
      offset_y_px: 3,
    },
  },
  anim_in: "none",
  anim_out: "none",
  anim_duration_ms: 0,
};

function graphWithText(box: TextBox): Graph {
  return {
    schema_version: 3,
    output_width: 200,
    output_height: 100,
    output_fps: 60,
    video: [{ type: "text-overlay", id: "text", boxes: [box] }],
    audio: [],
  };
}

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

describe("export text canvas renderer", () => {
  it("keeps combining marks and joined emoji together for wrapping and letter spacing", () => {
    expect(segmentTextGraphemes("e\u0301👨‍👩‍👧‍👦")).toEqual(["é", "👨‍👩‍👧‍👦"]);
  });

  it("loads the resolved face before layout and retries with Geist when loading fails", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("font unavailable"))
      .mockResolvedValueOnce([]);

    await loadExportTextFonts(graphWithText(CUSTOM_TEXT_BOX), { load } as Pick<
      FontFaceSet,
      "load"
    >);

    expect(load).toHaveBeenNthCalledWith(
      1,
      'italic 600 20px "Example Sans", "Geist", sans-serif',
      "AB CD\nE",
    );
    expect(load).toHaveBeenNthCalledWith(2, 'normal 500 20px "Geist", sans-serif', "AB CD\nE");
  });

  it("wraps deterministically and draws multiline alignment, spacing, shadows, and box styling", () => {
    const { calls, ctx } = createCanvasMock();

    const layout = layoutExportTextBox(ctx, CUSTOM_TEXT_BOX, 200);
    expect(layout).toEqual({
      lines: [
        { text: "AB", width: 22 },
        { text: "CD", width: 22 },
        { text: "E", width: 10 },
      ],
      width: 22,
      height: 90,
      lineHeight: 30,
    });

    drawExportTextBox(ctx, CUSTOM_TEXT_BOX, 500, 200, 100);

    expect(calls.find((call) => call.name === "translate")?.args).toEqual([100, 50]);
    expect(calls.filter((call) => call.name === "quadraticCurveTo")).toHaveLength(4);
    expect(calls.find((call) => call.name === "fill")).toMatchObject({
      fillStyle: "rgba(34, 51, 68, 0.8)",
      shadowColor: "rgba(1, 2, 3, 0.4)",
      shadowBlur: 9,
      shadowOffsetX: -2,
      shadowOffsetY: 3,
    });
    expect(calls.find((call) => call.name === "stroke")).toMatchObject({
      lineWidth: 2.5,
      shadowColor: "transparent",
      strokeStyle: "rgba(254, 220, 186, 0.6)",
    });
    const glyphs = calls.filter((call) => call.name === "fillText");
    expect(glyphs.map((call) => call.args)).toEqual([
      ["A", -11, -30],
      ["B", 1, -30],
      ["C", -11, 0],
      ["D", 1, 0],
      ["E", 1, 30],
    ]);
    expect(glyphs[0]).toMatchObject({
      font: 'italic 600 20px "Example Sans", "Geist", sans-serif',
      shadowBlur: 7,
      shadowOffsetX: 1.5,
      shadowOffsetY: 2,
      textAlign: "left",
      textBaseline: "middle",
    });
    expect(glyphs[0]?.shadowColor).toContain("rgba(17, 34, 51");
  });

  it("uses the same adaptive horizontal origin as the preview near frame edges", () => {
    const left = createCanvasMock();
    drawExportTextBox(
      left.ctx,
      { ...CUSTOM_TEXT_BOX, text: "AB", pos: { x: 0.08, y: 0.5 }, align: "left", box_style: null },
      500,
      200,
      100,
    );
    expect(left.calls.find((call) => call.name === "fillText")?.args[1]).toBe(0);

    const right = createCanvasMock();
    drawExportTextBox(
      right.ctx,
      { ...CUSTOM_TEXT_BOX, text: "AB", pos: { x: 0.92, y: 0.5 }, box_style: null },
      500,
      200,
      100,
    );
    expect(right.calls.find((call) => call.name === "fillText")?.args[1]).toBe(-22);
  });
});
