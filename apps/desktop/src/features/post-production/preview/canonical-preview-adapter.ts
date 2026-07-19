import type { SupportedExportCompositionGraph } from "@storycapture/shared-types";

import {
  type CanonicalRenderedFrame,
  CanonicalVisualEngine,
  type CanonicalVisualEngineOptions,
  type CanonicalVisualEnginePort,
  canonicalFrameCommandSnapshot,
} from "../export-compositor/canonical-visual-engine";
import type { CanonicalPresentationLayout } from "../export-compositor/canvas-scene-renderer";
import type { SceneEvaluationInputs } from "../export-compositor/scene-evaluator";

export interface CanonicalPreviewViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

function positive(value: number, fallback = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function fitCanonicalCompositionRect(
  surfaceWidth: number,
  surfaceHeight: number,
  outputWidth: number,
  outputHeight: number,
): CanonicalPresentationLayout["compositionRect"] {
  const safeSurfaceWidth = positive(surfaceWidth);
  const safeSurfaceHeight = positive(surfaceHeight);
  const scale = Math.min(
    safeSurfaceWidth / positive(outputWidth),
    safeSurfaceHeight / positive(outputHeight),
  );
  const width = positive(outputWidth) * scale;
  const height = positive(outputHeight) * scale;
  return {
    x: (safeSurfaceWidth - width) / 2,
    y: (safeSurfaceHeight - height) / 2,
    w: width,
    h: height,
  };
}

export function canonicalPreviewPresentationLayout(
  viewport: CanonicalPreviewViewport,
  outputWidth: number,
  outputHeight: number,
): CanonicalPresentationLayout {
  const cssWidth = positive(viewport.width);
  const cssHeight = positive(viewport.height);
  const devicePixelRatio = positive(viewport.devicePixelRatio);
  const outputPixelBudget = positive(outputWidth) * positive(outputHeight);
  const requestedScale = Math.min(
    devicePixelRatio,
    Math.sqrt(outputPixelBudget / (cssWidth * cssHeight)),
  );
  const surfaceWidth = Math.max(1, Math.floor(cssWidth * requestedScale));
  const surfaceHeight = Math.max(1, Math.floor(cssHeight * requestedScale));
  return {
    surfaceRect: { x: 0, y: 0, w: surfaceWidth, h: surfaceHeight },
    compositionRect: fitCanonicalCompositionRect(
      surfaceWidth,
      surfaceHeight,
      outputWidth,
      outputHeight,
    ),
  };
}

/** Preview-side adapter over the exact visual engine used by hidden export. */
export class CanonicalPreviewAdapter {
  private graph: SupportedExportCompositionGraph | null = null;
  private viewport: CanonicalPreviewViewport | null = null;
  private readonly engine: CanonicalVisualEnginePort;

  constructor(
    canvas: HTMLCanvasElement,
    options: CanonicalVisualEngineOptions = {},
    engine?: CanonicalVisualEnginePort,
  ) {
    this.engine = engine ?? new CanonicalVisualEngine(canvas, options);
  }

  async configure(graph: SupportedExportCompositionGraph): Promise<void> {
    await this.engine.configure(graph);
    this.graph = graph;
    this.applyPresentationLayout();
  }

  setPresentationViewport(viewport: CanonicalPreviewViewport): void {
    this.viewport = viewport;
    this.applyPresentationLayout();
  }

  renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame> {
    return this.engine.renderFrame(timestampMs);
  }

  frameCommandSnapshot(timestampMs: number): string {
    if (!this.graph) throw new Error("canonical preview adapter is not configured");
    return canonicalFrameCommandSnapshot(this.graph, timestampMs);
  }

  readFrameBytes(): Uint8ClampedArray {
    return this.engine.readFrameBytes();
  }

  dispose(): void {
    this.graph = null;
    this.viewport = null;
    this.engine.dispose();
  }

  private applyPresentationLayout(): void {
    if (!this.graph || !this.viewport) return;
    this.engine.setPresentationLayout(
      canonicalPreviewPresentationLayout(
        this.viewport,
        this.graph.output_width,
        this.graph.output_height,
      ),
    );
  }
}

export function previewFrameCommandSnapshot(
  graph: SupportedExportCompositionGraph,
  timestampMs: number,
  inputs: SceneEvaluationInputs = {},
): string {
  return canonicalFrameCommandSnapshot(graph, timestampMs, inputs);
}
