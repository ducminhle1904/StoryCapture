import { describe, expect, it, vi } from "vitest";

import v1Raw from "@/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import { parseActionSidecar } from "@/ipc/action-sidecar";
import { CanonicalImageAssetPool } from "./canonical-assets";
import { canonicalGraph, canonicalSource, canonicalTextBox } from "./canonical-test-fixture";
import { CanonicalVisualEngine, canonicalTargetBoundsFromActions } from "./canonical-visual-engine";
import {
  buildCanonicalDrawCommands,
  CanonicalCanvasSceneRenderer,
  type CanonicalDrawCommand,
  type CanonicalPresentationLayout,
  type CanonicalRenderAssets,
  type ExportResamplingQuality,
} from "./canvas-scene-renderer";
import { CanonicalMediaSourcePool } from "./media-source-pool";
import type { EvaluatedScene } from "./scene-evaluator";

class CapturingRenderer extends CanonicalCanvasSceneRenderer {
  scene: EvaluatedScene | null = null;
  presentationLayout: CanonicalPresentationLayout | undefined;
  lastResamplingQuality: ExportResamplingQuality | null = null;

  override setResamplingQuality(quality: ExportResamplingQuality): void {
    super.setResamplingQuality(quality);
    this.lastResamplingQuality = quality;
  }

  override render(
    scene: EvaluatedScene,
    _assets: CanonicalRenderAssets,
    presentation?: CanonicalPresentationLayout,
  ): CanonicalDrawCommand[] {
    this.scene = scene;
    this.presentationLayout = presentation;
    return buildCanonicalDrawCommands(scene);
  }
}

describe("canonical visual engine dynamic target anchors", () => {
  it("derives normalized step bounds from actions and passes them into runtime evaluation", async () => {
    const parsedActions = parseActionSidecar(v1Raw);
    if (!parsedActions) throw new Error("expected valid actions fixture");
    const event = parsedActions.events[0];
    if (!event?.target) throw new Error("expected target fixture");
    const offsetActions = {
      ...parsedActions,
      viewport: { width: 1_200, height: 600 },
      capture_rect: { x: 100, y: 50, width: 1_000, height: 500 },
      events: [
        {
          ...event,
          step_id: "step-runtime",
          target: {
            ...event.target,
            center: { x: 400, y: 200 },
            bounds: { x: 300, y: 150, w: 200, h: 100 },
          },
        },
      ],
    };
    expect(canonicalTargetBoundsFromActions(offsetActions).get("step-runtime")).toEqual({
      x: 0.2,
      y: 0.2,
      w: 0.2,
      h: 0.2,
    });

    const cursorNode = {
      type: "cursor-overlay" as const,
      id: "cursor-actions",
      clip_id: "cursor-actions-clip",
      skin: "mac-default" as const,
      size_scale: 1,
      motion_preset: "natural" as const,
      preserve_full_motion: true,
      click_effect: { style: "none", color: "auto", intensity: "normal" } as const,
      color_tint: null,
      t_start_ms: 0,
      duration_ms: 2_000,
      trajectory: {
        kind: "actions" as const,
        path: "/tmp/actions.json",
        png_sequence_dir: "/tmp/actions.json",
        fps: 60,
        frame_count: 120,
      },
    };
    const graph = canonicalGraph([
      canonicalSource("source-a", 0, 2_000),
      cursorNode,
      {
        type: "text-overlay",
        id: "text",
        boxes: [canonicalTextBox({ kind: "target", stepId: "start", placement: "right" })],
      },
    ]);
    const mediaPool = new CanonicalMediaSourcePool(async () => ({
      source: { width: 1_280, height: 720 } as unknown as CanvasImageSource,
      duration_us: 2_000_000,
      seek: async () => undefined,
      dispose: vi.fn(),
    }));
    const imagePool = new CanonicalImageAssetPool(
      async () => ({ width: 32, height: 32 }) as unknown as CanvasImageSource,
    );
    const ctx = { clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const renderer = new CapturingRenderer(ctx);
    const engine = new CanonicalVisualEngine(canvas, {
      context: ctx,
      mediaPool,
      imagePool,
      renderer,
      cursorSidecarLoader: async () => v1Raw,
      fontSet: null,
    });

    await engine.configure(graph);
    await engine.renderFrame(500);

    const targetText = renderer.scene?.text.find((text) => text.box.anchor.kind === "target");
    expect(targetText?.pos.x).toBeCloseTo(0.320302734375, 9);
    expect(targetText?.pos.y).toBeCloseTo(0.523046875, 9);
    engine.dispose();
  });
});

describe("canonical visual engine lifecycle", () => {
  it("resizes only the preview surface while preserving canonical scene coordinates", async () => {
    const ctx = { clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const renderer = new CapturingRenderer(ctx);
    const graph = canonicalGraph([]);
    const engine = new CanonicalVisualEngine(canvas, {
      context: ctx,
      renderer,
      fontSet: null,
    });
    const presentation = {
      surfaceRect: { x: 0, y: 0, w: 1_200, h: 1_000 },
      compositionRect: { x: 0, y: 162.5, w: 1_200, h: 675 },
    };

    await engine.configure(graph);
    engine.setPresentationLayout(presentation);
    await engine.renderFrame(500);

    expect(canvas.width).toBe(1_200);
    expect(canvas.height).toBe(1_000);
    expect(renderer.presentationLayout).toEqual(presentation);
    expect(renderer.scene?.output_width).toBe(graph.output_width);
    expect(renderer.scene?.output_height).toBe(graph.output_height);

    engine.setPresentationLayout(null);
    expect(canvas.width).toBe(graph.output_width);
    expect(canvas.height).toBe(graph.output_height);
    engine.dispose();
  });

  it("threads runtime resampling quality without changing the graph", async () => {
    const ctx = { clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const renderer = new CapturingRenderer(ctx);
    const graph = canonicalGraph([]);
    const engine = new CanonicalVisualEngine(canvas, {
      context: ctx,
      renderer,
      fontSet: null,
    });

    await engine.configure(graph, { resamplingQuality: "balanced" });

    expect(renderer.lastResamplingQuality).toBe("balanced");
    expect(graph).not.toHaveProperty("resampling_quality");
    engine.dispose();
  });

  it("does not paint a stale frame after the engine is disposed", async () => {
    let resolveSeek!: () => void;
    let signalSeekStarted!: () => void;
    const seekStarted = new Promise<void>((resolve) => {
      signalSeekStarted = resolve;
    });
    const mediaPool = new CanonicalMediaSourcePool(async () => ({
      source: { width: 1_280, height: 720 } as unknown as CanvasImageSource,
      duration_us: 2_000_000,
      seek: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSeek = resolve;
            signalSeekStarted();
          }),
      ),
      dispose: vi.fn(),
    }));
    const imagePool = new CanonicalImageAssetPool(
      async () => ({ width: 32, height: 32 }) as unknown as CanvasImageSource,
    );
    const ctx = { clearRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const renderer = new CapturingRenderer(ctx);
    const engine = new CanonicalVisualEngine(canvas, {
      context: ctx,
      mediaPool,
      imagePool,
      renderer,
      fontSet: null,
    });

    await engine.configure(canonicalGraph([canonicalSource("source-a", 0, 2_000)]));
    const render = engine.renderFrame(500);
    await seekStarted;
    engine.dispose();
    resolveSeek();

    await expect(render).rejects.toThrow("canonical visual engine render was superseded");
    expect(renderer.scene).toBeNull();
  });
});
