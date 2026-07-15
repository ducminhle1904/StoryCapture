import type { ExportCompositionGraphV4 } from "@storycapture/shared-types";

import {
  type CanonicalRenderedFrame,
  CanonicalVisualEngine,
  type CanonicalVisualEngineOptions,
  type CanonicalVisualEnginePort,
  canonicalFrameCommandSnapshot,
} from "../export-compositor/canonical-visual-engine";
import type { SceneEvaluationInputs } from "../export-compositor/scene-evaluator";

/** Preview-side adapter over the exact visual engine used by hidden export. */
export class CanonicalPreviewAdapter {
  private graph: ExportCompositionGraphV4 | null = null;
  private readonly engine: CanonicalVisualEnginePort;

  constructor(
    canvas: HTMLCanvasElement,
    options: CanonicalVisualEngineOptions = {},
    engine?: CanonicalVisualEnginePort,
  ) {
    this.engine = engine ?? new CanonicalVisualEngine(canvas, options);
  }

  async configure(graph: ExportCompositionGraphV4): Promise<void> {
    await this.engine.configure(graph);
    this.graph = graph;
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
    this.engine.dispose();
  }
}

export function previewFrameCommandSnapshot(
  graph: ExportCompositionGraphV4,
  timestampMs: number,
  inputs: SceneEvaluationInputs = {},
): string {
  return canonicalFrameCommandSnapshot(graph, timestampMs, inputs);
}
