import type {
  ExportBackgroundKind,
  ExportCursorSkin,
  ExportRgba,
  ExportTextBox,
  ExportTextShadow,
  ExportTransitionKind,
} from "@storycapture/shared-types";

import {
  CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX,
  cursorClickEffectRenderScale,
} from "../state/cursor-click-effect";
import { DEFAULT_TEXT_FONT, textFontCss, textHorizontalOrigin } from "../state/text-style";
import {
  applyZoomToNormalizedPoint,
  type EvaluatedCursor,
  type EvaluatedHighlight,
  type EvaluatedRipple,
  type EvaluatedScene,
  type EvaluatedSource,
  type EvaluatedText,
  type EvaluatedTransition,
  type SceneRect,
} from "./scene-evaluator";

const CURSOR_BASE_SIZE_PX = 32;
const CURSOR_HOTSPOT_PX = 1;

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

export interface CanonicalRenderAssets {
  source(sourceId: string): CanvasImageSource | null;
  image(path: string): CanvasImageSource | null;
  cursorSkin(skin: ExportCursorSkin): CanvasImageSource | null;
  cursorPngFrame(cursorNodeId: string, frameIndex: number): CanvasImageSource | null;
}

export interface CanonicalPresentationLayout {
  surfaceRect: SceneRect;
  compositionRect: SceneRect;
}

export type CanonicalDrawCommand =
  | {
      layer: "background";
      kind: ExportBackgroundKind | null;
      content_rect: SceneRect;
      radius_px: number;
    }
  | { layer: "source"; source: EvaluatedSource }
  | { layer: "transition"; transition: EvaluatedTransition }
  | { layer: "highlight"; highlight: EvaluatedHighlight }
  | { layer: "ripple"; ripple: EvaluatedRipple }
  | { layer: "cursor"; cursor: EvaluatedCursor }
  | { layer: "text"; text: EvaluatedText };

export interface CanonicalCanvasRendererOptions {
  createScratchCanvas?: (width: number, height: number) => HTMLCanvasElement;
  resamplingQuality?: ExportResamplingQuality;
}

export type ExportResamplingQuality = "high" | "balanced" | "fast";

const CANVAS_SMOOTHING_QUALITY: Record<ExportResamplingQuality, ImageSmoothingQuality> = {
  high: "high",
  balanced: "medium",
  fast: "low",
};

