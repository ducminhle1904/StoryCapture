import type {
  ExportBackgroundNodeV4,
  ExportBackgroundNodeV5,
  ExportCursorClickEffect,
  ExportHighlightOverlaySpec,
  ExportRect,
  ExportRgba,
  ExportSourceTimelineMap,
  ExportTextBox,
  ExportTransitionKind,
  ExportVec2,
  ExportVideoNodeV4,
  ExportVideoNodeV5,
  ExportZoomKeyframe,
  SupportedExportCompositionGraph,
} from "@storycapture/shared-types";
import {
  EXPORT_FOREGROUND_SCALE_MAX,
  EXPORT_FOREGROUND_SCALE_MIN,
  isValidExportForegroundScale,
} from "@storycapture/shared-types";

import type { VirtualCursorSample } from "../preview/virtual-cursor-path";

type SupportedExportVideoNode = ExportVideoNodeV4 | ExportVideoNodeV5;

export type ExportSourceNode = Extract<SupportedExportVideoNode, { type: "source" }>;
export type ExportBackgroundNode = Extract<SupportedExportVideoNode, { type: "background" }>;
export type ExportCursorNode = Extract<SupportedExportVideoNode, { type: "cursor-overlay" }>;
export type ExportTransitionNode = Extract<SupportedExportVideoNode, { type: "transition" }>;

export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EvaluatedZoom {
  center: ExportVec2;
  scale: number;
}

export interface EvaluatedSource {
  node: ExportSourceNode;
  effective_start_ms: number;
  local_timeline_ms: number;
  source_pts_us: number;
  held: boolean;
}

export interface EvaluatedTransition {
  node: ExportTransitionNode;
  kind: ExportTransitionKind;
  progress: number;
  from: EvaluatedSource;
  to: EvaluatedSource;
}

export interface EvaluatedHighlight {
  node_id: string;
  spec: ExportHighlightOverlaySpec;
  alpha: number;
  center: ExportVec2;
  bounds: SceneRect | null;
  radius_px: number;
  padding_px: number;
  stroke_px: number;
  glow_px: number;
}

export interface EvaluatedRipple {
  node_id: string;
  clip_id: string;
  center: ExportVec2;
  bounds: SceneRect | null;
  radius_px: number;
  alpha: number;
  color: ExportRgba;
}

export interface EvaluatedCursor {
  node: ExportCursorNode;
  sample: VirtualCursorSample | null;
  output_point: ExportVec2 | null;
  png_frame_index: number | null;
}

export interface EvaluatedText {
  box: ExportTextBox;
  pos: ExportVec2;
  alpha: number;
  translate_y_px: number;
  scale: number;
}

export interface EvaluatedScene {
  graph: SupportedExportCompositionGraph;
  time_ms: number;
  output_width: number;
  output_height: number;
  background: ExportBackgroundNode | null;
  content_rect: SceneRect;
  zoom: EvaluatedZoom;
  sources: EvaluatedSource[];
  transition: EvaluatedTransition | null;
  highlights: EvaluatedHighlight[];
  ripples: EvaluatedRipple[];
  cursors: EvaluatedCursor[];
  text: EvaluatedText[];
}

export interface SceneEvaluationInputs {
  cursor_samples?: ReadonlyMap<string, VirtualCursorSample | null>;
  target_bounds_by_step_id?: ReadonlyMap<string, ExportRect>;
}

const SAFE_AREA_Y = {
  top: 0.14,
  bottom: 0.86,
  center: 0.5,
} as const;
const TARGET_MARGIN = 0.06;

export const CANONICAL_VISUAL_NODE_TYPES = [
  "source",
  "zoom-pan",
  "background",
  "cursor-overlay",
  "ripple-overlay",
  "highlight-overlay",
  "text-overlay",
  "transition",
] as const satisfies readonly SupportedExportVideoNode["type"][];

type MissingCanonicalVisualNode = Exclude<
  SupportedExportVideoNode["type"],
  (typeof CANONICAL_VISUAL_NODE_TYPES)[number]
