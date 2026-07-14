import { useEffect, useRef } from "react";

import type { RecordingTrajectory } from "@/ipc/trajectory";
import {
  samplePreparedVirtualCursor,
  sampleTrajectoryCursor,
  type VirtualCursorSample,
} from "../preview/virtual-cursor-path";
import type {
  EasingKind,
  Graph as ExportGraph,
  Rgba,
  Vec2,
  VideoNode,
} from "../state/compute-graph";
import {
  CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX,
  cursorClickEffectRenderScale,
} from "../state/cursor-click-effect";
import { timelineMsToSourcePtsUs } from "../state/source-timeline-map";
import { DEFAULT_TEXT_FONT, textFontCss, textHorizontalOrigin } from "../state/text-style";
import {
  buildVirtualCursorSchedule,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";
import { type ZoomEasing, zoomEase } from "../state/zoom-motion";
import { parseExportCursorSidecar } from "./cursor-sidecar";

const CURSOR_BASE_SIZE_PX = 32;
const CURSOR_IMAGE_HOTSPOT_PX = 1;

const cursorSkinAssets = import.meta.glob("../../../../../../assets/cursor-skins/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

type SourceNode = Extract<VideoNode, { type: "source" }>;
type CursorNode = Extract<VideoNode, { type: "cursor-overlay" }>;
type TextBoxNode = Extract<VideoNode, { type: "text-overlay" }>["boxes"][number];

export interface ExportCompositorPayload {
  graph: ExportGraph;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  durationMs: number;
}

interface ExportCompositorBridge {
  configure(payload: ExportCompositorPayload): Promise<{ ok: true }>;
  renderFrame(timeMs: number): Promise<{ ok: true }>;
  dispose(): Promise<{ ok: true }>;
}

declare global {
  interface Window {
    __STORYCAPTURE_EXPORT_COMPOSITOR__?: ExportCompositorBridge;
  }
}

interface CursorLayer {
  node: CursorNode;
  clickEffect: CursorNode["click_effect"];
  image: HTMLImageElement | null;
  trajectory: RecordingTrajectory | null;
  schedule: VirtualCursorSchedule | null;
  sidecarKind: "actions" | "trajectory" | "unknown";
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TextAnimationState {
  alpha: number;
  translateY: number;
  scale: number;
}

export interface ExportTextLineLayout {
  text: string;
  width: number;
}

export interface ExportTextLayout {
  lines: ExportTextLineLayout[];
  width: number;
  height: number;
  lineHeight: number;
}

const GRADIENTS: Record<string, [string, string, string]> = {
  "runway-dark": ["#141414", "#0e1117", "#17130f"],
  "runway-light": ["#fbfaf7", "#f3f0e9", "#f8fbff"],
  "linear-slate": ["#161a20", "#222730", "#121418"],
  "elevenlabs-violet": ["#1a1720", "#141116", "#201724"],
  "warm-sunset": ["#2a1713", "#161312", "#4a2118"],
  "cool-ocean": ["#10171d", "#0e1417", "#123141"],
  "forest-emerald": ["#121816", "#0f1411", "#173322"],
  "solid-black": ["#101010", "#171717", "#111111"],
  "solid-white": ["#f9faf8", "#f1f3f2", "#ffffff"],
  "paper-grain": ["#f6f1e8", "#ebe5da", "#f8f4eb"],
};

function assetUrl(path: string): string {
  if (/^(?:https?:|data:|blob:|asset:|storycapture-asset:)/i.test(path)) return path;
  if (path.startsWith("file:")) {
    return `storycapture-asset://local/${encodeURIComponent(
      decodeURIComponent(new URL(path).pathname),
    )}`;
  }
  return `storycapture-asset://local/${encodeURIComponent(path)}`;
}

function rgba(color: Rgba, alphaMultiplier = 1): string {
  const alpha = Math.max(0, Math.min(1, (color.a / 255) * alphaMultiplier));
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function easeInOutCubic(value: number): number {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function normalizedFontSize(box: TextBoxNode): number {
  return Math.max(12, Math.min(72, box.size_pt));
}

function canvasFont(box: TextBoxNode, fallback = false): string {
  const font = textFontCss(fallback ? DEFAULT_TEXT_FONT : box.font);
  return `${font.fontStyle} ${font.fontWeight} ${normalizedFontSize(box)}px ${font.fontFamily}`;
}

function browserFontSet(): Pick<FontFaceSet, "load"> | undefined {
  if (typeof document === "undefined" || typeof document.fonts?.load !== "function") {
    return undefined;
  }
  return document.fonts;
}

export async function loadExportTextFonts(
  graph: ExportGraph,
  fontSet: Pick<FontFaceSet, "load"> | undefined = browserFontSet(),
): Promise<void> {
  if (!fontSet) return;
  const requests = new Map<string, { fallbackFont: string; sample: string }>();
  for (const node of nodesOf(graph, "text-overlay")) {
    for (const box of node.boxes) {
      const font = canvasFont(box);
      if (!requests.has(font)) {
        requests.set(font, {
          fallbackFont: canvasFont(box, true),
          sample: box.text.slice(0, 128) || "M",
        });
      }
    }
  }
  await Promise.all(
    Array.from(requests, async ([font, request]) => {
      try {
        await fontSet.load(font, request.sample);
      } catch {
        try {
          await fontSet.load(request.fallbackFont, request.sample);
        } catch {
          // Canvas will still use its built-in sans-serif fallback.
        }
      }
    }),
  );
}

function textAnimationState(box: TextBoxNode, timeMs: number): TextAnimationState {
  const duration = Math.max(1, box.anim_duration_ms ?? 180);
  const inProgress = easeInOutCubic((timeMs - box.t_start_ms) / duration);
  const outProgress = easeInOutCubic((box.t_end_ms - timeMs) / duration);
  let alpha = 1;
  let translateY = 0;
  let scale = 1;

  if (box.anim_in === "fade") {
    alpha *= inProgress;
  } else if (box.anim_in === "slide-up") {
    alpha *= inProgress;
    translateY += (1 - inProgress) * 18;
  } else if (box.anim_in === "scale-in") {
    alpha *= inProgress;
    scale = 0.92 + inProgress * 0.08;
  }

  if (box.anim_out === "fade") {
    alpha *= outProgress;
  }

  return { alpha: clamp01(alpha), translateY, scale };
}

function cursorSkinSrc(skin: CursorNode["skin"]): string | undefined {
  return cursorSkinAssets[`../../../../../../assets/cursor-skins/${skin}.png`];
}

function nodeOf<T extends VideoNode["type"]>(
  graph: ExportGraph,
  type: T,
): Extract<VideoNode, { type: T }> | null {
  return (
    (graph.video ?? []).find(
      (node): node is Extract<VideoNode, { type: T }> => node.type === type,
    ) ?? null
  );
}

function nodesOf<T extends VideoNode["type"]>(
  graph: ExportGraph,
  type: T,
): Array<Extract<VideoNode, { type: T }>> {
  return (graph.video ?? []).filter(
    (node): node is Extract<VideoNode, { type: T }> => node.type === type,
  );
}

function sourceNode(graph: ExportGraph): SourceNode {
  const source = nodeOf(graph, "source");
  if (!source?.path) throw new Error("export compositor requires a source video");
  return source;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "sync";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image: ${src}`));
    img.src = src;
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error(`failed to load source video: ${src}`));
    video.src = src;
    video.load();
  });
}

function unloadVideo(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
}

async function fetchJson(path: string): Promise<unknown | null> {
  if (!path.endsWith(".json")) return null;
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`failed to load cursor sidecar: ${path}`);
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function exportZoomEasing(easing: EasingKind): ZoomEasing {
  if (
    easing === "linear" ||
    easing === "ease-in-cubic" ||
    easing === "ease-out-cubic" ||
    easing === "ease-in-out-cubic"
  ) {
    return easing;
  }
  return "ease-in-out-cubic";
}

export function sampleExportZoom(
  graph: ExportGraph,
  timeMs: number,
  width: number,
  height: number,
) {
  let selected: { center: Vec2; scale: number } | null = null;
  let selectedStart = -Infinity;
  for (const node of nodesOf(graph, "zoom-pan")) {
    const keyframes = node.keyframes
      .filter((frame) => Number.isFinite(frame.t_ms) && Number.isFinite(frame.scale))
      .slice()
      .sort((a, b) => a.t_ms - b.t_ms);
    if (keyframes.length < 2) continue;
    const first = keyframes[0];
    const last = keyframes[keyframes.length - 1];
    if (!first || !last || timeMs < first.t_ms || timeMs > last.t_ms) continue;
    for (let i = 0; i < keyframes.length - 1; i += 1) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      if (!a || !b || timeMs < a.t_ms || timeMs > b.t_ms) continue;
      if (first.t_ms < selectedStart) break;
      const span = Math.max(1, b.t_ms - a.t_ms);
      const t = zoomEase((timeMs - a.t_ms) / span, exportZoomEasing(a.easing));
      selected = {
        center: {
          x: a.center.x + (b.center.x - a.center.x) * t,
          y: a.center.y + (b.center.y - a.center.y) * t,
        },
        scale: Math.max(1, a.scale + (b.scale - a.scale) * t),
      };
      selectedStart = first.t_ms;
      break;
    }
  }
  if (selected && selectedStart > -Infinity) return selected;
  return { center: { x: width / 2, y: height / 2 }, scale: 1 };
}

function applyZoomToNormalizedPoint(
  point: Vec2,
  zoom: { center: Vec2; scale: number },
  width: number,
  height: number,
): Vec2 {
  const scale = Math.max(1, zoom.scale);
  if (scale <= 1) return { x: clamp01(point.x), y: clamp01(point.y) };
  const cropX = zoom.center.x / width - 1 / (2 * scale);
  const cropY = zoom.center.y / height - 1 / (2 * scale);
  return {
    x: clamp01((point.x - cropX) * scale),
    y: clamp01((point.y - cropY) * scale),
  };
}

function drawCursorFeedback(
  ctx: CanvasRenderingContext2D,
  sample: VirtualCursorSample,
  zoom: { center: Vec2; scale: number },
  width: number,
  height: number,
  sizeScale: number,
): void {
  const outputScale = cursorClickEffectRenderScale(width, height) * sizeScale;
  for (const feedback of sample.clickFeedback) {
    const point = applyZoomToNormalizedPoint(feedback, zoom, width, height);
    const x = point.x * width;
    const y = point.y * height;
    for (const primitive of feedback.primitives) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, primitive.radius * outputScale, 0, Math.PI * 2);
      if (primitive.fillOpacity > 0) {
        ctx.globalAlpha = primitive.fillOpacity;
        ctx.fillStyle = primitive.foreground;
        ctx.shadowColor = primitive.foreground;
        ctx.shadowBlur = primitive.glowBlur * outputScale;
        ctx.fill();
      }
      if (primitive.opacity > 0 && primitive.strokeWidth > 0) {
        ctx.globalAlpha = primitive.opacity;
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.strokeStyle = primitive.contrast;
        ctx.lineWidth =
          (primitive.strokeWidth + CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX) * outputScale;
        ctx.stroke();

        ctx.strokeStyle = primitive.foreground;
        ctx.lineWidth = primitive.strokeWidth * outputScale;
        ctx.shadowColor = primitive.foreground;
        ctx.shadowBlur = primitive.glowBlur * outputScale;
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

export function drawExportCursorSample(
  ctx: CanvasRenderingContext2D,
  sample: VirtualCursorSample,
  image: HTMLImageElement | null,
  sizeScale: number,
  zoom: { center: Vec2; scale: number },
  width: number,
  height: number,
): void {
  const point = applyZoomToNormalizedPoint(sample, zoom, width, height);
  const x = point.x * width;
  const y = point.y * height;
  const outputScale = cursorClickEffectRenderScale(width, height);
  const normalizedSizeScale = Math.max(0.1, sizeScale || 1);
  drawCursorFeedback(ctx, sample, zoom, width, height, normalizedSizeScale);
  const size = CURSOR_BASE_SIZE_PX * normalizedSizeScale * outputScale;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sample.cursorScale, sample.cursorScale);
  if (image) {
    const hotspot = CURSOR_IMAGE_HOTSPOT_PX * normalizedSizeScale * outputScale;
    ctx.drawImage(image, -hotspot, -hotspot, size, size);
  } else {
    ctx.fillStyle = "white";
    ctx.strokeStyle = "rgba(0,0,0,0.58)";
    ctx.lineWidth = 2 * outputScale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(size * 0.3, size * 0.7);
    ctx.lineTo(size * 0.52, size * 0.72);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2));
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.w - r, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h);
  ctx.lineTo(rect.x + r, rect.y + rect.h);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function segmentTextGraphemes(text: string): string[] {
  if (!text) return [];
  if (!graphemeSegmenter) return [text];
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function textWidth(ctx: CanvasRenderingContext2D, text: string, letterSpacingPx: number): number {
  if (!text) return 0;
  if (letterSpacingPx === 0) return ctx.measureText(text).width;
  const glyphs = segmentTextGraphemes(text);
  return Math.max(
    0,
    ctx.measureText(text).width + letterSpacingPx * Math.max(0, glyphs.length - 1),
  );
}

function splitLongText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacingPx: number,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const glyph of segmentTextGraphemes(text)) {
    const candidate = `${chunk}${glyph}`;
    if (chunk && textWidth(ctx, candidate, letterSpacingPx) > maxWidth) {
      chunks.push(chunk);
      chunk = glyph;
    } else {
      chunk = candidate;
    }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function wrapParagraph(
  ctx: CanvasRenderingContext2D,
  paragraph: string,
  maxWidth: number,
  letterSpacingPx: number,
): string[] {
  if (!paragraph) return [""];
  const lines: string[] = [];
  const tokens = paragraph.match(/\S+|[ \t]+/g) ?? [paragraph];
  let line = "";
  for (const token of tokens) {
    const candidate = `${line}${token}`;
    if (textWidth(ctx, candidate, letterSpacingPx) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (/^[ \t]+$/.test(token)) {
      if (line) lines.push(line.trimEnd());
      line = "";
      continue;
    }
    if (line) {
      lines.push(line.trimEnd());
      line = "";
    }
    const chunks = splitLongText(ctx, token, maxWidth, letterSpacingPx);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

export function layoutExportTextBox(
  ctx: CanvasRenderingContext2D,
  box: TextBoxNode,
  outputWidth: number,
): ExportTextLayout {
  ctx.font = canvasFont(box);
  const letterSpacingPx = Number.isFinite(box.letter_spacing_px) ? box.letter_spacing_px : 0;
  const maxWidthPct = Number.isFinite(box.max_width_pct)
    ? Math.max(20, Math.min(100, box.max_width_pct))
    : 78;
  const maxWidth = Math.max(1, outputWidth * (maxWidthPct / 100));
  const lines = box.text
    .split("\n")
    .flatMap((paragraph) => wrapParagraph(ctx, paragraph, maxWidth, letterSpacingPx))
    .map((text) => ({ text, width: textWidth(ctx, text, letterSpacingPx) }));
  const lineHeightFactor = Number.isFinite(box.line_height)
    ? Math.max(0.8, Math.min(2, box.line_height))
    : 1.12;
  const lineHeight = normalizedFontSize(box) * lineHeightFactor;
  return {
    lines,
    width: Math.max(1, ...lines.map((line) => line.width)),
    height: lineHeight * lines.length,
    lineHeight,
  };
}

function setCanvasShadow(ctx: CanvasRenderingContext2D, shadow: TextBoxNode["text_shadow"]): void {
  ctx.shadowColor = shadow ? rgba(shadow.color) : "transparent";
  ctx.shadowBlur = shadow?.blur_px ?? 0;
  ctx.shadowOffsetX = shadow?.offset_x_px ?? 0;
  ctx.shadowOffsetY = shadow?.offset_y_px ?? 0;
}

function drawTextWithSpacing(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacingPx: number,
): void {
  if (!text) return;
  if (letterSpacingPx === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  const glyphs = segmentTextGraphemes(text);
  let prefix = "";
  glyphs.forEach((glyph, index) => {
    const prefixWidth = prefix ? ctx.measureText(prefix).width : 0;
    const cursorX = x + prefixWidth + letterSpacingPx * index;
    ctx.fillText(glyph, cursorX, y);
    prefix += glyph;
  });
}

export function drawExportTextBox(
  ctx: CanvasRenderingContext2D,
  box: TextBoxNode,
  timeMs: number,
  outputWidth: number,
  outputHeight: number,
): void {
  if (timeMs < box.t_start_ms || timeMs > box.t_end_ms) return;
  const animation = textAnimationState(box, timeMs);
  if (animation.alpha <= 0) return;
  const letterSpacingPx = Number.isFinite(box.letter_spacing_px) ? box.letter_spacing_px : 0;
  const align = box.align === "left" || box.align === "right" ? box.align : "center";
  const horizontalOrigin = textHorizontalOrigin(box.pos.x);
  const x = clamp01(box.pos.x) * outputWidth;
  const y = clamp01(box.pos.y) * outputHeight;

  ctx.save();
  const layout = layoutExportTextBox(ctx, box, outputWidth);
  ctx.globalAlpha = animation.alpha;
  ctx.translate(x, y + animation.translateY);
  ctx.scale(animation.scale, animation.scale);
  ctx.font = canvasFont(box);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const pad = box.box_style?.padding_px ?? 0;
  const totalWidth = layout.width + pad * 2;
  const boxLeft =
    horizontalOrigin === "left" ? 0 : horizontalOrigin === "right" ? -totalWidth : -totalWidth / 2;
  const contentLeft = boxLeft + pad;

  if (box.box_style) {
    const rect = {
      x: boxLeft,
      y: -layout.height / 2 - pad,
      w: layout.width + pad * 2,
      h: layout.height + pad * 2,
    };
    setCanvasShadow(ctx, box.box_style.shadow);
    roundedRectPath(ctx, rect, box.box_style.radius_px);
    ctx.fillStyle = rgba(box.box_style.bg_color);
    ctx.fill();
    setCanvasShadow(ctx, null);
    if (box.box_style.border_color && box.box_style.border_width_px > 0) {
      ctx.strokeStyle = rgba(box.box_style.border_color);
      ctx.lineWidth = box.box_style.border_width_px;
      ctx.stroke();
    }
  }

  ctx.fillStyle = rgba(box.color);
  setCanvasShadow(ctx, box.text_shadow);
  layout.lines.forEach((line, index) => {
    const lineX =
      align === "left"
        ? contentLeft
        : align === "right"
          ? contentLeft + layout.width - line.width
          : contentLeft + (layout.width - line.width) / 2;
    const lineY = -layout.height / 2 + layout.lineHeight * (index + 0.5);
    drawTextWithSpacing(ctx, line.text, lineX, lineY, letterSpacingPx);
  });
  ctx.restore();
}

function containRect(sourceW: number, sourceH: number, bounds: Rect): Rect {
  const aspect = sourceW > 0 && sourceH > 0 ? sourceW / sourceH : bounds.w / bounds.h;
  const boundsAspect = bounds.w / bounds.h;
  if (aspect >= boundsAspect) {
    const h = bounds.w / aspect;
    return { x: bounds.x, y: bounds.y + (bounds.h - h) / 2, w: bounds.w, h };
  }
  const w = bounds.h * aspect;
  return { x: bounds.x + (bounds.w - w) / 2, y: bounds.y, w, h: bounds.h };
}

class CanvasExportCompositor {
  private graph: ExportGraph | null = null;
  private video: HTMLVideoElement | null = null;
  private cursorLayers: CursorLayer[] = [];
  private backgroundImage: HTMLImageElement | null = null;
  private outputWidth = 1920;
  private outputHeight = 1080;
  private configureVersion = 0;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {}

  async configure(payload: ExportCompositorPayload): Promise<{ ok: true }> {
    const version = this.configureVersion + 1;
    this.configureVersion = version;
    this.disposed = false;
    this.clearLoadedMedia();
    this.outputWidth = Math.max(16, Math.round(payload.outputWidth));
    this.outputHeight = Math.max(16, Math.round(payload.outputHeight));
    this.canvas.width = this.outputWidth;
    this.canvas.height = this.outputHeight;
    this.canvas.style.width = `${this.outputWidth}px`;
    this.canvas.style.height = `${this.outputHeight}px`;

    const source = sourceNode(payload.graph);
    const video = await loadVideo(assetUrl(source.path));
    const cursorLayers = await Promise.all(
      nodesOf(payload.graph, "cursor-overlay").map(async (node) => {
        const src = cursorSkinSrc(node.skin);
        const image = src ? await loadImage(src) : null;
        const rawSidecar = await fetchJson(node.trajectory.png_sequence_dir);
        const parsed = parseExportCursorSidecar(rawSidecar);
        return {
          node,
          clickEffect: node.click_effect,
          image,
          trajectory: parsed.kind === "trajectory" ? parsed.sidecar : null,
          schedule:
            parsed.kind === "actions"
              ? buildVirtualCursorSchedule(parsed.sidecar, node.motion_preset, {
                  preserveFullMotion: node.preserve_full_motion,
                })
              : null,
          sidecarKind: parsed.kind,
        };
      }),
    );

    const background = nodeOf(payload.graph, "background");
    const backgroundImage =
      background?.kind.kind === "image" && background.kind.path
        ? await loadImage(assetUrl(background.kind.path))
        : null;
    await loadExportTextFonts(payload.graph);
    if (this.isStale(version)) {
      unloadVideo(video);
      throw new Error("export compositor configure was cancelled");
    }
    this.graph = payload.graph;
    this.video = video;
    this.cursorLayers = cursorLayers;
    this.backgroundImage = backgroundImage;
    this.drawFrame(0);
    return { ok: true };
  }

  async renderFrame(timeMs: number): Promise<{ ok: true }> {
    if (!this.graph || !this.video) throw new Error("export compositor is not configured");
    const source = sourceNode(this.graph);
    const relativeTimelineMs = Math.max(0, timeMs - (source.pts_offset_ms ?? 0));
    const sourcePtsUs = source.source_time_map
      ? timelineMsToSourcePtsUs(source.source_time_map, relativeTimelineMs)
      : Math.round(relativeTimelineMs * 1000);
    if (sourcePtsUs == null) throw new Error("export frame is outside the source time map");
    const sourceTime = sourcePtsUs / 1_000_000;
    await this.seek(sourceTime);
    this.drawFrame(timeMs);
    return { ok: true };
  }

  async dispose(): Promise<{ ok: true }> {
    this.configureVersion += 1;
    this.disposed = true;
    this.clearLoadedMedia();
    return { ok: true };
  }

  private isStale(version: number): boolean {
    return this.disposed || version !== this.configureVersion;
  }

  private clearLoadedMedia(): void {
    if (this.video) unloadVideo(this.video);
    this.graph = null;
    this.video = null;
    this.cursorLayers = [];
    this.backgroundImage = null;
  }

  private seek(timeSeconds: number): Promise<void> {
    const video = this.video;
    if (!video) return Promise.resolve();
    if (Math.abs(video.currentTime - timeSeconds) < 0.001 && video.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("source video seek failed"));
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = Math.max(0, timeSeconds);
    });
  }

  private drawFrame(timeMs: number): void {
    if (!this.graph || !this.video) return;
    const ctx = this.ctx;
    const width = this.outputWidth;
    const height = this.outputHeight;
    ctx.clearRect(0, 0, width, height);
    const contentRect = this.drawBackground();
    this.drawSourceVideo(timeMs, contentRect);
    this.drawHighlights(timeMs);
    this.drawRipples(timeMs);
    this.drawCursorLayers(timeMs);
    this.drawText(timeMs);
  }

  private drawBackground(): Rect {
    const ctx = this.ctx;
    const width = this.outputWidth;
    const height = this.outputHeight;
    const background = this.graph ? nodeOf(this.graph, "background") : null;
    if (!background) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      return { x: 0, y: 0, w: width, h: height };
    }

    if (background.kind.kind === "solid") {
      ctx.fillStyle = rgba(background.kind.color);
      ctx.fillRect(0, 0, width, height);
    } else if (background.kind.kind === "image" && this.backgroundImage) {
      ctx.drawImage(this.backgroundImage, 0, 0, width, height);
    } else {
      const colors =
        background.kind.kind === "gradient"
          ? (GRADIENTS[background.kind.preset_id] ?? GRADIENTS["runway-dark"])
          : GRADIENTS["runway-dark"];
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(0.55, colors[1]);
      gradient.addColorStop(1, colors[2]);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }

    const pad = Math.max(0, background.padding_px);
    return { x: pad, y: pad, w: Math.max(1, width - pad * 2), h: Math.max(1, height - pad * 2) };
  }

  private drawSourceVideo(timeMs: number, contentRect: Rect): void {
    if (!this.graph || !this.video) return;
    const background = nodeOf(this.graph, "background");
    const zoom = sampleExportZoom(this.graph, timeMs, this.outputWidth, this.outputHeight);
    const scale = Math.max(1, zoom.scale);
    const cropX = zoom.center.x / this.outputWidth - 1 / (2 * scale);
    const cropY = zoom.center.y / this.outputHeight - 1 / (2 * scale);
    const videoRect = containRect(this.video.videoWidth, this.video.videoHeight, contentRect);
    const ctx = this.ctx;

    ctx.save();
    if (background) {
      roundedRectPath(ctx, contentRect, background.radius_px);
      ctx.clip();
    } else {
      ctx.beginPath();
      ctx.rect(contentRect.x, contentRect.y, contentRect.w, contentRect.h);
      ctx.clip();
    }
    ctx.drawImage(
      this.video,
      videoRect.x - cropX * contentRect.w * scale,
      videoRect.y - cropY * contentRect.h * scale,
      videoRect.w * scale,
      videoRect.h * scale,
    );
    ctx.restore();
  }

  private drawHighlights(timeMs: number): void {
    if (!this.graph) return;
    const ctx = this.ctx;
    for (const node of nodesOf(this.graph, "highlight-overlay")) {
      for (const highlight of node.highlights) {
        const elapsed = timeMs - highlight.t_start_ms;
        if (elapsed < 0 || elapsed > highlight.duration_ms) continue;
        const fade = Math.min(1, elapsed / 120, (highlight.duration_ms - elapsed) / 120);
        const alpha = Math.max(0, Math.min(1, highlight.opacity * fade));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = rgba(highlight.color);
        ctx.lineWidth = highlight.stroke_px;
        ctx.shadowColor = rgba(highlight.color, 0.75);
        ctx.shadowBlur = highlight.glow_px;
        if (highlight.bounds) {
          const rect = {
            x: highlight.bounds.x - highlight.padding_px,
            y: highlight.bounds.y - highlight.padding_px,
            w: highlight.bounds.w + highlight.padding_px * 2,
            h: highlight.bounds.h + highlight.padding_px * 2,
          };
          roundedRectPath(ctx, rect, highlight.radius_px);
        } else {
          ctx.beginPath();
          ctx.arc(highlight.center.x, highlight.center.y, highlight.max_radius_px, 0, Math.PI * 2);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawRipples(timeMs: number): void {
    if (!this.graph) return;
    const ctx = this.ctx;
    for (const node of nodesOf(this.graph, "ripple-overlay")) {
      for (const event of node.events) {
        const elapsed = timeMs - event.t_impact_ms;
        if (elapsed < 0 || elapsed > event.duration_ms) continue;
        const progress = elapsed / Math.max(1, event.duration_ms);
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - progress);
        ctx.strokeStyle = rgba(event.color);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(event.center.x, event.center.y, event.max_radius_px * progress, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawCursorLayers(timeMs: number): void {
    if (!this.graph) return;
    const ctx = this.ctx;
    const zoom = sampleExportZoom(this.graph, timeMs, this.outputWidth, this.outputHeight);
    for (const layer of this.cursorLayers) {
      const startMs = Math.max(0, layer.node.t_start_ms ?? 0);
      const durationMs = Math.max(0, layer.node.duration_ms ?? Number.POSITIVE_INFINITY);
      if (timeMs < startMs || timeMs > startMs + durationMs) continue;
      const relativeTimelineMs = timeMs - startMs;
      const sourceMap = sourceNode(this.graph).source_time_map;
      const mappedRelativeMs = sourceMap
        ? (timelineMsToSourcePtsUs(sourceMap, relativeTimelineMs) ?? relativeTimelineMs * 1000) /
          1000
        : relativeTimelineMs;
      const relativeMs = layer.node.preserve_full_motion ? relativeTimelineMs : mappedRelativeMs;
      const sample =
        layer.sidecarKind === "actions"
          ? samplePreparedVirtualCursor(layer.schedule, relativeMs, layer.clickEffect)
          : layer.sidecarKind === "trajectory"
            ? sampleTrajectoryCursor(layer.trajectory, relativeMs)
            : null;
      if (!sample) continue;
      drawExportCursorSample(
        ctx,
        sample,
        layer.image,
        layer.node.size_scale,
        zoom,
        this.outputWidth,
        this.outputHeight,
      );
    }
  }

  private drawText(timeMs: number): void {
    if (!this.graph) return;
    for (const node of nodesOf(this.graph, "text-overlay")) {
      for (const box of node.boxes) {
        drawExportTextBox(this.ctx, box, timeMs, this.outputWidth, this.outputHeight);
      }
    }
  }
}

export function ExportCompositorApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return undefined;
    const compositor = new CanvasExportCompositor(canvas, ctx);
    window.__STORYCAPTURE_EXPORT_COMPOSITOR__ = {
      configure: (payload) => compositor.configure(payload),
      renderFrame: (timeMs) => compositor.renderFrame(timeMs),
      dispose: () => compositor.dispose(),
    };
    return () => {
      void compositor.dispose();
      delete window.__STORYCAPTURE_EXPORT_COMPOSITOR__;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        position: "fixed",
        inset: 0,
        background: "#000",
      }}
    />
  );
}