function assertNever(value: never): never {
  throw new Error(`Unhandled canonical canvas value: ${JSON.stringify(value)}`);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function rgba(color: ExportRgba, alphaMultiplier = 1): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp01((color.a / 255) * alphaMultiplier)})`;
}

function roundedRectSubpath(ctx: CanvasRenderingContext2D, rect: SceneRect, radius: number): void {
  const r = Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2));
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.w - r, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
  ctx.quadraticCurveTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h);
  ctx.lineTo(rect.x + r, rect.y + rect.h);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, rect: SceneRect, radius: number): void {
  ctx.beginPath();
  roundedRectSubpath(ctx, rect, radius);
}

function sourceDimensions(
  source: CanvasImageSource,
  fallbackWidth: number,
  fallbackHeight: number,
) {
  const value = source as CanvasImageSource & {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  const width = value.videoWidth || value.naturalWidth || value.width || fallbackWidth;
  const height = value.videoHeight || value.naturalHeight || value.height || fallbackHeight;
  return { width: Math.max(1, Number(width)), height: Math.max(1, Number(height)) };
}

function containRect(sourceWidth: number, sourceHeight: number, bounds: SceneRect): SceneRect {
  const aspect = sourceWidth / Math.max(1, sourceHeight);
  const boundsAspect = bounds.w / Math.max(1, bounds.h);
  if (aspect >= boundsAspect) {
    const height = bounds.w / aspect;
    return { x: bounds.x, y: bounds.y + (bounds.h - height) / 2, w: bounds.w, h: height };
  }
  const width = bounds.h * aspect;
  return { x: bounds.x + (bounds.w - width) / 2, y: bounds.y, w: width, h: bounds.h };
}

function coverRect(sourceWidth: number, sourceHeight: number, bounds: SceneRect): SceneRect {
  const aspect = sourceWidth / Math.max(1, sourceHeight);
  const boundsAspect = bounds.w / Math.max(1, bounds.h);
  if (aspect >= boundsAspect) {
    const width = bounds.h * aspect;
    return { x: bounds.x + (bounds.w - width) / 2, y: bounds.y, w: width, h: bounds.h };
  }
  const height = bounds.w / aspect;
  return { x: bounds.x, y: bounds.y + (bounds.h - height) / 2, w: bounds.w, h: height };
}

function imageCoverRect(image: CanvasImageSource, bounds: SceneRect): SceneRect {
  const dimensions = sourceDimensions(image, bounds.w, bounds.h);
  return coverRect(dimensions.width, dimensions.height, bounds);
}

function clipContent(
  ctx: CanvasRenderingContext2D,
  scene: EvaluatedScene,
  translateX = 0,
  translateY = 0,
  bounds: SceneRect = scene.content_rect,
): void {
  const radius = (scene.background?.radius_px ?? 0) * canonical1080pScale(scene.output_height);
  const rect = {
    ...bounds,
    x: bounds.x + translateX,
    y: bounds.y + translateY,
  };
  roundedRectPath(ctx, rect, radius);
  ctx.clip();
}

function clampAuthoredMetric(value: number, min: number, max: number, fallback = min): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, finite));
}

export function canonical1080pScale(outputHeight: number): number {
  return Math.max(1, outputHeight) / 1_080;
}

function normalizedFontSize(box: ExportTextBox): number {
  return clampAuthoredMetric(box.size_pt, 12, 72, 12);
}

function canvasFont(box: ExportTextBox, outputScale: number): string {
  const font = textFontCss(box.font ?? DEFAULT_TEXT_FONT);
  return `${font.fontStyle} ${font.fontWeight} ${normalizedFontSize(box) * outputScale}px ${font.fontFamily}`;
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(text: string): string[] {
  if (!text) return [];
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function textWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  return Math.max(
    0,
    ctx.measureText(text).width + spacing * Math.max(0, graphemes(text).length - 1),
  );
}

function splitLongToken(
  ctx: CanvasRenderingContext2D,
  token: string,
  maxWidth: number,
  spacing: number,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const glyph of graphemes(token)) {
    if (current && textWidth(ctx, current + glyph, spacing) > maxWidth) {
      chunks.push(current);
      current = glyph;
    } else {
      current += glyph;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  spacing: number,
): string[] {
  return text.split("\n").flatMap((paragraph) => {
    if (!paragraph) return [""];
    const lines: string[] = [];
    let line = "";
    for (const token of paragraph.match(/\S+|[ \t]+/g) ?? [paragraph]) {
      const candidate = line + token;
      if (textWidth(ctx, candidate, spacing) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line.trimEnd());
      line = "";
      if (/^[ \t]+$/.test(token)) continue;
      const chunks = splitLongToken(ctx, token, maxWidth, spacing);
      lines.push(...chunks.slice(0, -1));
      line = chunks.at(-1) ?? "";
    }
    if (line || lines.length === 0) lines.push(line.trimEnd());
    return lines;
  });
}

function setShadow(
  ctx: CanvasRenderingContext2D,
  shadow: ExportTextShadow | null,
  outputScale: number,
): void {
  ctx.shadowColor = shadow ? rgba(shadow.color) : "transparent";
  ctx.shadowBlur = shadow ? clampAuthoredMetric(shadow.blur_px, 0, 64) * outputScale : 0;
  ctx.shadowOffsetX = shadow
    ? clampAuthoredMetric(shadow.offset_x_px, -32, 32, 0) * outputScale
    : 0;
  ctx.shadowOffsetY = shadow
    ? clampAuthoredMetric(shadow.offset_y_px, -32, 32, 0) * outputScale
    : 0;
}

function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  if (spacing === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  let prefix = "";
  graphemes(text).forEach((glyph, index) => {
    ctx.fillText(glyph, x + ctx.measureText(prefix).width + spacing * index, y);
    prefix += glyph;
  });
}

export function buildCanonicalDrawCommands(scene: EvaluatedScene): CanonicalDrawCommand[] {
  const commands: CanonicalDrawCommand[] = [
    {
      layer: "background",
      kind: scene.background?.kind ?? null,
      content_rect: scene.content_rect,
      radius_px: scene.background?.radius_px ?? 0,
    },
  ];
  if (scene.transition) commands.push({ layer: "transition", transition: scene.transition });
  else if (scene.sources[0]) commands.push({ layer: "source", source: scene.sources[0] });
  commands.push(
    ...scene.highlights.map((highlight) => ({ layer: "highlight" as const, highlight })),
  );
  commands.push(...scene.ripples.map((ripple) => ({ layer: "ripple" as const, ripple })));
  commands.push(...scene.cursors.map((cursor) => ({ layer: "cursor" as const, cursor })));
  commands.push(...scene.text.map((text) => ({ layer: "text" as const, text })));
  return commands;
}

/** Stable JSON form used when a test runtime cannot expose real Canvas pixels. */
export function canonicalCommandSnapshot(scene: EvaluatedScene): string {
  return JSON.stringify(buildCanonicalDrawCommands(scene), (_key, value) =>
    typeof value === "number" && !Number.isInteger(value) ? Number(value.toFixed(6)) : value,
  );
}

export class CanonicalCanvasSceneRenderer {
  private readonly createScratchCanvas: (width: number, height: number) => HTMLCanvasElement;
  private resamplingQuality: ExportResamplingQuality;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    options: CanonicalCanvasRendererOptions = {},
  ) {
    this.resamplingQuality = options.resamplingQuality ?? "high";
    this.createScratchCanvas =
      options.createScratchCanvas ??
      ((width, height) => {
        if (typeof document === "undefined") {
          throw new Error("canonical color tint requires a DOM canvas");
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      });
  }

  setResamplingQuality(quality: ExportResamplingQuality): void {
    this.resamplingQuality = quality;
  }

  private prepareImageScaling(ctx: CanvasRenderingContext2D = this.ctx): void {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = CANVAS_SMOOTHING_QUALITY[this.resamplingQuality];
  }

  render(
    scene: EvaluatedScene,
    assets: CanonicalRenderAssets,
    presentation?: CanonicalPresentationLayout,
  ): CanonicalDrawCommand[] {
    const commands = buildCanonicalDrawCommands(scene);
    const surfaceRect = presentation?.surfaceRect ?? {
      x: 0,
      y: 0,
      w: scene.output_width,
      h: scene.output_height,
    };
    const compositionRect = presentation?.compositionRect ?? surfaceRect;
    const compositionScale = Math.min(
      compositionRect.w / scene.output_width,
      compositionRect.h / scene.output_height,
    );
    this.ctx.clearRect(surfaceRect.x, surfaceRect.y, surfaceRect.w, surfaceRect.h);
    for (const command of commands) {
      if (command.layer === "background") {
        this.drawBackground(scene, command, assets, surfaceRect);
        continue;
      }

      const usesPresentationTransform = Boolean(presentation);
      if (usesPresentationTransform) {
        this.ctx.save();
        this.ctx.translate(compositionRect.x, compositionRect.y);
        this.ctx.scale(compositionScale, compositionScale);
      }
      try {
        switch (command.layer) {
          case "source":
            this.drawSourceShadow(scene, command.source, assets);
            this.drawSource(scene, command.source, assets);
            break;
          case "transition":
            this.drawSourceShadow(
              scene,
              command.transition.progress < 0.5 ? command.transition.from : command.transition.to,
              assets,
            );
            this.drawTransition(scene, command.transition, assets);
            break;
          case "highlight":
            this.drawHighlight(scene, command.highlight, assets);
            break;
          case "ripple":
            this.drawRipple(command.ripple);
            break;
          case "cursor":
            this.drawCursor(scene, command.cursor, assets);
            break;
          case "text":
            this.drawText(scene, command.text);
            break;
          default:
            assertNever(command);
        }
      } finally {
        if (usesPresentationTransform) this.ctx.restore();
      }
    }
    return commands;
  }

  private drawBackground(
    scene: EvaluatedScene,
    command: Extract<CanonicalDrawCommand, { layer: "background" }>,
    assets: CanonicalRenderAssets,
    bounds: SceneRect,
  ): void {
    const ctx = this.ctx;
    const kind = command.kind;
    if (kind?.kind === "ambient") {
      this.drawAmbientBackground(scene, assets, bounds);
    } else if (kind?.kind === "solid") {
      ctx.fillStyle = rgba(kind.color);
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    } else if (kind?.kind === "image") {
      if (!kind.path) throw new Error("canonical image background has no resolved path");
      const image = assets.image(kind.path);
      if (!image) throw new Error(`canonical image background is not loaded: ${kind.path}`);
      const rect = imageCoverRect(image, bounds);
      ctx.save();
      ctx.beginPath();
      ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h);
      ctx.clip();
      this.prepareImageScaling(ctx);
      ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      ctx.restore();
    } else if (kind?.kind === "gradient") {
      const colors = GRADIENTS[kind.preset_id];
      if (!colors) throw new Error(`canonical gradient preset is not mapped: ${kind.preset_id}`);
      const gradient = ctx.createLinearGradient(
        bounds.x,
        bounds.y,
        bounds.x + bounds.w,
        bounds.y + bounds.h,
      );
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(0.55, colors[1]);
      gradient.addColorStop(1, colors[2]);
      ctx.fillStyle = gradient;
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      if (kind.preset_id === "paper-grain") this.drawPaperTexture(bounds);
    } else if (kind) {
      assertNever(kind);
    }
  }

  private drawAmbientBackground(
    scene: EvaluatedScene,
    assets: CanonicalRenderAssets,
    bounds: SceneRect,
  ): void {
    const frames = scene.transition
      ? [
          { source: scene.transition.from, alpha: 1 - scene.transition.progress },
          { source: scene.transition.to, alpha: scene.transition.progress },
        ]
      : scene.sources[0]
        ? [{ source: scene.sources[0], alpha: 1 }]
        : [];
    const blurPx = Math.max(18, bounds.w * 0.025);
    for (const frame of frames) {
      const source = assets.source(frame.source.node.id);
      if (!source) {
        throw new Error(`canonical ambient source is not loaded: ${frame.source.node.id}`);
      }
      const dimensions = sourceDimensions(
        source,
        frame.source.node.source_width ?? bounds.w,
        frame.source.node.source_height ?? bounds.h,
      );
      const rect = coverRect(dimensions.width, dimensions.height, bounds);
      const overscanX = rect.w * 0.05;
      const overscanY = rect.h * 0.05;
      this.ctx.save();
      this.ctx.globalAlpha *= clamp01(frame.alpha) * 0.84;
      this.ctx.filter = `blur(${blurPx}px) saturate(1.15)`;
      this.prepareImageScaling();
      this.ctx.drawImage(
        source,
        rect.x - overscanX,
        rect.y - overscanY,
        rect.w + overscanX * 2,
        rect.h + overscanY * 2,
      );
      this.ctx.restore();
    }
    this.ctx.fillStyle = "rgba(8, 10, 12, 0.18)";
    this.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  }

  private drawPaperTexture(bounds: SceneRect): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.075;
    ctx.fillStyle = "#6f6557";
    for (let y = bounds.y + 5; y < bounds.y + bounds.h; y += 11) {
      for (let x = bounds.x + ((y * 7) % 13); x < bounds.x + bounds.w; x += 17) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();
  }

  private drawSource(
    scene: EvaluatedScene,
    sourceFrame: EvaluatedSource,
    assets: CanonicalRenderAssets,
    alpha = 1,
    translateX = 0,
    translateY = 0,
  ): void {
    const { source, rect: baseRect } = this.sourceLayout(scene, sourceFrame, assets);
    const scale = Math.max(1, scene.zoom.scale);
    const cropX = scene.zoom.center.x / Math.max(1, scene.output_width) - 1 / (2 * scale);
    const cropY = scene.zoom.center.y / Math.max(1, scene.output_height) - 1 / (2 * scale);
    const x = baseRect.x - cropX * baseRect.w * scale + translateX;
    const y = baseRect.y - cropY * baseRect.h * scale + translateY;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= clamp01(alpha);
    clipContent(ctx, scene, translateX, translateY, baseRect);
    this.prepareImageScaling(ctx);
    ctx.drawImage(source, x, y, baseRect.w * scale, baseRect.h * scale);
    ctx.restore();
  }

  private sourceLayout(
    scene: EvaluatedScene,
    sourceFrame: EvaluatedSource,
    assets: CanonicalRenderAssets,
  ): { source: CanvasImageSource; rect: SceneRect } {
    const source = assets.source(sourceFrame.node.id);
    if (!source) throw new Error(`canonical source frame is not loaded: ${sourceFrame.node.id}`);
    const dimensions = sourceDimensions(
      source,
      sourceFrame.node.source_width ?? scene.content_rect.w,
      sourceFrame.node.source_height ?? scene.content_rect.h,
    );
    const rect = scene.background
      ? containRect(dimensions.width, dimensions.height, scene.content_rect)
      : coverRect(dimensions.width, dimensions.height, scene.content_rect);
    return { source, rect };
  }

  private drawSourceShadow(
    scene: EvaluatedScene,
    sourceFrame: EvaluatedSource,
    assets: CanonicalRenderAssets,
  ): void {
    if (!scene.background) return;
    const { rect } = this.sourceLayout(scene, sourceFrame, assets);
    const ctx = this.ctx;
    ctx.save();
    roundedRectPath(
      ctx,
      rect,
      scene.background.radius_px * canonical1080pScale(scene.output_height),
    );
    ctx.fillStyle = "#000";
    ctx.shadowColor = "rgba(0, 0, 0, 0.34)";
    ctx.shadowBlur = Math.max(12, scene.output_width * 0.012);
    ctx.shadowOffsetY = Math.max(4, scene.output_height * 0.008);
    ctx.fill();
    ctx.restore();
  }

  private drawTransition(
    scene: EvaluatedScene,
    transition: EvaluatedTransition,
    assets: CanonicalRenderAssets,
  ): void {
    const p = clamp01(transition.progress);
    const rect = scene.content_rect;
    const ctx = this.ctx;
    switch (transition.kind) {
      case "fade":
      case "dissolve":
        this.drawSource(scene, transition.from, assets, 1 - p);
        this.drawSource(scene, transition.to, assets, p);
        return;
      case "fade-black":
      case "fade-white": {
        const fill = transition.kind === "fade-black" ? "#000" : "#fff";
        if (p < 0.5) this.drawSource(scene, transition.from, assets);
        else this.drawSource(scene, transition.to, assets);
        ctx.save();
        clipContent(ctx, scene);
        ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2;
        ctx.fillStyle = fill;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
        return;
      }
      case "wipe-left":
      case "wipe-right":
      case "wipe-up":
      case "wipe-down": {
        this.drawSource(scene, transition.from, assets);
        ctx.save();
        ctx.beginPath();
        if (transition.kind === "wipe-left") {
          ctx.rect(rect.x + rect.w * (1 - p), rect.y, rect.w * p, rect.h);
        } else if (transition.kind === "wipe-right") {
          ctx.rect(rect.x, rect.y, rect.w * p, rect.h);
        } else if (transition.kind === "wipe-up") {
          ctx.rect(rect.x, rect.y + rect.h * (1 - p), rect.w, rect.h * p);
        } else {
          ctx.rect(rect.x, rect.y, rect.w, rect.h * p);
        }
        ctx.clip();
        this.drawSource(scene, transition.to, assets);
        ctx.restore();
        return;
      }
      case "slide-left":
        this.drawSlide(scene, transition, assets, -rect.w * p, rect.w * (1 - p), 0, 0);
        return;
      case "slide-right":
        this.drawSlide(scene, transition, assets, rect.w * p, -rect.w * (1 - p), 0, 0);
        return;
      case "slide-up":
        this.drawSlide(scene, transition, assets, 0, 0, -rect.h * p, rect.h * (1 - p));
        return;
      case "slide-down":
        this.drawSlide(scene, transition, assets, 0, 0, rect.h * p, -rect.h * (1 - p));
        return;
      case "circle-open":
        this.drawSource(scene, transition.from, assets);
        this.drawCircleClippedSource(scene, transition.to, assets, p);
        return;
      case "circle-close":
        this.drawSource(scene, transition.to, assets);
        this.drawCircleClippedSource(scene, transition.from, assets, 1 - p);
        return;
      default:
        assertNever(transition.kind);
    }
  }

  private drawSlide(
    scene: EvaluatedScene,
    transition: EvaluatedTransition,
    assets: CanonicalRenderAssets,
    fromX: number,
    toX: number,
    fromY: number,
    toY: number,
  ): void {
    this.ctx.save();
    clipContent(this.ctx, scene);
    this.drawSource(scene, transition.from, assets, 1, fromX, fromY);
    this.drawSource(scene, transition.to, assets, 1, toX, toY);
    this.ctx.restore();
  }

  private drawCircleClippedSource(
    scene: EvaluatedScene,
    source: EvaluatedSource,
    assets: CanonicalRenderAssets,
    progress: number,
  ): void {
    const rect = scene.content_rect;
    const radius = Math.hypot(rect.w, rect.h) * clamp01(progress) * 0.75;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, radius, 0, Math.PI * 2);
    this.ctx.clip();
    this.drawSource(scene, source, assets);
    this.ctx.restore();
  }

  private drawHighlight(
    scene: EvaluatedScene,
    highlight: EvaluatedHighlight,
    assets: CanonicalRenderAssets,
  ): void {
    if (highlight.alpha <= 0) return;
    const ctx = this.ctx;
    const rect = highlight.bounds
      ? {
          x: highlight.bounds.x - highlight.padding_px,
          y: highlight.bounds.y - highlight.padding_px,
          w: highlight.bounds.w + highlight.padding_px * 2,
          h: highlight.bounds.h + highlight.padding_px * 2,
        }
      : null;
    ctx.save();
    ctx.globalAlpha = highlight.alpha;
    switch (highlight.spec.shape) {
      case "ring":
        ctx.strokeStyle = rgba(highlight.spec.color);
        ctx.lineWidth = highlight.stroke_px;
        ctx.shadowColor = rgba(highlight.spec.color, 0.75);
        ctx.shadowBlur = highlight.glow_px;
        if (rect) roundedRectPath(ctx, rect, highlight.spec.radius_px * scene.zoom.scale);
        else {
          ctx.beginPath();
          ctx.arc(highlight.center.x, highlight.center.y, highlight.radius_px, 0, Math.PI * 2);
        }
        ctx.stroke();
        break;
      case "spotlight":
        ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
        ctx.beginPath();
        ctx.rect(0, 0, scene.output_width, scene.output_height);
        if (rect) roundedRectSubpath(ctx, rect, highlight.spec.radius_px * scene.zoom.scale);
        else {
          ctx.moveTo(highlight.center.x + highlight.radius_px, highlight.center.y);
          ctx.arc(highlight.center.x, highlight.center.y, highlight.radius_px, 0, Math.PI * 2);
        }
        ctx.fill("evenodd");
        break;
      default:
        assertNever(highlight.spec.shape);
    }
    ctx.restore();

    if (highlight.spec.png_path) {
      const image = assets.image(highlight.spec.png_path);
      if (!image)
        throw new Error(`canonical highlight PNG is not loaded: ${highlight.spec.png_path}`);
      const dimensions = sourceDimensions(image, highlight.radius_px * 2, highlight.radius_px * 2);
      const overlay = highlight.spec.overlay_pos;
      const x = overlay
        ? Math.abs(overlay.x) <= 1
          ? overlay.x * scene.output_width
          : overlay.x
        : highlight.center.x;
      const y = overlay
        ? Math.abs(overlay.y) <= 1
          ? overlay.y * scene.output_height
          : overlay.y
        : highlight.center.y;
      this.prepareImageScaling(ctx);
      ctx.drawImage(image, x - dimensions.width / 2, y - dimensions.height / 2);
    }
  }

  private drawRipple(ripple: EvaluatedRipple): void {
    if (ripple.alpha <= 0) return;
    this.ctx.save();
    this.ctx.globalAlpha = ripple.alpha;
    this.ctx.strokeStyle = rgba(ripple.color);
    this.ctx.lineWidth = 3;
    if (ripple.bounds) roundedRectPath(this.ctx, ripple.bounds, ripple.radius_px);
    else {
      this.ctx.beginPath();
      this.ctx.arc(ripple.center.x, ripple.center.y, ripple.radius_px, 0, Math.PI * 2);
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawCursor(
    scene: EvaluatedScene,
    cursor: EvaluatedCursor,
    assets: CanonicalRenderAssets,
  ): void {
    if (cursor.png_frame_index != null) {
      const frame = assets.cursorPngFrame(cursor.node.id, cursor.png_frame_index);
      if (!frame) {
        throw new Error(
          `canonical cursor PNG frame is not loaded: ${cursor.node.id}:${cursor.png_frame_index}`,
        );
      }
      this.drawTintedImage(
        frame,
        { x: 0, y: 0, w: scene.output_width, h: scene.output_height },
        cursor.node.color_tint,
      );
      return;
    }
    const sample = cursor.sample;
    const point = cursor.output_point;
    if (!sample || !point) return;
    const outputScale = cursorClickEffectRenderScale(scene.output_width, scene.output_height);
    const sizeScale = Math.max(0.1, cursor.node.size_scale || 1);
    for (const feedback of sample.clickFeedback) {
      const transformed = applyZoomToNormalizedPoint(
        feedback,
        scene.zoom,
        scene.output_width,
        scene.output_height,
      );
      const x = scene.content_rect.x + transformed.x * scene.content_rect.w;
      const y = scene.content_rect.y + transformed.y * scene.content_rect.h;
      for (const primitive of feedback.primitives) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(
          x,
          y,
          primitive.radius * outputScale * sizeScale * scene.zoom.scale,
          0,
          Math.PI * 2,
        );
        if (primitive.fillOpacity > 0) {
          this.ctx.globalAlpha = primitive.fillOpacity;
          this.ctx.fillStyle = primitive.foreground;
          this.ctx.shadowColor = primitive.foreground;
          this.ctx.shadowBlur = primitive.glowBlur * outputScale;
          this.ctx.fill();
        }
        if (primitive.opacity > 0 && primitive.strokeWidth > 0) {
          this.ctx.globalAlpha = primitive.opacity;
          this.ctx.shadowColor = "transparent";
          this.ctx.lineWidth =
            (primitive.strokeWidth + CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX) * outputScale;
          this.ctx.strokeStyle = primitive.contrast;
          this.ctx.stroke();
          this.ctx.lineWidth = primitive.strokeWidth * outputScale;
          this.ctx.strokeStyle = primitive.foreground;
          this.ctx.shadowColor = primitive.foreground;
          this.ctx.shadowBlur = primitive.glowBlur * outputScale;
          this.ctx.stroke();
        }
        this.ctx.restore();
      }
    }

    const image = assets.cursorSkin(cursor.node.skin);
    if (!image) throw new Error(`canonical cursor skin is not loaded: ${cursor.node.skin}`);
    const size = CURSOR_BASE_SIZE_PX * sizeScale * outputScale;
    const hotspot = CURSOR_HOTSPOT_PX * sizeScale * outputScale;
    this.ctx.save();
    this.ctx.translate(point.x, point.y);
    this.ctx.scale(sample.cursorScale, sample.cursorScale);
    this.drawTintedImage(
      image,
      { x: -hotspot, y: -hotspot, w: size, h: size },
      cursor.node.color_tint,
    );
    this.ctx.restore();
  }

  private drawTintedImage(
    image: CanvasImageSource,
    rect: SceneRect,
    tint: ExportRgba | null,
  ): void {
    if (!tint || tint.a <= 0) {
      this.prepareImageScaling();
      this.ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
      return;
    }
    const width = Math.max(1, Math.ceil(rect.w));
    const height = Math.max(1, Math.ceil(rect.h));
    const scratch = this.createScratchCanvas(width, height);
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) throw new Error("canonical color tint scratch context is unavailable");
    scratchCtx.clearRect(0, 0, width, height);
    this.prepareImageScaling(scratchCtx);
    scratchCtx.drawImage(image, 0, 0, width, height);
    scratchCtx.globalCompositeOperation = "source-in";
    scratchCtx.fillStyle = rgba(tint);
    scratchCtx.fillRect(0, 0, width, height);
    scratchCtx.globalCompositeOperation = "source-over";
    this.prepareImageScaling();
    this.ctx.drawImage(scratch, rect.x, rect.y, rect.w, rect.h);
  }

  private drawText(scene: EvaluatedScene, text: EvaluatedText): void {
    if (text.alpha <= 0) return;
    const box = text.box;
    const ctx = this.ctx;
    const outputScale = canonical1080pScale(scene.output_height);
    const spacing = clampAuthoredMetric(box.letter_spacing_px, -4, 20, 0) * outputScale;
    const maxWidth =
      scene.output_width * (Math.max(20, Math.min(100, box.max_width_pct || 78)) / 100);
    ctx.save();
    ctx.font = canvasFont(box, outputScale);
    const lines = wrapText(ctx, box.text, maxWidth, spacing).map((value) => ({
      value,
      width: textWidth(ctx, value, spacing),
    }));
    const layoutWidth = Math.max(1, ...lines.map((line) => line.width));
    const lineHeight =
      normalizedFontSize(box) * outputScale * Math.max(0.8, Math.min(2, box.line_height || 1.12));
    const layoutHeight = lineHeight * lines.length;
    const x = text.pos.x * scene.output_width;
    const y = text.pos.y * scene.output_height;
    ctx.globalAlpha = text.alpha;
    ctx.translate(x, y + text.translate_y_px);
    ctx.scale(text.scale, text.scale);
    ctx.font = canvasFont(box, outputScale);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const padding = box.box_style
      ? clampAuthoredMetric(box.box_style.padding_px, 0, 64) * outputScale
      : 0;
    const totalWidth = layoutWidth + padding * 2;
    const origin = textHorizontalOrigin(text.pos.x);
    const left = origin === "left" ? 0 : origin === "right" ? -totalWidth : -totalWidth / 2;
    const contentLeft = left + padding;
    if (box.box_style) {
      const rect = {
        x: left,
        y: -layoutHeight / 2 - padding,
        w: layoutWidth + padding * 2,
        h: layoutHeight + padding * 2,
      };
      setShadow(ctx, box.box_style.shadow, outputScale);
      roundedRectPath(
        ctx,
        rect,
        clampAuthoredMetric(box.box_style.radius_px, 0, 999) * outputScale,
      );
      ctx.fillStyle = rgba(box.box_style.bg_color);
      ctx.fill();
      setShadow(ctx, null, outputScale);
      if (box.box_style.border_color && box.box_style.border_width_px > 0) {
        ctx.strokeStyle = rgba(box.box_style.border_color);
        ctx.lineWidth = clampAuthoredMetric(box.box_style.border_width_px, 0, 8) * outputScale;
        ctx.stroke();
      }
    }

    ctx.fillStyle = rgba(box.color);
    setShadow(ctx, box.text_shadow, outputScale);
    lines.forEach((line, index) => {
      const lineX =
        box.align === "left"
          ? contentLeft
          : box.align === "right"
            ? contentLeft + layoutWidth - line.width
            : contentLeft + (layoutWidth - line.width) / 2;
      const lineY = -layoutHeight / 2 + lineHeight * (index + 0.5);
      drawSpacedText(ctx, line.value, lineX, lineY, spacing);
    });
    ctx.restore();
  }
}

export const CANONICAL_TRANSITION_KINDS = [
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
] as const satisfies readonly ExportTransitionKind[];