>;
const CANONICAL_VISUAL_NODE_TYPES_ARE_EXHAUSTIVE: [MissingCanonicalVisualNode] extends [never]
  ? true
  : never = true;
void CANONICAL_VISUAL_NODE_TYPES_ARE_EXHAUSTIVE;

function assertNever(value: never): never {
  throw new Error(`Unhandled canonical scene value: ${JSON.stringify(value)}`);
}

function assertCanonicalVisualCoverage(graph: SupportedExportCompositionGraph): void {
  for (const node of graph.video) {
    switch (node.type) {
      case "source":
      case "zoom-pan":
      case "background":
      case "cursor-overlay":
      case "ripple-overlay":
      case "highlight-overlay":
      case "text-overlay":
      case "transition":
        break;
      default:
        assertNever(node);
    }
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function nodesOf<T extends SupportedExportVideoNode["type"]>(
  graph: SupportedExportCompositionGraph,
  type: T,
): Array<Extract<SupportedExportVideoNode, { type: T }>> {
  return graph.video.filter(
    (node): node is Extract<SupportedExportVideoNode, { type: T }> => node.type === type,
  );
}

/** Resolve versioned background geometry without approximating legacy V4 padding. */
export function resolveSceneContentRect(graph: SupportedExportCompositionGraph): SceneRect {
  const schemaVersion = (graph as { schema_version?: unknown }).schema_version;
  if (schemaVersion === 4) {
    const background = graph.video.find(
      (node): node is ExportBackgroundNodeV4 => node.type === "background",
    );
    const padding = background ? Math.max(0, finiteOr(background.padding_px, 0)) : 0;
    return {
      x: padding,
      y: padding,
      w: Math.max(1, graph.output_width - padding * 2),
      h: Math.max(1, graph.output_height - padding * 2),
    };
  }
  if (schemaVersion !== 5) {
    throw new Error(`unsupported canonical composition graph schema: ${String(schemaVersion)}`);
  }

  const background = graph.video.find(
    (node): node is ExportBackgroundNodeV5 => node.type === "background",
  );
  const scale = background ? background.foreground_scale : 1;
  if (!isValidExportForegroundScale(scale)) {
    throw new Error(
      `canonical graph schema v5 background foreground_scale must be a finite number between ${EXPORT_FOREGROUND_SCALE_MIN} and ${EXPORT_FOREGROUND_SCALE_MAX}`,
    );
  }
  return {
    x: (graph.output_width * (1 - scale)) / 2,
    y: (graph.output_height * (1 - scale)) / 2,
    w: graph.output_width * scale,
    h: graph.output_height * scale,
  };
}

function evaluateEasing(kind: ExportZoomKeyframe["easing"], value: number): number {
  const t = clamp01(value);
  switch (kind) {
    case "linear":
      return t;
    case "ease-in":
      return t * t;
    case "ease-out":
    case "ease-out-quad":
      return 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      return t * t * (3 - 2 * t);
    case "ease-in-cubic":
      return t * t * t;
    case "ease-out-cubic":
      return 1 - (1 - t) ** 3;
    case "ease-in-out-cubic":
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    default:
      return assertNever(kind);
  }
}

function interpolateZoomKeyframes(
  frames: readonly ExportZoomKeyframe[],
  timeMs: number,
): EvaluatedZoom | null {
  const keyframes = frames
    .filter(
      (frame) =>
        Number.isFinite(frame.t_ms) &&
        Number.isFinite(frame.center.x) &&
        Number.isFinite(frame.center.y) &&
        Number.isFinite(frame.scale),
    )
    .slice()
    .sort((a, b) => a.t_ms - b.t_ms);
  const first = keyframes[0];
  const last = keyframes.at(-1);
  if (!first || !last) return null;
  if (timeMs <= first.t_ms) {
    return { center: { ...first.center }, scale: Math.max(1, first.scale) };
  }
  if (timeMs >= last.t_ms) {
    return { center: { ...last.center }, scale: Math.max(1, last.scale) };
  }
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const left = keyframes[index];
    const right = keyframes[index + 1];
    if (!left || !right || timeMs < left.t_ms || timeMs > right.t_ms) continue;
    const progress = evaluateEasing(
      left.easing,
      (timeMs - left.t_ms) / Math.max(1, right.t_ms - left.t_ms),
    );
    return {
      center: {
        x: left.center.x + (right.center.x - left.center.x) * progress,
        y: left.center.y + (right.center.y - left.center.y) * progress,
      },
      scale: Math.max(1, left.scale + (right.scale - left.scale) * progress),
    };
  }
  return null;
}

export function evaluateSceneZoom(
  graph: SupportedExportCompositionGraph,
  timeMs: number,
): EvaluatedZoom {
  const selected = nodesOf(graph, "zoom-pan")
    .filter(
      (node) =>
        timeMs >= node.t_start_ms && timeMs <= node.t_start_ms + Math.max(0, node.duration_ms),
    )
    .sort((a, b) => b.t_start_ms - a.t_start_ms || a.id.localeCompare(b.id))[0];
  return (
    (selected ? interpolateZoomKeyframes(selected.keyframes, timeMs) : null) ?? {
      center: { x: graph.output_width / 2, y: graph.output_height / 2 },
      scale: 1,
    }
  );
}

function sourcePtsAt(map: ExportSourceTimelineMap | undefined, timelineMs: number): number | null {
  if (!map) return Math.round(Math.max(0, timelineMs) * 1_000);
  const segment = map.segments.find(
    (candidate) => timelineMs >= candidate.timelineStartMs && timelineMs <= candidate.timelineEndMs,
  );
  if (!segment) return null;
  if (segment.kind === "hold") return segment.sourcePtsUs;
  const spanMs = segment.timelineEndMs - segment.timelineStartMs;
  if (spanMs <= 0) return segment.sourceStartUs;
  const progress = (timelineMs - segment.timelineStartMs) / spanMs;
  return Math.round(
    segment.sourceStartUs + progress * (segment.sourceEndUs - segment.sourceStartUs),
  );
}

function terminalSourcePts(map: ExportSourceTimelineMap | undefined, fallbackMs: number): number {
  if (!map || map.segments.length === 0) return Math.round(Math.max(0, fallbackMs) * 1_000);
  const terminal = map.segments
    .slice()
    .sort((a, b) => a.timelineEndMs - b.timelineEndMs)
    .at(-1);
  if (!terminal) return Math.round(Math.max(0, fallbackMs) * 1_000);
  return terminal.kind === "hold" ? terminal.sourcePtsUs : terminal.sourceEndUs;
}

function nearestSourcePts(
  map: ExportSourceTimelineMap | undefined,
  timelineMs: number,
  fallbackMs: number,
): number {
  if (!map || map.segments.length === 0) return Math.round(Math.max(0, fallbackMs) * 1_000);
  const ordered = map.segments
    .slice()
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs || a.timelineEndMs - b.timelineEndMs);
  const previous = ordered.filter((segment) => segment.timelineEndMs <= timelineMs).at(-1);
  if (previous) return previous.kind === "hold" ? previous.sourcePtsUs : previous.sourceEndUs;
  const next = ordered.find((segment) => segment.timelineStartMs > timelineMs);
  if (next) return next.kind === "hold" ? next.sourcePtsUs : next.sourceStartUs;
  return terminalSourcePts(map, fallbackMs);
}

