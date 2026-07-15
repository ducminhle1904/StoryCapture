import type {
  ExportCompositionGraphV4,
  ExportRect,
  ExportVideoNode,
} from "@storycapture/shared-types";
import type { RecordingActions } from "@/ipc/action-sidecar";
import type { RecordingTrajectory } from "@/ipc/trajectory";

import {
  samplePreparedVirtualCursor,
  sampleTrajectoryCursor,
  type VirtualCursorSample,
} from "../preview/virtual-cursor-path";
import { textFontCss } from "../state/text-style";
import {
  buildVirtualCursorSchedule,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";
import { CanonicalImageAssetPool } from "./canonical-assets";
import {
  CanonicalCanvasSceneRenderer,
  type CanonicalDrawCommand,
  type CanonicalRenderAssets,
  canonicalCommandSnapshot,
} from "./canvas-scene-renderer";
import { parseExportCursorSidecar } from "./cursor-sidecar";
import { CanonicalMediaSourcePool, canonicalAssetUrl } from "./media-source-pool";
import {
  type EvaluatedScene,
  type ExportCursorNode,
  evaluateScene,
  nodesOf,
  type SceneEvaluationInputs,
} from "./scene-evaluator";

type CursorNode = Extract<ExportVideoNode, { type: "cursor-overlay" }>;

interface CursorRuntime {
  node: CursorNode;
  schedule: VirtualCursorSchedule | null;
  trajectory: RecordingTrajectory | null;
}

export type CanonicalCursorSidecarLoader = (path: string) => Promise<unknown>;

export const loadCanonicalCursorSidecar: CanonicalCursorSidecarLoader = async (path) => {
  const response = await fetch(canonicalAssetUrl(path));
  if (!response.ok) throw new Error(`failed to load canonical cursor sidecar: ${path}`);
  return response.json();
};

export function canonicalTargetBoundsFromActions(
  actions: RecordingActions,
): Map<string, ExportRect> {
  const boundsByStepId = new Map<string, ExportRect>();
  const capture = actions.capture_rect;
  const width = Math.max(1, capture.width);
  const height = Math.max(1, capture.height);
  for (const event of actions.events) {
    if (!event.step_id || !event.target?.bounds || boundsByStepId.has(event.step_id)) continue;
    boundsByStepId.set(event.step_id, {
      x: (event.target.bounds.x - capture.x) / width,
      y: (event.target.bounds.y - capture.y) / height,
      w: event.target.bounds.w / width,
      h: event.target.bounds.h / height,
    });
  }
  return boundsByStepId;
}

export interface CanonicalVisualEngineOptions {
  context?: CanvasRenderingContext2D;
  mediaPool?: CanonicalMediaSourcePool;
  imagePool?: CanonicalImageAssetPool;
  cursorSidecarLoader?: CanonicalCursorSidecarLoader;
  renderer?: CanonicalCanvasSceneRenderer;
  fontSet?: Pick<FontFaceSet, "load"> | null;
}

export interface CanonicalRenderedFrame {
  scene: EvaluatedScene;
  commands: CanonicalDrawCommand[];
}

export interface CanonicalVisualEnginePort {
  configure(graph: ExportCompositionGraphV4): Promise<void>;
  renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame>;
  readFrameBytes(): Uint8ClampedArray;
  dispose(): void;
}

function cursorTimelineMs(node: ExportCursorNode, timeMs: number): number {
  const relativeMs = Math.max(0, timeMs - node.t_start_ms);
  if (node.preserve_full_motion || !node.source_time_map) return relativeMs;
  const segment = node.source_time_map.segments.find(
    (candidate) => relativeMs >= candidate.timelineStartMs && relativeMs <= candidate.timelineEndMs,
  );
  if (!segment) return relativeMs;
  if (segment.kind === "hold") return segment.sourcePtsUs / 1_000;
  const timelineSpan = segment.timelineEndMs - segment.timelineStartMs;
  if (timelineSpan <= 0) return segment.sourceStartUs / 1_000;
  const progress = (relativeMs - segment.timelineStartMs) / timelineSpan;
  return (segment.sourceStartUs + progress * (segment.sourceEndUs - segment.sourceStartUs)) / 1_000;
}

async function loadCanonicalTextFonts(
  graph: ExportCompositionGraphV4,
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
  graph: ExportCompositionGraphV4,
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
  private graph: ExportCompositionGraphV4 | null = null;
  private cursorRuntimes: CursorRuntime[] = [];
  private targetBoundsByStepId = new Map<string, ExportRect>();
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

  async configure(graph: ExportCompositionGraphV4): Promise<void> {
    if (graph.schema_version !== 4) {
      throw new Error(
        `canonical visual engine requires graph v4, received ${graph.schema_version}`,
      );
    }
    if (graph.output_width <= 0 || graph.output_height <= 0 || graph.output_fps <= 0) {
      throw new Error("canonical visual engine requires positive output dimensions and fps");
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.graph = null;
    this.cursorRuntimes = [];
    this.targetBoundsByStepId.clear();
    this.canvas.width = Math.round(graph.output_width);
    this.canvas.height = Math.round(graph.output_height);

    try {
      await this.mediaPool.configure(graph);
      await this.imagePool.configure(graph);
      const cursorRuntimes: CursorRuntime[] = [];
      const targetBoundsByStepId = new Map<string, ExportRect>();
      for (const node of nodesOf(graph, "cursor-overlay").sort(
        (a, b) => a.t_start_ms - b.t_start_ms || a.clip_id.localeCompare(b.clip_id),
      )) {
        if (node.trajectory.kind === "png-sequence") {
          cursorRuntimes.push({ node, schedule: null, trajectory: null });
          continue;
        }
        if (!node.trajectory.path) {
          throw new Error(`canonical cursor sidecar path is missing: ${node.id}`);
        }
        const parsed = parseExportCursorSidecar(
          await this.cursorSidecarLoader(node.trajectory.path),
        );
        if (node.trajectory.kind === "actions" && parsed.kind !== "actions") {
          throw new Error(`canonical cursor actions sidecar is invalid: ${node.trajectory.path}`);
        }
        if (node.trajectory.kind === "trajectory" && parsed.kind !== "trajectory") {
          throw new Error(
            `canonical cursor trajectory sidecar is invalid: ${node.trajectory.path}`,
          );
        }
        if (parsed.kind === "actions") {
          for (const [stepId, bounds] of canonicalTargetBoundsFromActions(parsed.sidecar)) {
            if (!targetBoundsByStepId.has(stepId)) targetBoundsByStepId.set(stepId, bounds);
          }
        }
        cursorRuntimes.push({
          node,
          schedule:
            parsed.kind === "actions"
              ? buildVirtualCursorSchedule(parsed.sidecar, node.motion_preset, {
                  preserveFullMotion: node.preserve_full_motion,
                })
              : null,
          trajectory: parsed.kind === "trajectory" ? parsed.sidecar : null,
        });
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

  async renderFrame(timestampMs: number): Promise<CanonicalRenderedFrame> {
    const graph = this.graph;
    if (!graph) throw new Error("canonical visual engine is not configured");
    const generation = this.generation;
    const timeMs = Math.max(0, Math.min(graph.duration_ms, timestampMs));
    const cursorSamples = new Map<string, VirtualCursorSample | null>();
    for (const runtime of this.cursorRuntimes) {
      const cursorMs = cursorTimelineMs(runtime.node, timeMs);
      const sample = runtime.schedule
        ? samplePreparedVirtualCursor(runtime.schedule, cursorMs, runtime.node.click_effect)
        : runtime.trajectory
          ? sampleTrajectoryCursor(runtime.trajectory, cursorMs)
          : null;
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
    return { scene, commands: this.renderer.render(scene, assets) };
  }

  readFrameBytes(): Uint8ClampedArray {
    return new Uint8ClampedArray(
      this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data,
    );
  }

  dispose(): void {
    this.generation += 1;
    this.graph = null;
    this.cursorRuntimes = [];
    this.targetBoundsByStepId.clear();
    this.mediaPool.dispose();
    this.imagePool.dispose();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
