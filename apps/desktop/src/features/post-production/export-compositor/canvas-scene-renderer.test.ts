import type { ExportBackgroundKind, ExportTransitionKind } from "@storycapture/shared-types";
import { describe, expect, it, vi } from "vitest";

import type { VirtualCursorSample } from "../preview/virtual-cursor-path";
import { sampleCursorClickEffect } from "../state/cursor-click-effect";
import {
  canonicalGraph,
  canonicalGraphV5,
  canonicalSource,
  canonicalTextBox,
  canonicalTransition,
} from "./canonical-test-fixture";
import {
  buildCanonicalDrawCommands,
  CANONICAL_TRANSITION_KINDS,
  CanonicalCanvasSceneRenderer,
  type CanonicalRenderAssets,
  canonical1080pScale,
  canonicalCommandSnapshot,
} from "./canvas-scene-renderer";
import { evaluateScene } from "./scene-evaluator";

function createCanvasContextMock() {
  const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: "transparent",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: Array.from(text).length * 9 })),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, gradient };
}

const SOURCE_IMAGE = { width: 1_280, height: 720 } as unknown as CanvasImageSource;
const PORTRAIT_IMAGE = { width: 600, height: 900 } as unknown as CanvasImageSource;
const FOUR_THREE_IMAGE = { width: 1_024, height: 768 } as unknown as CanvasImageSource;

function assets(overrides: Partial<CanonicalRenderAssets> = {}): CanonicalRenderAssets {
  return {
    source: () => SOURCE_IMAGE,
    image: () => PORTRAIT_IMAGE,
    cursorSkin: () => SOURCE_IMAGE,
    cursorPngFrame: () => SOURCE_IMAGE,
    ...overrides,
  };
}