function sortedSources(graph: SupportedExportCompositionGraph): ExportSourceNode[] {
  return nodesOf(graph, "source").sort(
    (a, b) => a.timeline_start_ms - b.timeline_start_ms || a.clip_id.localeCompare(b.clip_id),
  );
}

function effectiveSourceStarts(graph: SupportedExportCompositionGraph): Map<string, number> {
  const starts = new Map<string, number>();
  for (const source of sortedSources(graph)) {
    starts.set(source.id, Math.max(0, finiteOr(source.timeline_start_ms, source.pts_offset_ms)));
  }
  for (const transition of nodesOf(graph, "transition").sort(
    (a, b) => a.offset_ms - b.offset_ms || a.id.localeCompare(b.id),
  )) {
    const current = starts.get(transition.to_source_id);
    if (current === undefined || transition.offset_ms < current) {
      starts.set(transition.to_source_id, Math.max(0, transition.offset_ms));
    }
  }
  return starts;
}

function evaluateSourceAt(
  node: ExportSourceNode,
  effectiveStartMs: number,
  timeMs: number,
  forceHold = false,
): EvaluatedSource {
  const durationMs = Math.max(0, finiteOr(node.duration_ms, 0));
  const unclampedLocalMs = timeMs - effectiveStartMs;
  const localTimelineMs = Math.max(0, Math.min(durationMs, unclampedLocalMs));
  const held = forceHold || unclampedLocalMs < 0 || unclampedLocalMs >= durationMs;
  const mapped = sourcePtsAt(node.source_time_map, localTimelineMs);
  return {
    node,
    effective_start_ms: effectiveStartMs,
    local_timeline_ms: localTimelineMs,
    source_pts_us:
      mapped ?? nearestSourcePts(node.source_time_map, localTimelineMs, localTimelineMs),
    held,
  };
}

