import type {
  ExportRect,
  ExportVideoNode,
  SupportedExportCompositionGraph,
} from "@storycapture/shared-types";
import {
  readRecordingV4ActionSidecar,
  readRecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import type { VirtualCursorSample } from "../preview/virtual-cursor-path";
import { textFontCss } from "../state/text-style";
import { CanonicalImageAssetPool } from "./canonical-assets";
import {
  CanonicalCanvasSceneRenderer,
  type CanonicalDrawCommand,
  type CanonicalPresentationLayout,
  type CanonicalRenderAssets,
  canonicalCommandSnapshot,
  type ExportResamplingQuality,
} from "./canvas-scene-renderer";
import type { CanonicalSourceMode } from "./media-source-pool";
import { CanonicalMediaSourcePool, canonicalAssetUrl } from "./media-source-pool";
import {
  type PreparedRecordingV4Cursor,
  prepareRecordingV4Cursor,
  recordingV4TargetBounds,
  sampleRecordingV4Cursor,
} from "./recording-v4-cursor";
import {
  type EvaluatedScene,
  type ExportCursorNode,
  evaluateScene,
  nodesOf,
  resolveSceneContentRect,
  type SceneEvaluationInputs,
} from "./scene-evaluator";

type CursorNode = Extract<ExportVideoNode, { type: "cursor-overlay" }>;

interface CursorRuntime {
  node: CursorNode;
  recordingV4: PreparedRecordingV4Cursor;
}

export type CanonicalCursorSidecarLoader = (path: string) => Promise<unknown>;

export const loadCanonicalCursorSidecar: CanonicalCursorSidecarLoader = async (path) => {
  const response = await fetch(canonicalAssetUrl(path));
  if (!response.ok) throw new Error(`failed to load canonical cursor sidecar: ${path}`);
  return response.json();
};

export interface CanonicalVisualEngineOptions {
  context?: CanvasRenderingContext2D;
  mediaPool?: CanonicalMediaSourcePool;
  imagePool?: CanonicalImageAssetPool;
  cursorSidecarLoader?: CanonicalCursorSidecarLoader;
  renderer?: CanonicalCanvasSceneRenderer;
  fontSet?: Pick<FontFaceSet, "load"> | null;
}

export interface CanonicalVisualEngineRuntimeConfig {
  resamplingQuality?: ExportResamplingQuality;
  sourceMode?: CanonicalSourceMode;
}

export interface CanonicalRenderedFrame {
  scene: EvaluatedScene;
  commands: CanonicalDrawCommand[];
}

export interface CanonicalVisualEnginePort {
  configure(
    graph: SupportedExportCompositionGraph,
    runtimeConfig?: CanonicalVisualEngineRuntimeConfig,
  ): Promise<void>;
  setPresentationLayout(layout: CanonicalPresentationLayout | null): void;
  renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame>;
  readFrameBytes(): Uint8ClampedArray;
  dispose(): void;
}

export function cursorActiveMediaTimeUs(node: ExportCursorNode, timeMs: number): number {
  const relativeMs = Math.max(0, timeMs - node.t_start_ms);
  if (node.preserve_full_motion || !node.source_time_map) return relativeMs * 1_000;
  const segment = node.source_time_map.segments.find(
    (candidate) => relativeMs >= candidate.timelineStartMs && relativeMs <= candidate.timelineEndMs,
  );
  if (!segment) return relativeMs * 1_000;
  if (segment.kind === "hold") return segment.sourcePtsUs;
  const timelineSpan = segment.timelineEndMs - segment.timelineStartMs;
  if (timelineSpan <= 0) return segment.sourceStartUs;
  const progress = (relativeMs - segment.timelineStartMs) / timelineSpan;
  return segment.sourceStartUs + progress * (segment.sourceEndUs - segment.sourceStartUs);
}

async function loadCanonicalTextFonts(
  graph: SupportedExportCompositionGraph,
  fontSet: Pick<FontFaceSet, "load"> | null,
): Promise<void> {
  if (!fontSet) return;
  const requests = new Map<string, string>();
  for (const node of nodesOf(graph, "text-overlay")) {
    for (const box of node.boxes) {
      const font = textFontCss(box.font);
      const descriptor = `${font.fontStyle} ${font.fontWeight} ${Math.max(12, Math.min(72, box.size_pt))}px ${font.fontFamily}`;
      requests.set(descriptor, box.text.slice(0, 128) || "M");
    }
  }
  for (const [descriptor, sample] of requests) {
    await fontSet.load(descriptor, sample);
  }
}

export function canonicalFrameCommandSnapshot(
  graph: SupportedExportCompositionGraph,
  timestampMs: number,
  inputs: SceneEvaluationInputs = {},
): string {
  return canonicalCommandSnapshot(evaluateScene(graph, timestampMs, inputs));
}

export class CanonicalVisualEngine implements CanonicalVisualEnginePort {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mediaPool: CanonicalMediaSourcePool;
  private readonly imagePool: CanonicalImageAssetPool;
  private readonly cursorSidecarLoader: CanonicalCursorSidecarLoader;
  private readonly renderer: CanonicalCanvasSceneRenderer;
  private readonly fontSet: Pick<FontFaceSet, "load"> | null;
  private graph: SupportedExportCompositionGraph | null = null;
  private cursorRuntimes: CursorRuntime[] = [];
  private targetBoundsByStepId = new Map<string, ExportRect>();
  private presentationLayout: CanonicalPresentationLayout | null = null;
  private generation = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: CanonicalVisualEngineOptions = {},
  ) {
    const ctx = options.context ?? canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("canonical Canvas 2D context is unavailable");
    this.ctx = ctx;
    this.mediaPool = options.mediaPool ?? new CanonicalMediaSourcePool();
    this.imagePool = options.imagePool ?? new CanonicalImageAssetPool();
    this.cursorSidecarLoader = options.cursorSidecarLoader ?? loadCanonicalCursorSidecar;
    this.renderer = options.renderer ?? new CanonicalCanvasSceneRenderer(ctx);
    this.fontSet =
      options.fontSet === undefined
        ? typeof document !== "undefined" && typeof document.fonts?.load === "function"
          ? document.fonts
          : null
        : options.fontSet;
  }

  async configure(
    graph: SupportedExportCompositionGraph,
    runtimeConfig: CanonicalVisualEngineRuntimeConfig = {},
  ): Promise<void> {
    resolveSceneContentRect(graph);
    if (graph.output_width <= 0 || graph.output_height <= 0 || graph.output_fps <= 0) {
      throw new Error("canonical visual engine requires positive output dimensions and fps");
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.graph = null;
    this.presentationLayout = null;
    this.cursorRuntimes = [];
    this.targetBoundsByStepId.clear();
    this.canvas.width = Math.round(graph.output_width);
    this.canvas.height = Math.round(graph.output_height);
    this.renderer.setResamplingQuality(runtimeConfig.resamplingQuality ?? "high");

    try {
      await this.mediaPool.configure(graph, runtimeConfig.sourceMode ?? "preview");
      await this.imagePool.configure(graph);
      const cursorRuntimes: CursorRuntime[] = [];
      const targetBoundsByStepId = new Map<string, ExportRect>();
      for (const node of nodesOf(graph, "cursor-overlay").sort(
        (a, b) => a.t_start_ms - b.t_start_ms || a.clip_id.localeCompare(b.clip_id),
      )) {
        if (!node.trajectory.path) {
          throw new Error(`canonical cursor sidecar path is missing: ${node.id}`);
        }
        if (node.trajectory.kind !== "recording-v4" || !node.trajectory.actions_path) {
          throw new Error(`canonical cursor node is not Recording V4: ${node.id}`);
        }
        const [cursorValue, actionsValue] = await Promise.all([
          this.cursorSidecarLoader(node.trajectory.path),
          this.cursorSidecarLoader(node.trajectory.actions_path),
        ]);
        const cursor = readRecordingV4CursorSidecar(cursorValue);
        const actions = readRecordingV4ActionSidecar(actionsValue);
        if (!cursor) {
          throw new Error(
            `canonical Recording V4 cursor sidecar is invalid: ${node.trajectory.path}`,
          );
        }
        if (!actions) {
          throw new Error(
            `canonical Recording V4 actions sidecar is invalid: ${node.trajectory.actions_path}`,
          );
        }
        for (const [stepId, bounds] of recordingV4TargetBounds(actions)) {
          if (!targetBoundsByStepId.has(stepId)) targetBoundsByStepId.set(stepId, bounds);
        }
        cursorRuntimes.push({ node, recordingV4: prepareRecordingV4Cursor(actions, cursor) });
      }
      await loadCanonicalTextFonts(graph, this.fontSet);
      if (generation !== this.generation) {
        throw new Error("canonical visual engine configuration was superseded");
      }
      this.cursorRuntimes = cursorRuntimes;
      this.targetBoundsByStepId = targetBoundsByStepId;
      this.graph = graph;
    } catch (error) {
      this.mediaPool.dispose();
      this.imagePool.dispose();
      throw error;
    }
  }

  setPresentationLayout(layout: CanonicalPresentationLayout | null): void {
    const graph = this.graph;
    this.presentationLayout = layout;
    const width = Math.max(1, Math.round(layout?.surfaceRect.w ?? graph?.output_width ?? 1));
    const height = Math.max(1, Math.round(layout?.surfaceRect.h ?? graph?.output_height ?? 1));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  async renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame> {
    const graph = this.graph;
    if (!graph) throw new Error("canonical visual engine is not configured");
    const generation = this.generation;
    const timeMs = Math.max(0, Math.min(graph.duration_ms, timestampMs));
    const cursorSamples = new Map<string, VirtualCursorSample | null>();
    for (const runtime of this.cursorRuntimes) {
      const activeMediaTimeUs = cursorActiveMediaTimeUs(runtime.node, timeMs);
      const sample = sampleRecordingV4Cursor(
        runtime.recordingV4,
        activeMediaTimeUs,
        runtime.node.click_effect,
      );
      cursorSamples.set(runtime.node.id, sample);
    }
    const scene = evaluateScene(graph, timeMs, {
      cursor_samples: cursorSamples,
      target_bounds_by_step_id: this.targetBoundsByStepId,
    });
    await this.mediaPool.prepare(scene);
    await this.imagePool.prepare(scene);
    if (generation !== this.generation || graph !== this.graph) {
      throw new Error("canonical visual engine render was superseded");
    }
    const assets: CanonicalRenderAssets = {
      source: (sourceId) => this.mediaPool.source(sourceId),
      image: (path) => this.imagePool.image(path),
      cursorSkin: (skin) => this.imagePool.cursorSkin(skin),
      cursorPngFrame: (nodeId, frameIndex) => this.imagePool.cursorPngFrame(nodeId, frameIndex),
    };
    return {
      scene,
      commands: this.renderer.render(scene, assets, this.presentationLayout ?? undefined),
    };
  }

  readFrameBytes(): Uint8ClampedArray {
    return new Uint8ClampedArray(
      this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data,
    );
  }

  dispose(): void {
    this.generation += 1;
    this.graph = null;
    this.presentationLayout = null;
    this.cursorRuntimes = [];
    this.targetBoundsByStepId.clear();
    this.mediaPool.dispose();
    this.imagePool.dispose();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