describe("canonical Canvas 2D renderer", () => {
  it.each([
    ["high", "high"],
    ["balanced", "medium"],
    ["fast", "low"],
  ] as const)("maps %s resampling to Canvas %s smoothing", (quality, canvasQuality) => {
    const { ctx } = createCanvasContextMock();
    const renderer = new CanonicalCanvasSceneRenderer(ctx, { resamplingQuality: quality });

    renderer.render(
      evaluateScene(canonicalGraph([canonicalSource("source-a", 0, 1_000)]), 500),
      assets(),
    );

    expect(ctx.imageSmoothingEnabled).toBe(true);
    expect(ctx.imageSmoothingQuality).toBe(canvasQuality);
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it.each([
    [720, 2 / 3],
    [1_080, 1],
    [2_160, 2],
  ])("clamps authored text metrics before applying the %sp output scale", (outputHeight, expectedScale) => {
    expect(canonical1080pScale(outputHeight)).toBeCloseTo(expectedScale, 10);
    const textBox = {
      ...canonicalTextBox(),
      size_pt: 100,
      letter_spacing_px: 30,
      text_shadow: {
        blur_px: 100,
        offset_x_px: 40,
        offset_y_px: -40,
        color: { r: 0, g: 0, b: 0, a: 255 },
      },
      box_style: {
        padding_px: 100,
        radius_px: 20,
        bg_color: { r: 20, g: 22, b: 26, a: 220 },
        border_color: { r: 255, g: 255, b: 255, a: 60 },
        border_width_px: 10,
        shadow: null,
      },
    };
    const graph = canonicalGraph([{ type: "text-overlay", id: "text", boxes: [textBox] }]);
    graph.output_height = outputHeight;
    graph.output_width = Math.round((outputHeight * 16) / 9);
    const { ctx } = createCanvasContextMock();

    const scene = evaluateScene(graph, 500);
    new CanonicalCanvasSceneRenderer(ctx).render(scene, assets());

    expect(ctx.font).toContain(`${72 * expectedScale}px`);
    expect(ctx.lineWidth).toBeCloseTo(8 * expectedScale, 10);
    expect(ctx.shadowBlur).toBeCloseTo(64 * expectedScale, 10);
    expect(ctx.shadowOffsetX).toBeCloseTo(32 * expectedScale, 10);
    expect(ctx.shadowOffsetY).toBeCloseTo(-32 * expectedScale, 10);
    const boxPathStart = vi.mocked(ctx.moveTo).mock.calls[0];
    expect(boxPathStart?.[1]).toBeCloseTo(
      -(72 * expectedScale * 1.15) / 2 - 64 * expectedScale,
      10,
    );
  });

  it("implements every canonical transition kind exhaustively", () => {
    const expected: ExportTransitionKind[] = [
      "fade",
      "fade-black",
      "fade-white",
      "dissolve",
      "wipe-left",
      "wipe-right",
      "wipe-up",
      "wipe-down",
      "slide-left",
      "slide-right",
      "slide-up",
      "slide-down",
      "circle-open",
      "circle-close",
    ];
    expect(CANONICAL_TRANSITION_KINDS).toEqual(expected);

    for (const kind of CANONICAL_TRANSITION_KINDS) {
      const { ctx } = createCanvasContextMock();
      const renderer = new CanonicalCanvasSceneRenderer(ctx);
      const graph = canonicalGraph([
        canonicalSource("source-a", 0, 1_000),
        canonicalSource("source-b", 1_000, 1_000),
        {
          type: "background",
          id: "background",
          kind: { kind: "solid", color: { r: 20, g: 30, b: 40, a: 255 } },
          radius_px: 20,
          shadow: null,
          padding_px: 32,
        },
        canonicalTransition(kind),
      ]);
      const scene = evaluateScene(graph, 900);

      expect(() => renderer.render(scene, assets())).not.toThrow();
      expect(scene.transition?.kind).toBe(kind);
      expect(vi.mocked(ctx.drawImage).mock.calls.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["ambient", { kind: "ambient" }],
    ["solid", { kind: "solid", color: { r: 12, g: 34, b: 56, a: 255 } }],
    ["gradient-texture", { kind: "gradient", preset_id: "paper-grain" }],
    ["image-cover-overlay", { kind: "image", asset_id: "photo", path: "/bg.png" }],
  ] as const)("renders %s background plus a borderless framed shadow", (_name, kind) => {
    const { ctx } = createCanvasContextMock();
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      {
        type: "background",
        id: "background",
        kind: kind as ExportBackgroundKind,
        radius_px: 24,
        shadow: null,
        padding_px: 40,
      },
    ]);

    const scene = evaluateScene(graph, 500);
    new CanonicalCanvasSceneRenderer(ctx).render(scene, assets());

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
    const expectedSourceWidth = 640 * (1_280 / 720);
    const expectedSourceX = 40 + (1_200 - expectedSourceWidth) / 2;
    const expectedRadius = 24 * canonical1080pScale(scene.output_height);
    const sourceShadowPathStart = vi.mocked(ctx.moveTo).mock.calls[0];
    expect(sourceShadowPathStart?.[0]).toBeCloseTo(expectedSourceX + expectedRadius, 3);
    expect(sourceShadowPathStart?.[1]).toBe(40);
    if (kind.kind === "image") {
      expect(vi.mocked(ctx.drawImage).mock.calls.some((call) => call[0] === PORTRAIT_IMAGE)).toBe(
        true,
      );
    }
    if (kind.kind === "gradient") expect(ctx.createLinearGradient).toHaveBeenCalledOnce();
  });

  it("clips the actual 4K source rect with resolution-scaled rounded corners", () => {
    const { ctx } = createCanvasContextMock();
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      {
        type: "background",
        id: "background",
        kind: { kind: "ambient" },
        radius_px: 24,
        shadow: null,
        padding_px: 40,
      },
    ]);
    graph.output_width = 3_840;
    graph.output_height = 2_160;
    const scene = evaluateScene(graph, 500);

    new CanonicalCanvasSceneRenderer(ctx).render(scene, assets());

    const expectedRadius = 48;
    const expectedSourceWidth = scene.content_rect.h * (1_280 / 720);
    const expectedSourceX = scene.content_rect.x + (scene.content_rect.w - expectedSourceWidth) / 2;
    const [shadowPathStart, sourceClipPathStart] = vi.mocked(ctx.moveTo).mock.calls;
    expect(shadowPathStart?.[0]).toBeCloseTo(expectedSourceX + expectedRadius, 3);
    expect(sourceClipPathStart?.[0]).toBeCloseTo(expectedSourceX + expectedRadius, 3);
    expect(sourceClipPathStart?.[1]).toBe(scene.content_rect.y);
  });

  it("draws one full presentation background and aspect-fits canonical foreground", () => {
    const { ctx } = createCanvasContextMock();
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      {
        type: "background",
        id: "background",
        kind: { kind: "solid", color: { r: 12, g: 34, b: 56, a: 255 } },
        radius_px: 24,
        shadow: null,
        padding_px: 40,
      },
    ]);
    const presentation = {
      surfaceRect: { x: 0, y: 0, w: 1_200, h: 1_000 },
      compositionRect: { x: 0, y: 162.5, w: 1_200, h: 675 },
    };

    new CanonicalCanvasSceneRenderer(ctx).render(evaluateScene(graph, 500), assets(), presentation);

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1_200, 1_000);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1_200, 1_000);
    expect(ctx.translate).toHaveBeenCalledWith(0, 162.5);
    expect(ctx.scale).toHaveBeenCalledWith(0.9375, 0.9375);
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it("contains an aspect-mismatched source inside the normalized V5 rectangle", () => {
    const { ctx } = createCanvasContextMock();
    const graph = canonicalGraphV5([
      canonicalSource("source-a", 0, 1_000),
      {
        type: "background",
        id: "background",
        kind: { kind: "solid", color: { r: 12, g: 20, b: 28, a: 255 } },
        radius_px: 24,
        shadow: null,
        foreground_scale: 0.85,
      },
    ]);

    new CanonicalCanvasSceneRenderer(ctx).render(
      evaluateScene(graph, 500),
      assets({ source: () => FOUR_THREE_IMAGE }),
    );

    const sourceDraw = vi.mocked(ctx.drawImage).mock.calls[0];
    expect(sourceDraw?.[0]).toBe(FOUR_THREE_IMAGE);
    expect(sourceDraw?.[1]).toBeCloseTo(232, 10);
    expect(sourceDraw?.[2]).toBeCloseTo(54, 10);
    expect(sourceDraw?.[3]).toBeCloseTo(816, 10);
    expect(sourceDraw?.[4]).toBeCloseTo(612, 10);
  });

  it("renders zoomed click feedback, cursor size, motion sample, and color tint", () => {
    const click = sampleCursorClickEffect(
      { style: "ring", color: "brand", intensity: "strong" },
      240,
    );
    if (!click) throw new Error("expected click feedback sample");
    const cursorNode = {
      type: "cursor-overlay" as const,
      id: "cursor",
      clip_id: "cursor-clip",
      skin: "big-arrow" as const,
      size_scale: 1.5,
      motion_preset: "natural" as const,
      preserve_full_motion: true,
      click_effect: { style: "ring", color: "brand", intensity: "strong" } as const,
      color_tint: { r: 255, g: 80, b: 120, a: 180 },
      t_start_ms: 0,
      duration_ms: 1_000,
      trajectory: {
        kind: "trajectory" as const,
        path: "/cursor.json",
        png_sequence_dir: "/cursor.json",
        fps: 60,
        frame_count: 60,
      },
    };
    const graph = canonicalGraph([canonicalSource("source-a", 0, 1_000), cursorNode]);
    const sample: VirtualCursorSample = {
      x: 0.62,
      y: 0.48,
      cursorScale: click.cursorScale,
      clickFeedback: [
        {
          x: 0.6,
          y: 0.5,
          elapsedMs: 240,
          progress: click.progress,
          primitives: click.primitives,
        },
      ],
    };
    const scene = evaluateScene(graph, 500, {
      cursor_samples: new Map([[cursorNode.id, sample]]),
    });
    const { ctx } = createCanvasContextMock();
    const scratchCtx = createCanvasContextMock().ctx;
    const scratch = {
      width: 0,
      height: 0,
      getContext: () => scratchCtx,
    } as unknown as HTMLCanvasElement;

    new CanonicalCanvasSceneRenderer(ctx, { createScratchCanvas: () => scratch }).render(
      scene,
      assets(),
    );

    expect(ctx.arc).toHaveBeenCalled();
    expect(vi.mocked(ctx.stroke).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ctx.translate).toHaveBeenCalledWith(0.62 * 1_280, 0.48 * 720);
    expect(ctx.scale).toHaveBeenCalledWith(click.cursorScale, click.cursorScale);
    expect(scratchCtx.fillStyle).toBe("rgba(255, 80, 120, 0.7058823529411765)");
  });

  it("covers zoom, source-bound ring/spotlight, ripple, tinted PNG cursor, and styled text", () => {
    const cursor = {
      type: "cursor-overlay" as const,
      id: "cursor-png",
      clip_id: "cursor-clip",
      skin: "light" as const,
      size_scale: 1.25,
      motion_preset: "snappy" as const,
      preserve_full_motion: false,
      click_effect: { style: "soft-pulse", color: "brand", intensity: "strong" } as const,
      color_tint: { r: 120, g: 50, b: 240, a: 180 },
      t_start_ms: 0,
      duration_ms: 1_000,
      trajectory: {
        kind: "png-sequence" as const,
        path: "/cursor/frame-%06d.png",
        png_sequence_dir: "/legacy",
        fps: 30,
        frame_count: 30,
      },
    };
    const highlights = {
      type: "highlight-overlay" as const,
      id: "highlights",
      highlights: [
        {
          clip_id: "ring",
          t_start_ms: 0,
          duration_ms: 1_000,
          shape: "ring" as const,
          center: { x: 100, y: 100 },
          source_center: { x: 0.3, y: 0.4 },
          source_bounds: { x: 0.2, y: 0.3, w: 0.2, h: 0.2 },
          max_radius_px: 42,
          padding_px: 8,
          radius_px: 10,
          stroke_px: 3,
          glow_px: 14,
          color: { r: 255, g: 190, b: 20, a: 255 },
          opacity: 0.8,
          png_path: "/highlight.png",
          overlay_pos: { x: 0.3, y: 0.4 },
        },
        {
          clip_id: "spotlight",
          t_start_ms: 0,
          duration_ms: 1_000,
          shape: "spotlight" as const,
          center: { x: 800, y: 400 },
          source_center: { x: 0.7, y: 0.55 },
          max_radius_px: 64,
          padding_px: 12,
          radius_px: 16,
          stroke_px: 2,
          glow_px: 20,
          color: { r: 255, g: 255, b: 255, a: 255 },
          opacity: 0.7,
        },
      ],
    };
    const sample: VirtualCursorSample = {
      x: 0.4,
      y: 0.5,
      cursorScale: 1,
      clickFeedback: [],
    };
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 1_000),
      {
        type: "zoom-pan",
        id: "zoom",
        clip_id: "zoom-clip",
        t_start_ms: 0,
        duration_ms: 1_000,
        target: { kind: "cursor" },
        keyframes: [
          { t_ms: 0, center: { x: 640, y: 360 }, scale: 1, easing: "linear" },
          { t_ms: 1_000, center: { x: 700, y: 380 }, scale: 1.8, easing: "ease-out-quad" },
        ],
      },
      cursor,
      highlights,
      {
        type: "ripple-overlay",
        id: "ripples",
        events: [
          {
            clip_id: "ripple",
            t_anticipate_ms: 300,
            t_impact_ms: 400,
            duration_ms: 400,
            center: { x: 0.45, y: 0.55 },
            max_radius_px: 48,
            color: { r: 40, g: 200, b: 255, a: 255 },
          },
        ],
      },
      {
        type: "text-overlay",
        id: "text",
        boxes: [
          {
            ...canonicalTextBox({ kind: "cursor", offset: { x: 0.03, y: -0.05 } }),
            box_style: {
              padding_px: 10,
              radius_px: 12,
              bg_color: { r: 20, g: 22, b: 26, a: 220 },
              border_color: { r: 255, g: 255, b: 255, a: 60 },
              border_width_px: 1,
              shadow: null,
            },
          },
        ],
      },
    ]);
    const scene = evaluateScene(graph, 500, { cursor_samples: new Map([[cursor.id, sample]]) });
    const commands = buildCanonicalDrawCommands(scene);
    const snapshot = canonicalCommandSnapshot(scene);
    const { ctx } = createCanvasContextMock();
    const scratchCtx = createCanvasContextMock().ctx;
    const scratch = {
      width: 0,
      height: 0,
      getContext: () => scratchCtx,
    } as unknown as HTMLCanvasElement;

    new CanonicalCanvasSceneRenderer(ctx, { createScratchCanvas: () => scratch }).render(
      scene,
      assets(),
    );

    expect(commands.map((command) => command.layer)).toEqual([
      "background",
      "source",
      "highlight",
      "highlight",
      "ripple",
      "cursor",
      "text",
    ]);
    expect(snapshot).toContain('"shape":"ring"');
    expect(snapshot).toContain('"shape":"spotlight"');
    expect(snapshot).toContain('"png_frame_index":15');
    expect(snapshot).toContain('"color_tint":{"r":120,"g":50,"b":240,"a":180}');
    expect(ctx.fill).toHaveBeenCalledWith("evenodd");
    expect(ctx.fillText).toHaveBeenCalled();
    expect(scratchCtx.globalCompositeOperation).toBe("source-over");
  });
});