function evaluateSources(
  graph: SupportedExportCompositionGraph,
  timeMs: number,
): { sources: EvaluatedSource[]; transition: EvaluatedTransition | null } {
  const sourceById = new Map(sortedSources(graph).map((source) => [source.id, source]));
  const starts = effectiveSourceStarts(graph);
  const activeTransition = nodesOf(graph, "transition")
    .filter(
      (node) =>
        node.duration_ms > 0 &&
        timeMs >= node.offset_ms &&
        timeMs <= node.offset_ms + node.duration_ms,
    )
    .sort((a, b) => b.offset_ms - a.offset_ms || a.id.localeCompare(b.id))[0];

  if (activeTransition) {
    const fromNode = sourceById.get(activeTransition.from_source_id);
    const toNode = sourceById.get(activeTransition.to_source_id);
    if (fromNode && toNode) {
      const from = evaluateSourceAt(fromNode, starts.get(fromNode.id) ?? 0, timeMs);
      const to = evaluateSourceAt(toNode, activeTransition.offset_ms, timeMs);
      return {
        sources: [from, to],
        transition: {
          node: activeTransition,
          kind: activeTransition.kind,
          progress: clamp01(
            (timeMs - activeTransition.offset_ms) / Math.max(1, activeTransition.duration_ms),
          ),
          from,
          to,
        },
      };
    }
  }

  const ordered = sortedSources(graph).map((node) => ({
    node,
    start: starts.get(node.id) ?? Math.max(0, node.timeline_start_ms),
  }));
  const active = ordered
    .filter(({ node, start }) => timeMs >= start && timeMs < start + Math.max(0, node.duration_ms))
    .sort((a, b) => b.start - a.start || a.node.clip_id.localeCompare(b.node.clip_id))[0];
  if (active) {
    return { sources: [evaluateSourceAt(active.node, active.start, timeMs)], transition: null };
  }

  // A gap, or the tail after the final source, deterministically holds the most
  // recent frame. This prevents browser-dependent black frames while seeking.
  const previous = ordered
    .filter(({ start }) => start <= timeMs)
    .sort((a, b) => b.start - a.start || a.node.clip_id.localeCompare(b.node.clip_id))[0];
  if (previous) {
    return {
      sources: [evaluateSourceAt(previous.node, previous.start, timeMs, true)],
      transition: null,
    };
  }
  return { sources: [], transition: null };
}

export function applyZoomToNormalizedPoint(
  point: ExportVec2,
  zoom: EvaluatedZoom,
  outputWidth: number,
  outputHeight: number,
): ExportVec2 {
  const scale = Math.max(1, zoom.scale);
  if (scale <= 1) return { x: clamp01(point.x), y: clamp01(point.y) };
  const cropX = zoom.center.x / Math.max(1, outputWidth) - 1 / (2 * scale);
  const cropY = zoom.center.y / Math.max(1, outputHeight) - 1 / (2 * scale);
  return {
    x: clamp01((point.x - cropX) * scale),
    y: clamp01((point.y - cropY) * scale),
  };
}

