import { describe, expect, it, vi } from "vitest";

import { canonicalGraph } from "../export-compositor/canonical-test-fixture";
import type { CanonicalVisualEnginePort } from "../export-compositor/canonical-visual-engine";
import {
  CanonicalPreviewAdapter,
  canonicalPreviewPresentationLayout,
  fitCanonicalCompositionRect,
} from "./canonical-preview-adapter";

function enginePort(): CanonicalVisualEnginePort {
  return {
    configure: vi.fn(async () => undefined),
    setPresentationLayout: vi.fn(),
    renderFrame: vi.fn(async () => ({ scene: {} as never, commands: [] })),
    readFrameBytes: vi.fn(() => new Uint8ClampedArray()),
    dispose: vi.fn(),
  };
}

describe("canonical preview presentation layout", () => {
  it("keeps an equal-aspect viewport aligned with the export frame", () => {
    const layout = canonicalPreviewPresentationLayout(
      { width: 960, height: 540, devicePixelRatio: 2 },
      1_920,
      1_080,
    );

    expect(layout.surfaceRect).toEqual({ x: 0, y: 0, w: 1_920, h: 1_080 });
    expect(layout.compositionRect).toEqual(layout.surfaceRect);
  });

  it.each([
    { width: 1_000, height: 800 },
    { width: 700, height: 1_000 },
  ])("fills a $width x $height stage without exceeding the export pixel budget", (viewport) => {
    const layout = canonicalPreviewPresentationLayout(
      { ...viewport, devicePixelRatio: 2 },
      1_920,
      1_080,
    );

    expect(layout.surfaceRect.w * layout.surfaceRect.h).toBeLessThanOrEqual(1_920 * 1_080);
    expect(layout.surfaceRect.w / layout.surfaceRect.h).toBeCloseTo(
      viewport.width / viewport.height,
      2,
    );
    expect(layout.compositionRect.w / layout.compositionRect.h).toBeCloseTo(16 / 9, 8);
    expect(layout.compositionRect.x).toBeGreaterThanOrEqual(0);
    expect(layout.compositionRect.y).toBeGreaterThanOrEqual(0);
    expect(layout.compositionRect.x + layout.compositionRect.w).toBeLessThanOrEqual(
      layout.surfaceRect.w,
    );
    expect(layout.compositionRect.y + layout.compositionRect.h).toBeLessThanOrEqual(
      layout.surfaceRect.h,
    );
  });

  it("centers the complete export frame inside a differently shaped surface", () => {
    expect(fitCanonicalCompositionRect(1_200, 1_200, 1_920, 1_080)).toEqual({
      x: 0,
      y: 262.5,
      w: 1_200,
      h: 675,
    });
  });

  it("updates the engine layout without reconfiguring graph assets", async () => {
    const engine = enginePort();
    const adapter = new CanonicalPreviewAdapter({} as HTMLCanvasElement, {}, engine);
    const graph = canonicalGraph([]);

    adapter.setPresentationViewport({ width: 1_000, height: 800, devicePixelRatio: 1 });
    expect(engine.setPresentationLayout).not.toHaveBeenCalled();

    await adapter.configure(graph);
    adapter.setPresentationViewport({ width: 1_100, height: 700, devicePixelRatio: 1 });

    expect(engine.configure).toHaveBeenCalledOnce();
    expect(engine.setPresentationLayout).toHaveBeenCalledTimes(2);
    expect(engine.setPresentationLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        surfaceRect: { x: 0, y: 0, w: 1_100, h: 700 },
      }),
    );
  });
});
