import type { ExportCompositionGraphV4 } from "@storycapture/shared-types";

import {
  type CanonicalRenderedFrame,
  CanonicalVisualEngine,
  type CanonicalVisualEngineOptions,
  type CanonicalVisualEnginePort,
  canonicalFrameCommandSnapshot,
} from "./canonical-visual-engine";
import type { SceneEvaluationInputs } from "./scene-evaluator";

export interface CanonicalExportCompositorPayload {
  graph: ExportCompositionGraphV4;
  outputWidth?: number;
  outputHeight?: number;
  fps?: number;
  durationMs?: number;
}

/** Production hidden-compositor adapter backed by the shared canonical engine. */
export class CanonicalExportCompositorAdapter {
  private graph: ExportCompositionGraphV4 | null = null;
  private readonly engine: CanonicalVisualEnginePort;

  constructor(
    canvas: HTMLCanvasElement,
    options: CanonicalVisualEngineOptions = {},
    engine?: CanonicalVisualEnginePort,
  ) {
    this.engine = engine ?? new CanonicalVisualEngine(canvas, options);
  }

  async configure(payload: CanonicalExportCompositorPayload): Promise<{ ok: true }> {
    const { graph } = payload;
    if (payload.outputWidth != null && payload.outputWidth !== graph.output_width) {
      throw new Error("canonical export width must match graph.output_width");
    }
    if (payload.outputHeight != null && payload.outputHeight !== graph.output_height) {
      throw new Error("canonical export height must match graph.output_height");
    }
    if (payload.fps != null && payload.fps !== graph.output_fps) {
      throw new Error("canonical export fps must match graph.output_fps");
    }
    if (payload.durationMs != null && payload.durationMs !== graph.duration_ms) {
      throw new Error("canonical export duration must match graph.duration_ms");
    }
    await this.engine.configure(graph);
    this.graph = graph;
    return { ok: true };
  }

  async renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame> {
    return this.engine.renderFrame(timestampMs);
  }

  frameCommandSnapshot(timestampMs: number): string {
    if (!this.graph) throw new Error("canonical export adapter is not configured");
    return canonicalFrameCommandSnapshot(this.graph, timestampMs);
  }

  readFrameBytes(): Uint8ClampedArray {
    return this.engine.readFrameBytes();
  }

  async dispose(): Promise<{ ok: true }> {
    this.graph = null;
    this.engine.dispose();
    return { ok: true };
  }
}

export function exportFrameCommandSnapshot(
  graph: ExportCompositionGraphV4,
  timestampMs: number,
  inputs: SceneEvaluationInputs = {},
): string {
  return canonicalFrameCommandSnapshot(graph, timestampMs, inputs);
}