function normalizedPoint(point: ExportVec2, width: number, height: number): ExportVec2 {
  if (Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1) return point;
  return { x: point.x / Math.max(1, width), y: point.y / Math.max(1, height) };
}

function normalizedRect(rect: ExportRect, width: number, height: number): ExportRect {
  if (
    Math.abs(rect.x) <= 1 &&
    Math.abs(rect.y) <= 1 &&
    Math.abs(rect.w) <= 1 &&
    Math.abs(rect.h) <= 1
  ) {
    return rect;
  }
  return {
    x: rect.x / Math.max(1, width),
    y: rect.y / Math.max(1, height),
    w: rect.w / Math.max(1, width),
    h: rect.h / Math.max(1, height),
  };
}

function sourcePointToOutput(
  point: ExportVec2,
  zoom: EvaluatedZoom,
  contentRect: SceneRect,
  outputWidth: number,
  outputHeight: number,
): ExportVec2 {
  const transformed = applyZoomToNormalizedPoint(
    normalizedPoint(point, outputWidth, outputHeight),
    zoom,
    outputWidth,
    outputHeight,
  );
  return {
    x: contentRect.x + transformed.x * contentRect.w,
    y: contentRect.y + transformed.y * contentRect.h,
  };
}

function sourceRectToOutput(
  rect: ExportRect,
  zoom: EvaluatedZoom,
  contentRect: SceneRect,
  outputWidth: number,
  outputHeight: number,
): SceneRect {
  const normalized = normalizedRect(rect, outputWidth, outputHeight);
  const topLeft = sourcePointToOutput(
    { x: normalized.x, y: normalized.y },
    zoom,
    contentRect,
    outputWidth,
    outputHeight,
  );
  const bottomRight = sourcePointToOutput(
    { x: normalized.x + normalized.w, y: normalized.y + normalized.h },
    zoom,
    contentRect,
    outputWidth,
    outputHeight,
  );
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    w: Math.abs(bottomRight.x - topLeft.x),
    h: Math.abs(bottomRight.y - topLeft.y),
  };
}

function evaluateHighlights(
  graph: SupportedExportCompositionGraph,
  timeMs: number,
  zoom: EvaluatedZoom,
  contentRect: SceneRect,
): EvaluatedHighlight[] {
  const values: EvaluatedHighlight[] = [];
  for (const node of nodesOf(graph, "highlight-overlay")) {
    for (const spec of node.highlights) {
      const elapsed = timeMs - spec.t_start_ms;
      if (elapsed < 0 || elapsed > spec.duration_ms) continue;
      const fade = Math.min(1, elapsed / 120, (spec.duration_ms - elapsed) / 120);
      values.push({
        node_id: node.id,
        spec,
        alpha: clamp01(spec.opacity * Math.max(0, fade)),
        center: sourcePointToOutput(
          spec.source_center,
          zoom,
          contentRect,
          graph.output_width,
          graph.output_height,
        ),
        bounds: spec.source_bounds
          ? sourceRectToOutput(
              spec.source_bounds,
              zoom,
              contentRect,
              graph.output_width,
              graph.output_height,
            )
          : null,
        radius_px: Math.max(1, spec.max_radius_px * Math.max(1, zoom.scale)),
        padding_px: Math.max(0, spec.padding_px * Math.max(1, zoom.scale)),
        stroke_px: Math.max(0, spec.stroke_px * Math.max(1, zoom.scale)),
        glow_px: Math.max(0, spec.glow_px * Math.max(1, zoom.scale)),
      });
    }
  }
  return values.sort(
    (a, b) => a.spec.t_start_ms - b.spec.t_start_ms || a.spec.clip_id.localeCompare(b.spec.clip_id),
  );
}

function evaluateRipples(
  graph: SupportedExportCompositionGraph,
  timeMs: number,
  zoom: EvaluatedZoom,
  contentRect: SceneRect,
): EvaluatedRipple[] {
  const values: EvaluatedRipple[] = [];
  for (const node of nodesOf(graph, "ripple-overlay")) {
    for (const event of node.events) {
      const elapsed = timeMs - event.t_impact_ms;
      if (elapsed < 0 || elapsed > event.duration_ms) continue;
      const progress = clamp01(elapsed / Math.max(1, event.duration_ms));
      values.push({
        node_id: node.id,
        clip_id: event.clip_id,
        center: sourcePointToOutput(
          event.center,
          zoom,
          contentRect,
          graph.output_width,
          graph.output_height,
        ),
        bounds: event.bounds
          ? sourceRectToOutput(
              event.bounds,
              zoom,
              contentRect,
              graph.output_width,
              graph.output_height,
            )
          : null,
        radius_px: Math.max(0, event.max_radius_px * progress * Math.max(1, zoom.scale)),
        alpha: 1 - progress,
        color: event.color,
      });
    }
  }
  return values.sort((a, b) => a.clip_id.localeCompare(b.clip_id));
}

function textAnimationState(box: ExportTextBox, timeMs: number) {
  const durationMs = Math.max(1, box.anim_duration_ms);
  const ease = (value: number) => evaluateEasing("ease-in-out-cubic", value);
  const inProgress = ease((timeMs - box.t_start_ms) / durationMs);
  const outProgress = ease((box.t_end_ms - timeMs) / durationMs);
  let alpha = 1;
  let translateY = 0;
  let scale = 1;
  switch (box.anim_in) {
    case "none":
      break;
    case "fade":
      alpha *= inProgress;
      break;
    case "slide-up":
      alpha *= inProgress;
      translateY = (1 - inProgress) * 18;
      break;
    case "scale-in":
      alpha *= inProgress;
      scale = 0.92 + inProgress * 0.08;
      break;
    default:
      assertNever(box.anim_in);
  }
  if (box.anim_out === "fade") alpha *= outProgress;
  return { alpha: clamp01(alpha), translateY, scale };
}

function targetPosition(
  bounds: ExportRect,
  placement: Extract<ExportTextBox["anchor"], { kind: "target" }>["placement"],
): ExportVec2 {
  switch (placement) {
    case "top":
      return { x: bounds.x + bounds.w / 2, y: bounds.y - TARGET_MARGIN };
    case "right":
      return { x: bounds.x + bounds.w + TARGET_MARGIN, y: bounds.y + bounds.h / 2 };
    case "bottom":
      return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h + TARGET_MARGIN };
    case "left":
      return { x: bounds.x - TARGET_MARGIN, y: bounds.y + bounds.h / 2 };
    default:
      return assertNever(placement);
  }
}

function resolveTextPosition(
  box: ExportTextBox,
  zoom: EvaluatedZoom,
  graph: SupportedExportCompositionGraph,
  contentRect: SceneRect,
  cursors: readonly EvaluatedCursor[],
  highlights: readonly EvaluatedHighlight[],
  inputs: SceneEvaluationInputs,
): ExportVec2 {
  switch (box.anchor.kind) {
    case "screen":
      return { x: clamp01(box.anchor.pos.x), y: clamp01(box.anchor.pos.y) };
    case "safe-area":
      return { x: 0.5, y: SAFE_AREA_Y[box.anchor.placement] };
    case "cursor": {
      const cursor = cursors.find((candidate) => candidate.sample && candidate.output_point);
      if (!cursor?.sample) return { ...box.fallback_pos };
      const normalizedCursor = normalizedPoint(
        cursor.sample,
        graph.output_width,
        graph.output_height,
      );
      const sourcePoint = {
        x: normalizedCursor.x + box.anchor.offset.x,
        y: normalizedCursor.y + box.anchor.offset.y,
      };
      const output = sourcePointToOutput(
        sourcePoint,
        zoom,
        contentRect,
        graph.output_width,
        graph.output_height,
      );
      return {
        x: clamp01(output.x / graph.output_width),
        y: clamp01(output.y / graph.output_height),
      };
    }
    case "target": {
      const explicit = inputs.target_bounds_by_step_id?.get(box.anchor.stepId);
      const sourceBounds =
        explicit ??
        highlights.find(
          (highlight) => highlight.spec.clip_id === box.clip_id && highlight.spec.source_bounds,
        )?.spec.source_bounds;
      if (!sourceBounds) return { ...box.fallback_pos };
      const normalizedBounds = normalizedRect(
        sourceBounds,
        graph.output_width,
        graph.output_height,
      );
      const output = sourcePointToOutput(
        targetPosition(normalizedBounds, box.anchor.placement),
        zoom,
        contentRect,
        graph.output_width,
        graph.output_height,
      );
      return {
        x: clamp01(output.x / graph.output_width),
        y: clamp01(output.y / graph.output_height),
      };
    }
    default:
      return assertNever(box.anchor);
  }
}

function evaluateCursors(
  graph: SupportedExportCompositionGraph,
  timeMs: number,
  zoom: EvaluatedZoom,
  contentRect: SceneRect,
  inputs: SceneEvaluationInputs,
): EvaluatedCursor[] {
  return nodesOf(graph, "cursor-overlay")
    .filter((node) => timeMs >= node.t_start_ms && timeMs <= node.t_start_ms + node.duration_ms)
    .sort((a, b) => a.t_start_ms - b.t_start_ms || a.clip_id.localeCompare(b.clip_id))
    .map((node) => {
      const sample = inputs.cursor_samples?.get(node.id) ?? null;
      const outputPoint = sample
        ? sourcePointToOutput(sample, zoom, contentRect, graph.output_width, graph.output_height)
        : null;
      const relativeMs = Math.max(0, timeMs - node.t_start_ms);
      const pngFrameIndex =
        node.trajectory.kind === "png-sequence" && node.trajectory.frame_count > 0
          ? Math.min(
              node.trajectory.frame_count - 1,
              Math.max(0, Math.floor((relativeMs / 1_000) * Math.max(0, node.trajectory.fps))),
            )
          : null;
      return { node, sample, output_point: outputPoint, png_frame_index: pngFrameIndex };
    });
}

export function clickEffectIsVisible(effect: ExportCursorClickEffect): boolean {
  return effect.style !== "none";
}

export function evaluateScene(
  graph: SupportedExportCompositionGraph,
  timestampMs: number,
  inputs: SceneEvaluationInputs = {},
): EvaluatedScene {
  assertCanonicalVisualCoverage(graph);
  const timeMs = Math.max(0, Math.min(Math.max(0, graph.duration_ms), finiteOr(timestampMs, 0)));
  const background = nodesOf(graph, "background")[0] ?? null;
  const contentRect = resolveSceneContentRect(graph);
  const zoom = evaluateSceneZoom(graph, timeMs);
  const sourceResult = evaluateSources(graph, timeMs);
  const highlights = evaluateHighlights(graph, timeMs, zoom, contentRect);
  const cursors = evaluateCursors(graph, timeMs, zoom, contentRect, inputs);
  const text = nodesOf(graph, "text-overlay")
    .flatMap((node) => node.boxes)
    .filter((box) => timeMs >= box.t_start_ms && timeMs <= box.t_end_ms)
    .sort((a, b) => a.t_start_ms - b.t_start_ms || a.clip_id.localeCompare(b.clip_id))
    .map((box) => {
      const animation = textAnimationState(box, timeMs);
      return {
        box,
        pos: resolveTextPosition(box, zoom, graph, contentRect, cursors, highlights, inputs),
        alpha: animation.alpha,
        translate_y_px: animation.translateY,
        scale: animation.scale,
      };
    });

  return {
    graph,
    time_ms: timeMs,
    output_width: graph.output_width,
    output_height: graph.output_height,
    background,
    content_rect: contentRect,
    zoom,
    ...sourceResult,
    highlights,
    ripples: evaluateRipples(graph, timeMs, zoom, contentRect),
    cursors,
    text,
  };
}
