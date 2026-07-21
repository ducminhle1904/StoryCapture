/**
 * PreviewPlayer — owns the post-production preview surface:
 *   - default path displays the source through native <video>
 *   - composited mode uses the canonical graph/Canvas renderer shared with export
 *   - syncs `<video>.currentTime = playheadMs / 1000` on every scrub
 *
 * Native video remains available for lightweight harnesses. The production
 * post-production surface opts into composited mode.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import previewBackdrop from "@/assets/gradients/forest-emerald.png";
import type { RecordingActions } from "@/ipc/actions";
import type {
  CaptureRect,
  RecordingStepTimingSidecar,
  RecordingTrajectory,
} from "@/ipc/trajectory";
import { frontendLog } from "@/lib/log";
import { computeGraph } from "../state/compute-graph";
import {
  CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX,
  CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK,
  CURSOR_CLICK_EFFECT_MAX_PRIMITIVES,
  cursorClickEffectRenderScale,
} from "../state/cursor-click-effect";
import {
  identitySourceTimelineMap,
  type SourceTimelineMap,
  sourcePtsUsToTimelineMs,
  timelineMsToSourcePtsUs,
} from "../state/source-timeline-map";
import { type EditorBackgroundKind, readEditorBackground, useEditorStore } from "../state/store";
import {
  activeCursorClip,
  isActionsCursorClip,
  resolveTextAnchorPosition,
} from "../state/text-anchor";
import {
  type ResolvedTextStyle,
  resolvedTextStyle,
  type TextStylePreset,
  textFontCss,
  textHorizontalOrigin,
} from "../state/text-style";
import type {
  AnnotationClip,
  CursorClip,
  CursorMotionPreset,
  CursorSkin,
} from "../state/timeline-slice";
import {
  buildVirtualCursorSchedule,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";
import {
  applyZoomToBounds,
  applyZoomToPoint,
  normalizedZoomCropTopLeft,
  type ResolvedZoomMotion,
  resolveZoomMotion,
  sampleResolvedZoom,
} from "../state/zoom-motion";
import { CanonicalPreviewAdapter, fitCanonicalCompositionRect } from "./canonical-preview-adapter";
import { PresentedMediaClock } from "./presented-media-clock";
import { TransportControls } from "./transport-controls";
import { samplePreparedVirtualCursor, sampleTrajectoryCursor } from "./virtual-cursor-path";

type PreviewOutputMode = "native-video" | "composited-canvas";

const DEFAULT_PREVIEW_OUTPUT_MODE: PreviewOutputMode = "native-video";
const NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS = 16;
const COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS = 100;
const MEDIA_SYNC_EPSILON_MS = 80;
const PRESENTED_FRAME_STALE_MIN_MS = 120;
const PRESENTED_FRAME_STALE_FRAME_COUNT = 3;
const TIMELINE_END_EPSILON_MS = 16;
const PREVIEW_FRAME_SCALE = 0.86;
const AMBIENT_SAMPLE_WIDTH = 40;
const AMBIENT_SAMPLE_HEIGHT = 22;
const AMBIENT_SAMPLE_INTERVAL_MS = 90;
const AMBIENT_FRAME_SMOOTHING = 0.13;
const CURSOR_BASE_SIZE_PX = 32;
const CURSOR_CLICK_FEEDBACK_NODE_KEYS = Array.from(
  { length: CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK * CURSOR_CLICK_EFFECT_MAX_PRIMITIVES },
  (_, index) =>
    `feedback-${Math.floor(index / CURSOR_CLICK_EFFECT_MAX_PRIMITIVES)}-primitive-${index % CURSOR_CLICK_EFFECT_MAX_PRIMITIVES}`,
);
const CURSOR_HOTSPOT_OFFSET_PX = 1;
const SOURCE_HOLD_EPSILON_SECONDS = 0.001;
const TEXT_DRAG_OVERSCAN = 0.25;
const MIN_HIGHLIGHT_BOUNDS_SIZE = 0.0001;
const MEDIA_RETRY_DELAYS_MS = [400, 800, 1600] as const;

function mediaSrcForGeneration(src: string | undefined, generation: number): string | undefined {
  if (!src || generation === 0) return src;
  try {
    const url = new URL(src);
    url.searchParams.set("storycapture_preview_retry", String(generation));
    return url.toString();
  } catch {
    return src;
  }
}

function presentedFrameStaleAfterMs(outputFps: number): number {
  const frameDurationMs = 1000 / Math.max(1, outputFps);
  return Math.max(
    PRESENTED_FRAME_STALE_MIN_MS,
    frameDurationMs * PRESENTED_FRAME_STALE_FRAME_COUNT,
  );
}

function cursorScheduleKey(preset: CursorMotionPreset, preserveFullMotion: boolean): string {
  return `${preset}:${preserveFullMotion ? "preserve" : "compress"}`;
}

const cursorSkinAssets = import.meta.glob("../../../../../../assets/cursor-skins/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface AmbientPalette {
  left: Rgb;
  center: Rgb;
  right: Rgb;
}

interface WeightedRgbAccumulator {
  r: number;
  g: number;
  b: number;
  weight: number;
}

type HighlightSpec = NonNullable<AnnotationClip["highlight"]>;
type HighlightBounds = NonNullable<HighlightSpec["bounds"]>;

const DEFAULT_AMBIENT_PALETTE: AmbientPalette = {
  left: { r: 32, g: 38, b: 48 },
  center: { r: 22, g: 25, b: 31 },
  right: { r: 42, g: 38, b: 34 },
};

export interface PreviewPlayerProps {
  storyId: string;
  /** Absolute or asset:// path to the recorded source video. */
  videoSrc?: string;
  width?: number;
  height?: number;
  outputMode?: PreviewOutputMode;
  actions?: RecordingActions | null;
  trajectory?: RecordingTrajectory | null;
  stepTiming?: RecordingStepTimingSidecar | null;
  captureRect?: CaptureRect | null;
}

function safeAspect(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 16 / 9;
  }
  return width / height;
}

function mediaDurationMs(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0;
}

function isAtTimelineEnd(playheadMs: number, durationMs: number): boolean {
  return (
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    playheadMs >= durationMs - TIMELINE_END_EPSILON_MS
  );
}

function mediaSecondsForPlayhead(
  video: HTMLVideoElement,
  playheadMs: number,
  sourceTimeMap: SourceTimelineMap,
): number {
  const requestedSeconds =
    (timelineMsToSourcePtsUs(sourceTimeMap, Math.max(0, playheadMs)) ??
      Math.max(0, playheadMs) * 1000) / 1_000_000;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return requestedSeconds;
  return Math.min(requestedSeconds, Math.max(0, video.duration - SOURCE_HOLD_EPSILON_SECONDS));
}

function sourcePtsUsForPlayhead(playheadMs: number, sourceTimeMap: SourceTimelineMap): number {
  return (
    timelineMsToSourcePtsUs(sourceTimeMap, Math.max(0, playheadMs)) ??
    Math.max(0, playheadMs) * 1000
  );
}

function isSourceHoldAt(sourceTimeMap: SourceTimelineMap, playheadMs: number): boolean {
  return sourceTimeMap.segments.some(
    (segment) =>
      segment.kind === "hold" &&
      playheadMs >= segment.timelineStartMs &&
      playheadMs < segment.timelineEndMs,
  );
}

function timelinePlaybackDurationMs(video: HTMLVideoElement, timelineDurationMs: number): number {
  if (Number.isFinite(timelineDurationMs) && timelineDurationMs > 0) {
    return timelineDurationMs;
  }
  const sourceDurationMs = mediaDurationMs(video);
  return sourceDurationMs > 0 ? sourceDurationMs : Number.POSITIVE_INFINITY;
}

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function luminance(color: Rgb): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function rgbCss(color: Rgb, alpha: number): string {
  return `rgba(${clamp255(color.r)}, ${clamp255(color.g)}, ${clamp255(color.b)}, ${alpha})`;
}

function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

function ambientBackground(palette: AmbientPalette): string {
  return `radial-gradient(circle at 20% 30%, ${rgbCss(
    palette.left,
    0.68,
  )}, transparent 42%), radial-gradient(circle at 80% 28%, ${rgbCss(
    palette.right,
    0.62,
  )}, transparent 44%), radial-gradient(circle at 50% 78%, ${rgbCss(
    palette.center,
    0.36,
  )}, transparent 48%), linear-gradient(135deg, #111317 0%, #0b0c0f 100%)`;
}

function smoothPalette(prev: AmbientPalette, next: AmbientPalette, amount: number): AmbientPalette {
  return {
    left: mixRgb(prev.left, next.left, amount),
    center: mixRgb(prev.center, next.center, amount),
    right: mixRgb(prev.right, next.right, amount),
  };
}

function enhanceAmbientColor(input: Rgb): Rgb {
  const lum = luminance(input);
  const boosted: Rgb = {
    r: lum + (input.r - lum) * 1.36,
    g: lum + (input.g - lum) * 1.36,
    b: lum + (input.b - lum) * 1.36,
  };
  if (lum > 210) return mixRgb(boosted, { r: 86, g: 90, b: 98 }, 0.38);
  if (lum > 174) return mixRgb(boosted, { r: 48, g: 52, b: 58 }, 0.28);
  if (lum < 28) return mixRgb(boosted, { r: 58, g: 68, b: 84 }, 0.32);
  return boosted;
}

function createAccumulator(): WeightedRgbAccumulator {
  return { r: 0, g: 0, b: 0, weight: 0 };
}

function addWeightedSample(acc: WeightedRgbAccumulator, color: Rgb, weight: number): void {
  acc.r += color.r * weight;
  acc.g += color.g * weight;
  acc.b += color.b * weight;
  acc.weight += weight;
}

function averageWeightedSamples(acc: WeightedRgbAccumulator, fallback: Rgb): Rgb {
  if (acc.weight <= 0) return fallback;
  return enhanceAmbientColor({
    r: acc.r / acc.weight,
    g: acc.g / acc.weight,
    b: acc.b / acc.weight,
  });
}

function paletteFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): AmbientPalette {
  const left = createAccumulator();
  const center = createAccumulator();
  const right = createAccumulator();
  const fallback = createAccumulator();
  const leftCut = width * 0.52;
  const rightCut = width * 0.48;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const color = { r: pixels[i] ?? 0, g: pixels[i + 1] ?? 0, b: pixels[i + 2] ?? 0 };
      const lum = luminance(color);
      const max = Math.max(color.r, color.g, color.b);
      const min = Math.min(color.r, color.g, color.b);
      const saturation = (max - min) / 255;
      const brightnessPenalty = lum > 238 ? 0.34 : lum < 12 ? 0.22 : 1;
      const chromaWeight = 0.42 + saturation * 1.25;
      const verticalWeight = y < height * 0.18 || y > height * 0.82 ? 1.12 : 1;
      const weight = brightnessPenalty * chromaWeight * verticalWeight;

      addWeightedSample(fallback, color, Math.max(0.08, weight * 0.45));
      addWeightedSample(center, color, weight);
      if (x < leftCut) addWeightedSample(left, color, weight * (1 + (leftCut - x) / width));
      if (x > rightCut) addWeightedSample(right, color, weight * (1 + (x - rightCut) / width));
    }
  }

  const fallbackColor = averageWeightedSamples(fallback, DEFAULT_AMBIENT_PALETTE.center);
  return {
    left: averageWeightedSamples(left, fallbackColor),
    center: averageWeightedSamples(center, fallbackColor),
    right: averageWeightedSamples(right, fallbackColor),
  };
}

const GRADIENT_STAGE_BACKGROUNDS: Record<string, CSSProperties> = {
  "runway-dark": {
    background:
      "radial-gradient(circle at 22% 18%, rgba(255, 138, 92, 0.18), transparent 30%), radial-gradient(circle at 78% 76%, rgba(58, 86, 154, 0.22), transparent 34%), linear-gradient(135deg, #141414 0%, #0e1117 52%, #17130f 100%)",
  },
  "runway-light": {
    background:
      "radial-gradient(circle at 24% 22%, rgba(255, 178, 122, 0.22), transparent 32%), radial-gradient(circle at 78% 78%, rgba(136, 166, 207, 0.18), transparent 36%), linear-gradient(135deg, #fbfaf7 0%, #f3f0e9 52%, #f8fbff 100%)",
  },
  "linear-slate": {
    background:
      "radial-gradient(circle at 72% 20%, rgba(107, 123, 145, 0.24), transparent 32%), linear-gradient(135deg, #161a20 0%, #222730 48%, #121418 100%)",
  },
  "elevenlabs-violet": {
    background:
      "radial-gradient(circle at 22% 18%, rgba(168, 135, 255, 0.22), transparent 34%), radial-gradient(circle at 82% 74%, rgba(255, 160, 183, 0.16), transparent 36%), linear-gradient(135deg, #1a1720 0%, #141116 100%)",
  },
  "warm-sunset": {
    background:
      "radial-gradient(circle at 24% 28%, rgba(255, 166, 102, 0.36), transparent 34%), radial-gradient(circle at 76% 72%, rgba(185, 84, 72, 0.24), transparent 38%), linear-gradient(135deg, #2a1713 0%, #161312 100%)",
  },
  "cool-ocean": {
    background:
      "radial-gradient(circle at 22% 20%, rgba(75, 141, 188, 0.26), transparent 34%), radial-gradient(circle at 78% 74%, rgba(97, 213, 199, 0.16), transparent 36%), linear-gradient(135deg, #10171d 0%, #0e1417 100%)",
  },
  "forest-emerald": {
    background:
      "radial-gradient(circle at 24% 24%, rgba(82, 183, 136, 0.22), transparent 34%), radial-gradient(circle at 78% 76%, rgba(206, 184, 126, 0.14), transparent 36%), linear-gradient(135deg, #121816 0%, #0f1411 100%)",
  },
  "solid-black": {
    background: "linear-gradient(135deg, #101010 0%, #171717 100%)",
  },
  "solid-white": {
    background: "linear-gradient(135deg, #f9faf8 0%, #f1f3f2 100%)",
  },
  "paper-grain": {
    background:
      "radial-gradient(circle at 26% 24%, rgba(196, 166, 112, 0.18), transparent 30%), linear-gradient(135deg, #f6f1e8 0%, #ebe5da 100%)",
  },
};

function rgbaCss(color: { r: number; g: number; b: number; a: number }): string {
  const alpha = Math.max(0, Math.min(1, color.a / 255));
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function mixChannel(a: number, b: number, amount: number): number {
  return Math.max(0, Math.min(255, Math.round(a + (b - a) * amount)));
}

function mixRgba(
  color: { r: number; g: number; b: number; a: number },
  target: { r: number; g: number; b: number },
  amount: number,
): string {
  return rgbaCss({
    r: mixChannel(color.r, target.r, amount),
    g: mixChannel(color.g, target.g, amount),
    b: mixChannel(color.b, target.b, amount),
    a: color.a,
  });
}

function resolvePreviewImageSrc(path: string): string {
  if (/^(?:https?:|data:|blob:|\/)/.test(path)) return path;
  return convertFileSrc(path);
}

function cursorSkinSrc(skin: CursorSkin): string | undefined {
  return cursorSkinAssets[`../../../../../../assets/cursor-skins/${skin}.png`];
}

function activeTextClips(clips: readonly AnnotationClip[], playheadMs: number): AnnotationClip[] {
  return clips.filter(
    (clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs,
  );
}

function activeHighlightClips(
  clips: readonly AnnotationClip[],
  playheadMs: number,
): AnnotationClip[] {
  return activeTextClips(clips, playheadMs).filter((clip) => clip.highlight);
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return "50%";
  return `${Math.round(value * 10_000) / 100}%`;
}

function textShadowCss(shadow: NonNullable<ResolvedTextStyle["textShadow"]>): string {
  return `${shadow.offsetXpx}px ${shadow.offsetYpx}px ${shadow.blurPx}px ${shadow.color}`;
}

function hasReliableHighlightBounds(
  bounds: HighlightBounds | null | undefined,
): bounds is HighlightBounds {
  if (!bounds) return false;
  const { x, y, w, h } = bounds;
  if (![x, y, w, h].every(Number.isFinite)) return false;
  if (w <= MIN_HIGHLIGHT_BOUNDS_SIZE || h <= MIN_HIGHLIGHT_BOUNDS_SIZE) return false;
  return x < 1 && y < 1 && x + w > 0 && y + h > 0;
}

function boundedHighlightStyle(
  bounds: HighlightBounds | null,
  paddingPx: number,
): CSSProperties | null {
  if (!hasReliableHighlightBounds(bounds)) return null;
  const safePaddingPx = Number.isFinite(paddingPx) ? Math.max(0, paddingPx) : 0;
  return {
    left: `calc(${percent(bounds.x)} - ${safePaddingPx}px)`,
    top: `calc(${percent(bounds.y)} - ${safePaddingPx}px)`,
    width: `calc(${percent(bounds.w)} + ${safePaddingPx * 2}px)`,
    height: `calc(${percent(bounds.h)} + ${safePaddingPx * 2}px)`,
    transform: "translate3d(0, 0, 0)",
    boxSizing: "border-box",
  };
}

type CursorStyleKey = "height" | "left" | "opacity" | "top" | "transform" | "width";

function setStyleValue(style: CSSStyleDeclaration, key: CursorStyleKey, value: string) {
  if (style[key] !== value) {
    style[key] = value;
  }
}

function cursorRenderScale(frame: HTMLDivElement | null): number {
  const rect = frame?.getBoundingClientRect();
  const renderedWidth = frame?.clientWidth || rect?.width || 0;
  const renderedHeight = frame?.clientHeight || rect?.height || 0;
  return cursorClickEffectRenderScale(renderedWidth, renderedHeight);
}

function colorWithAlpha(hex: string, alpha: number): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const [, red = "00", green = "00", blue = "00"] = match;
  return `rgba(${Number.parseInt(red, 16)}, ${Number.parseInt(green, 16)}, ${Number.parseInt(
    blue,
    16,
  )}, ${Math.max(0, Math.min(1, alpha))})`;
}

function hideClickFeedbackNode(node: HTMLDivElement | null) {
  if (!node) return;
  node.style.opacity = "0";
  node.style.visibility = "hidden";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampTextPosition(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(-TEXT_DRAG_OVERSCAN, Math.min(1 + TEXT_DRAG_OVERSCAN, value));
}

function textTranslateX(posX: number): string {
  const origin = textHorizontalOrigin(posX);
  if (origin === "left") return "0%";
  if (origin === "right") return "-100%";
  return "-50%";
}

function textMotionStyle(
  animation: TextStylePreset["animation"],
  clip: AnnotationClip,
  playheadMs: number,
  posX: number,
): CSSProperties {
  const horizontalOrigin = textHorizontalOrigin(posX);
  const duration = Math.max(1, animation.durationMs);
  const inProgress = clamp01((playheadMs - clip.startMs) / duration);
  const outProgress = clamp01((clip.startMs + clip.durationMs - playheadMs) / duration);
  let opacity = 1;
  let yPx = 0;
  let scale = 1;

  if (animation.in === "fade") opacity = Math.min(opacity, inProgress);
  if (animation.in === "slide-up") {
    opacity = Math.min(opacity, inProgress);
    yPx += (1 - inProgress) * 12;
  }
  if (animation.in === "scale-in") {
    opacity = Math.min(opacity, inProgress);
    scale = 0.94 + inProgress * 0.06;
  }
  if (animation.out === "fade") opacity = Math.min(opacity, outProgress);

  return {
    opacity,
    transform: `translate(${textTranslateX(posX)}, calc(-50% + ${yPx}px)) scale(${scale})`,
    transformOrigin: `${horizontalOrigin} center`,
  };
}

function updateAnnotationClipDirect(clipId: string, patch: Partial<AnnotationClip>) {
  useEditorStore.setState((state) => ({
    tracks: {
      ...state.tracks,
      annotations: state.tracks.annotations.map((clip) =>
        clip.id === clipId ? { ...clip, ...patch } : clip,
      ),
    },
  }));
}

function stageBackgroundStyle(background: EditorBackgroundKind): CSSProperties {
  if (background.kind === "solid") {
    const color = rgbaCss(background.color);
    const lifted = mixRgba(background.color, { r: 255, g: 255, b: 255 }, 0.18);
    const shaded = mixRgba(background.color, { r: 0, g: 0, b: 0 }, 0.24);
    return {
      background: `radial-gradient(circle at 26% 20%, ${lifted}, transparent 34%), linear-gradient(135deg, ${color}, ${shaded})`,
    };
  }
  if (background.kind === "gradient") {
    return (
      GRADIENT_STAGE_BACKGROUNDS[background.preset_id] ?? GRADIENT_STAGE_BACKGROUNDS["runway-dark"]
    );
  }
  if (background.kind === "image") {
    return {
      backgroundImage: `linear-gradient(180deg, rgba(8, 10, 12, 0.10), rgba(8, 10, 12, 0.24)), url("${resolvePreviewImageSrc(background.path)}")`,
      backgroundPosition: "center",
      backgroundSize: "cover",
    };
  }
  return {
    background:
      "radial-gradient(circle at 24% 18%, color-mix(in oklch, var(--color-accent) 12%, transparent), transparent 34%), linear-gradient(135deg, color-mix(in oklch, var(--color-background-surface) 96%, var(--color-text-primary) 4%), color-mix(in oklch, var(--color-background-card) 95%, var(--color-text-primary) 5%))",
  };
}

export function PreviewPlayer({
  storyId,
  videoSrc,
  width = 1920,
  height = 1080,
  outputMode = DEFAULT_PREVIEW_OUTPUT_MODE,
  actions = null,
  trajectory = null,
  stepTiming = null,
  captureRect = null,
}: PreviewPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ambientLayerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewFrameContentRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cursorRef = useRef<HTMLImageElement | null>(null);
  const cursorClickFeedbackRefs = useRef<Array<HTMLDivElement | null>>([]);
  const ambientVideoRef = useRef<HTMLVideoElement | null>(null);
  const ambientSampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ambientDisplayedPaletteRef = useRef<AmbientPalette>(DEFAULT_AMBIENT_PALETTE);
  const ambientTargetPaletteRef = useRef<AmbientPalette>(DEFAULT_AMBIENT_PALETTE);
  const engineRef = useRef<CanonicalPreviewAdapter | null>(null);
  const rafRef = useRef<number | null>(null);
  const ambientRafRef = useRef<number | null>(null);
  const ambientLastSampleTimeRef = useRef(0);
  const lastPlayheadCommitRef = useRef(0);
  const presentedPlayheadRef = useRef(0);
  const presentedClockRef = useRef<PresentedMediaClock | null>(null);
  const lastPresentedFrameAtRef = useRef(0);
  const presentedFrameAwaitingRef = useRef(false);
  const clockFallbackActiveRef = useRef(false);
  const clockFallbackStartedAtRef = useRef(0);
  const sourceTimeMapRef = useRef<SourceTimelineMap>(identitySourceTimelineMap(0));
  const mediaRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRetryCountRef = useRef(0);
  const lastMediaErrorGenerationRef = useRef<number | null>(null);
  const canonicalRenderGenerationRef = useRef(0);
  const canonicalRenderPendingRef = useRef<number | null>(null);
  const canonicalRenderActiveRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [mediaSourceGeneration, setMediaSourceGeneration] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  const [canonicalError, setCanonicalError] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [ambientSamplingReady, setAmbientSamplingReady] = useState(false);
  const [editingTextClipId, setEditingTextClipId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [mediaAspect, setMediaAspect] = useState(() => safeAspect(width, height));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0, devicePixelRatio: 1 });
  const playingRef = useRef(false);
  const cursorClipsRef = useRef<CursorClip[]>([]);
  const cursorSchedulesRef = useRef(new Map<string, VirtualCursorSchedule | null>());
  const resolvedZoomMotionsRef = useRef<ResolvedZoomMotion[]>([]);
  const trajectoryRef = useRef<RecordingTrajectory | null>(trajectory);
  const durationMsRef = useRef(0);

  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const pushAction = useEditorStore((s) => s.pushAction);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const timelineTracks = useEditorStore((s) => s.tracks);
  const exportForm = useEditorStore((s) => s.exportForm);
  const undoExtras = useEditorStore((s) => s._undoExtras);
  const cursorClips = useEditorStore((s) => s.tracks.cursor);
  const videoClips = useEditorStore((s) => s.tracks.video);
  const zoomClips = useEditorStore((s) => s.tracks.zoom);
  const annotationClips = useEditorStore((s) => s.tracks.annotations);
  const cursorSchedules = useMemo(() => {
    const schedules = new Map<string, VirtualCursorSchedule | null>();
    if (!actions) return schedules;
    for (const clip of cursorClips) {
      const motionPreset = clip.motionPreset ?? "natural";
      const key = cursorScheduleKey(motionPreset, clip.preserveFullMotion ?? false);
      if (!isActionsCursorClip(clip) || schedules.has(key)) continue;
      schedules.set(
        key,
        buildVirtualCursorSchedule(actions, motionPreset, {
          preserveFullMotion: clip.preserveFullMotion,
        }),
      );
    }
    return schedules;
  }, [actions, cursorClips]);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const durationMs = useEditorStore((s) => s.durationMs);
  const sourceTimeMap = useMemo(
    () => videoClips[0]?.sourceTimeMap ?? identitySourceTimelineMap(Math.max(0, durationMs)),
    [durationMs, videoClips],
  );
  useEffect(() => {
    sourceTimeMapRef.current = sourceTimeMap;
    presentedClockRef.current = new PresentedMediaClock(sourceTimeMap);
  }, [sourceTimeMap]);
  const useCompositedCanvas = outputMode === "composited-canvas";
  const canonicalGraph = useMemo(
    () => computeGraph({ tracks: timelineTracks, exportForm, _undoExtras: undoExtras }),
    [exportForm, timelineTracks, undoExtras],
  );
  const displayReady = !useCompositedCanvas || engineReady;
  const editorBackground = useEditorStore(readEditorBackground);
  const stageStyle = useMemo(() => stageBackgroundStyle(editorBackground), [editorBackground]);
  const sortedTextClips = useMemo(
    () =>
      annotationClips
        .filter((clip) => clip.text.trim())
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)),
    [annotationClips],
  );
  const activeTextOverlays = useMemo(
    () => activeTextClips(sortedTextClips, playheadMs),
    [playheadMs, sortedTextClips],
  );
  const activeHighlights = useMemo(
    () => activeHighlightClips(annotationClips, playheadMs),
    [annotationClips, playheadMs],
  );
  const resolvedZoomMotions = useMemo(() => resolveZoomMotion(zoomClips), [zoomClips]);
  const previewZoom = useMemo(
    () => sampleResolvedZoom(resolvedZoomMotions, playheadMs),
    [playheadMs, resolvedZoomMotions],
  );
  const editingTextClip = useMemo(
    () => annotationClips.find((clip) => clip.id === editingTextClipId) ?? null,
    [annotationClips, editingTextClipId],
  );
  const displayAspect = useCompositedCanvas
    ? safeAspect(canonicalGraph.output_width, canonicalGraph.output_height)
    : mediaAspect;
  const frameStyle = useMemo<CSSProperties>(() => {
    if (useCompositedCanvas) {
      return { width: "100%", height: "100%" };
    }
    const frameScale = PREVIEW_FRAME_SCALE;
    const maxWidth = stageSize.width * frameScale;
    const maxHeight = stageSize.height * frameScale;
    if (maxWidth > 0 && maxHeight > 0) {
      const frameWidth = Math.min(maxWidth, maxHeight * displayAspect);
      const frameHeight = frameWidth / displayAspect;
      return {
        width: Math.round(frameWidth),
        height: Math.round(frameHeight),
      };
    }
    return {
      aspectRatio: `${displayAspect}`,
      maxHeight: `${frameScale * 100}%`,
      maxWidth: `${frameScale * 100}%`,
      width: `${frameScale * 100}%`,
    };
  }, [displayAspect, stageSize.height, stageSize.width, useCompositedCanvas]);
  const compositionInteractionStyle = useMemo<CSSProperties>(() => {
    if (!useCompositedCanvas || stageSize.width <= 0 || stageSize.height <= 0) {
      return { inset: 0 };
    }
    const rect = fitCanonicalCompositionRect(
      stageSize.width,
      stageSize.height,
      canonicalGraph.output_width,
      canonicalGraph.output_height,
    );
    return {
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
    };
  }, [
    canonicalGraph.output_height,
    canonicalGraph.output_width,
    stageSize.height,
    stageSize.width,
    useCompositedCanvas,
  ]);

  const resolvedSrc = videoSrc
    ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
      ? videoSrc
      : convertFileSrc(videoSrc)
    : undefined;
  const useDomAmbientBackdrop =
    !useCompositedCanvas && editorBackground.kind === "transparent" && Boolean(resolvedSrc);
  const mediaElementSrc = mediaSrcForGeneration(resolvedSrc, mediaSourceGeneration);
  const mediaSourceKey = mediaElementSrc ?? "empty";
  const presentedFrameStaleMs = presentedFrameStaleAfterMs(canonicalGraph.output_fps);

  const requestCanonicalFrame = useCallback((timestampMs: number) => {
    canonicalRenderPendingRef.current = Math.max(0, timestampMs);
    if (canonicalRenderActiveRef.current) return;

    const generation = canonicalRenderGenerationRef.current;
    canonicalRenderActiveRef.current = true;
    void (async () => {
      try {
        while (generation === canonicalRenderGenerationRef.current) {
          const pendingTimestampMs = canonicalRenderPendingRef.current;
          if (pendingTimestampMs === null) break;
          canonicalRenderPendingRef.current = null;
          const engine = engineRef.current;
          if (!engine) break;
          await engine.renderFrame(pendingTimestampMs);
        }
      } catch (error) {
        if (generation === canonicalRenderGenerationRef.current) {
          canonicalRenderPendingRef.current = null;
          setCanonicalError(true);
          frontendLog.warn(
            "post-production/PreviewPlayer",
            "Canonical preview frame render failed",
            { error },
          );
        }
      } finally {
        if (generation === canonicalRenderGenerationRef.current) {
          canonicalRenderActiveRef.current = false;
        }
      }
    })();
  }, []);

  const clearMediaRetryTimer = useCallback(() => {
    if (mediaRetryTimerRef.current === null) return;
    clearTimeout(mediaRetryTimerRef.current);
    mediaRetryTimerRef.current = null;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing the resolved source intentionally resets retry state.
  useEffect(() => {
    clearMediaRetryTimer();
    mediaRetryCountRef.current = 0;
    lastMediaErrorGenerationRef.current = null;
    setMediaError(false);
    setCanonicalError(false);
    playingRef.current = false;
    setPlaying(false);
    setMediaSourceGeneration(0);
    return clearMediaRetryTimer;
  }, [clearMediaRetryTimer, resolvedSrc]);

  const hideCursorOverlay = useCallback(() => {
    const cursor = cursorRef.current;
    if (cursor) cursor.style.opacity = "0";
    for (const node of cursorClickFeedbackRefs.current) hideClickFeedbackNode(node);
  }, []);

  const applyPreviewZoom = useCallback(
    (playheadMs: number) => {
      const frame = previewFrameContentRef.current;
      if (!frame) return;
      if (useCompositedCanvas) {
        frame.style.transformOrigin = "0 0";
        frame.style.transform = "none";
        return;
      }

      const zoom = sampleResolvedZoom(resolvedZoomMotionsRef.current, playheadMs);
      const crop = normalizedZoomCropTopLeft(zoom.center, zoom.scale);
      const width = frame.clientWidth || frame.getBoundingClientRect().width;
      const height = frame.clientHeight || frame.getBoundingClientRect().height;
      const tx = -crop.x * width * zoom.scale;
      const ty = -crop.y * height * zoom.scale;
      frame.style.transformOrigin = "0 0";
      frame.style.transform = `matrix(${zoom.scale}, 0, 0, ${zoom.scale}, ${tx}, ${ty})`;
    },
    [useCompositedCanvas],
  );

  const renderCursorOverlay = useCallback(
    (playheadMs: number) => {
      if (useCompositedCanvas) {
        hideCursorOverlay();
        return;
      }
      const cursor = cursorRef.current;
      const currentTrajectory = trajectoryRef.current;
      if (!cursor) {
        hideCursorOverlay();
        return;
      }

      const clip = activeCursorClip(cursorClipsRef.current, playheadMs);
      if (!clip) {
        hideCursorOverlay();
        return;
      }

      const relativeTimelineMs = Math.max(0, playheadMs - clip.startMs);
      const relativeMs =
        (timelineMsToSourcePtsUs(sourceTimeMapRef.current, relativeTimelineMs) ??
          relativeTimelineMs * 1000) / 1000;
      const motionPreset = clip.motionPreset ?? "natural";
      const sample = isActionsCursorClip(clip)
        ? samplePreparedVirtualCursor(
            cursorSchedulesRef.current.get(
              cursorScheduleKey(motionPreset, clip.preserveFullMotion ?? false),
            ),
            clip.preserveFullMotion ? relativeTimelineMs : relativeMs,
            clip.clickEffect,
          )
        : clip.trajectoryKind === "trajectory"
          ? sampleTrajectoryCursor(currentTrajectory, relativeMs)
          : null;
      const src = cursorSkinSrc(clip.skin);
      if (!sample || !src) {
        hideCursorOverlay();
        return;
      }

      if (cursor.getAttribute("src") !== src) cursor.setAttribute("src", src);
      const zoom = sampleResolvedZoom(resolvedZoomMotionsRef.current, playheadMs);
      const cursorPoint = applyZoomToPoint(sample, zoom);
      const renderScale = cursorRenderScale(previewFrameContentRef.current);
      const clipScale = Math.max(0.1, clip.sizeScale || 1);
      const size = CURSOR_BASE_SIZE_PX * clipScale * renderScale;
      const hotspot = CURSOR_HOTSPOT_OFFSET_PX * clipScale * renderScale;
      setStyleValue(cursor.style, "width", `${size}px`);
      setStyleValue(cursor.style, "height", `${size}px`);
      setStyleValue(cursor.style, "left", `${cursorPoint.x * 100}%`);
      setStyleValue(cursor.style, "top", `${cursorPoint.y * 100}%`);
      setStyleValue(cursor.style, "opacity", "1");
      cursor.style.transformOrigin = `${hotspot}px ${hotspot}px`;
      setStyleValue(
        cursor.style,
        "transform",
        `translate3d(-${hotspot}px, -${hotspot}px, 0) scale(${sample.cursorScale})`,
      );

      for (const node of cursorClickFeedbackRefs.current) hideClickFeedbackNode(node);
      const effectScale = renderScale * clipScale;
      for (
        let feedbackIndex = 0;
        feedbackIndex < CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK;
        feedbackIndex += 1
      ) {
        const feedback = sample.clickFeedback[feedbackIndex];
        if (!feedback) continue;
        const feedbackPoint = applyZoomToPoint({ x: feedback.x, y: feedback.y }, zoom);
        for (
          let primitiveIndex = 0;
          primitiveIndex < CURSOR_CLICK_EFFECT_MAX_PRIMITIVES;
          primitiveIndex += 1
        ) {
          const primitive = feedback.primitives[primitiveIndex];
          const nodeIndex = feedbackIndex * CURSOR_CLICK_EFFECT_MAX_PRIMITIVES + primitiveIndex;
          const node = cursorClickFeedbackRefs.current[nodeIndex];
          if (!primitive || !node) continue;
          const diameter = primitive.radius * 2 * effectScale;
          const strokeWidth = primitive.strokeWidth * effectScale;
          const contrastWidth = (CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX / 2) * effectScale;
          node.style.left = `${feedbackPoint.x * 100}%`;
          node.style.top = `${feedbackPoint.y * 100}%`;
          node.style.width = `${diameter}px`;
          node.style.height = `${diameter}px`;
          node.style.opacity = "1";
          node.style.visibility = "visible";
          node.style.transform = "translate3d(-50%, -50%, 0)";
          node.style.borderRadius = "50%";
          node.style.borderStyle = "solid";
          node.style.borderWidth = `${strokeWidth}px`;
          node.style.borderColor = colorWithAlpha(primitive.foreground, primitive.opacity);
          node.style.backgroundColor = colorWithAlpha(primitive.foreground, primitive.fillOpacity);
          node.style.boxShadow = `0 0 0 ${contrastWidth}px ${colorWithAlpha(
            primitive.contrast,
            primitive.opacity,
          )}, 0 0 ${
            primitive.glowBlur * effectScale
          }px ${colorWithAlpha(primitive.foreground, primitive.opacity)}`;
        }
      }
    },
    [hideCursorOverlay, useCompositedCanvas],
  );

  const applyAmbientPalette = useCallback((palette: AmbientPalette) => {
    const layer = ambientLayerRef.current;
    if (!layer) return;
    layer.style.background = ambientBackground(palette);
  }, []);

  const syncAmbientVideo = useCallback((timeSeconds: number) => {
    const ambientVideo = ambientVideoRef.current;
    if (!ambientVideo) return;
    if (Number.isFinite(timeSeconds)) {
      ambientVideo.currentTime = Math.max(0, timeSeconds);
    }
  }, []);

  const syncAmbientPlayback = useCallback((sourceVideo: HTMLVideoElement) => {
    const ambientVideo = ambientVideoRef.current;
    if (!ambientVideo) return;
    if (
      Math.abs(ambientVideo.currentTime - sourceVideo.currentTime) >
      MEDIA_SYNC_EPSILON_MS / 1000
    ) {
      ambientVideo.currentTime = sourceVideo.currentTime;
    }
  }, []);

  const sampleAmbientPalette = useCallback((): boolean => {
    const video = videoRef.current;
    if (!useDomAmbientBackdrop || !video || video.readyState < 2 || !video.videoWidth) return false;

    try {
      const canvas = ambientSampleCanvasRef.current ?? document.createElement("canvas");
      ambientSampleCanvasRef.current = canvas;
      canvas.width = AMBIENT_SAMPLE_WIDTH;
      canvas.height = AMBIENT_SAMPLE_HEIGHT;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;

      ctx.drawImage(video, 0, 0, AMBIENT_SAMPLE_WIDTH, AMBIENT_SAMPLE_HEIGHT);
      const pixels = ctx.getImageData(0, 0, AMBIENT_SAMPLE_WIDTH, AMBIENT_SAMPLE_HEIGHT).data;
      const sampled = paletteFromPixels(pixels, AMBIENT_SAMPLE_WIDTH, AMBIENT_SAMPLE_HEIGHT);
      ambientTargetPaletteRef.current = sampled;
      setAmbientSamplingReady(true);
      return true;
    } catch {
      setAmbientSamplingReady(false);
      return false;
    }
  }, [useDomAmbientBackdrop]);

  const seekPreviewToPlayhead = useCallback(
    (targetMs: number) => {
      const video = videoRef.current;
      if (!video) return;
      const nextMs = Math.max(0, targetMs);
      const nextSeconds = mediaSecondsForPlayhead(video, nextMs, sourceTimeMapRef.current);

      video.currentTime = nextSeconds;
      if (!useCompositedCanvas) {
        syncAmbientVideo(nextSeconds);
        if (sampleAmbientPalette()) {
          ambientDisplayedPaletteRef.current = smoothPalette(
            ambientDisplayedPaletteRef.current,
            ambientTargetPaletteRef.current,
            0.55,
          );
          applyAmbientPalette(ambientDisplayedPaletteRef.current);
        }
      }
      lastPlayheadCommitRef.current = nextMs;
      if (typeof video.requestVideoFrameCallback !== "function") {
        const fallback = presentedClockRef.current?.commitPresentedFrame(
          Math.max(0, Math.round(video.currentTime * 1_000_000)),
        );
        const fallbackTimelineMs = fallback?.timelineMs ?? nextMs;
        presentedPlayheadRef.current = fallbackTimelineMs;
        applyPreviewZoom(fallbackTimelineMs);
        renderCursorOverlay(fallbackTimelineMs);
        if (useCompositedCanvas) {
          requestCanonicalFrame(fallbackTimelineMs);
        }
      }
    },
    [
      applyAmbientPalette,
      applyPreviewZoom,
      requestCanonicalFrame,
      renderCursorOverlay,
      sampleAmbientPalette,
      syncAmbientVideo,
      useCompositedCanvas,
    ],
  );

  // Keep the canonical renderer dormant for native-video harnesses.
  useEffect(() => {
    const retryGeneration = mediaSourceGeneration;
    if (!useCompositedCanvas) {
      canonicalRenderGenerationRef.current += 1;
      canonicalRenderPendingRef.current = null;
      canonicalRenderActiveRef.current = false;
      engineRef.current?.dispose();
      engineRef.current = null;
      setEngineReady(false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const generation = canonicalRenderGenerationRef.current + 1;
    canonicalRenderGenerationRef.current = generation;
    canonicalRenderPendingRef.current = null;
    canonicalRenderActiveRef.current = false;
    setEngineReady(false);
    setCanonicalError(false);
    const engine = new CanonicalPreviewAdapter(canvas);
    const stageBounds = stageRef.current?.getBoundingClientRect();
    if (stageBounds && stageBounds.width > 0 && stageBounds.height > 0) {
      engine.setPresentationViewport({
        width: stageBounds.width,
        height: stageBounds.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    }
    engine
      .configure(canonicalGraph)
      .then(() => {
        if (disposed) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setEngineReady(true);
        requestCanonicalFrame(useEditorStore.getState().playheadMs);
      })
      .catch((err) => {
        if (disposed) return;
        setCanonicalError(true);
        frontendLog.warn(
          "post-production/PreviewPlayer",
          "Canonical preview initialization failed",
          { error: err, fields: { retry_generation: retryGeneration } },
        );
      });
    return () => {
      disposed = true;
      canonicalRenderGenerationRef.current += 1;
      canonicalRenderPendingRef.current = null;
      canonicalRenderActiveRef.current = false;
      if (engineRef.current === engine) engineRef.current = null;
      engine.dispose();
      setEngineReady(false);
    };
  }, [canonicalGraph, mediaSourceGeneration, requestCanonicalFrame, useCompositedCanvas]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  useEffect(() => {
    cursorClipsRef.current = cursorClips;
    cursorSchedulesRef.current = cursorSchedules;
    trajectoryRef.current = trajectory;
    const playheadMs = useEditorStore.getState().playheadMs;
    applyPreviewZoom(playheadMs);
    renderCursorOverlay(playheadMs);
  }, [applyPreviewZoom, cursorClips, cursorSchedules, renderCursorOverlay, trajectory]);

  useEffect(() => {
    resolvedZoomMotionsRef.current = resolvedZoomMotions;
    applyPreviewZoom(useEditorStore.getState().playheadMs);
  }, [applyPreviewZoom, resolvedZoomMotions]);

  useEffect(() => {
    setMediaAspect(safeAspect(width, height));
  }, [width, height]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: stage resizing intentionally reapplies zoom and cursor geometry.
  useEffect(() => {
    const playheadMs = useEditorStore.getState().playheadMs;
    applyPreviewZoom(playheadMs);
    renderCursorOverlay(playheadMs);
  }, [applyPreviewZoom, renderCursorOverlay, stageSize]);

  useEffect(() => {
    if (!useCompositedCanvas || !engineReady || stageSize.width <= 0 || stageSize.height <= 0) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPresentationViewport(stageSize);
    requestCanonicalFrame(useEditorStore.getState().playheadMs);
  }, [engineReady, requestCanonicalFrame, stageSize, useCompositedCanvas]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateStageSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize((prev) => {
        const nextWidth = Math.round(rect.width);
        const nextHeight = Math.round(rect.height);
        const nextDevicePixelRatio = window.devicePixelRatio || 1;
        if (
          prev.width === nextWidth &&
          prev.height === nextHeight &&
          prev.devicePixelRatio === nextDevicePixelRatio
        ) {
          return prev;
        }
        return {
          width: nextWidth,
          height: nextHeight,
          devicePixelRatio: nextDevicePixelRatio,
        };
      });
    };

    updateStageSize();
    window.addEventListener("resize", updateStageSize);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", updateStageSize);
    }

    const resizeObserver = new ResizeObserver(updateStageSize);
    resizeObserver.observe(stage);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateStageSize);
    };
  }, []);

  useEffect(() => {
    if (!useDomAmbientBackdrop) {
      setAmbientSamplingReady(false);
      ambientDisplayedPaletteRef.current = DEFAULT_AMBIENT_PALETTE;
      ambientTargetPaletteRef.current = DEFAULT_AMBIENT_PALETTE;
      applyAmbientPalette(DEFAULT_AMBIENT_PALETTE);
      return;
    }

    let disposed = false;
    const tick = (now: number) => {
      if (disposed) return;
      if (now - ambientLastSampleTimeRef.current >= AMBIENT_SAMPLE_INTERVAL_MS) {
        ambientLastSampleTimeRef.current = now;
        sampleAmbientPalette();
      }

      const nextDisplayed = smoothPalette(
        ambientDisplayedPaletteRef.current,
        ambientTargetPaletteRef.current,
        AMBIENT_FRAME_SMOOTHING,
      );
      ambientDisplayedPaletteRef.current = nextDisplayed;
      applyAmbientPalette(nextDisplayed);
      ambientRafRef.current = requestAnimationFrame(tick);
    };

    ambientLastSampleTimeRef.current = 0;
    applyAmbientPalette(ambientDisplayedPaletteRef.current);
    ambientRafRef.current = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      if (ambientRafRef.current !== null) {
        cancelAnimationFrame(ambientRafRef.current);
        ambientRafRef.current = null;
      }
    };
  }, [applyAmbientPalette, sampleAmbientPalette, useDomAmbientBackdrop]);

  useEffect(() => {
    return useEditorStore.subscribe((state, prevState) => {
      if (state.playheadMs === prevState.playheadMs) return;
      const video = videoRef.current;
      if (!video) return;

      if (playingRef.current) {
        const expectedSeconds = mediaSecondsForPlayhead(
          video,
          state.playheadMs,
          sourceTimeMapRef.current,
        );
        if (Math.abs(expectedSeconds - video.currentTime) <= MEDIA_SYNC_EPSILON_MS / 1000) return;
      }

      seekPreviewToPlayhead(state.playheadMs);
    });
  }, [seekPreviewToPlayhead]);

  useEffect(() => {
    if (playing) return;
    const video = videoRef.current;
    if (!displayReady || !video || !resolvedSrc) return;
    const eng = engineRef.current;
    if (useCompositedCanvas && !eng) return;

    const renderLoadedFrame = () => {
      const currentPlayheadMs = useEditorStore.getState().playheadMs;
      seekPreviewToPlayhead(currentPlayheadMs);
    };

    if (video.readyState >= 2) {
      renderLoadedFrame();
      return;
    }

    video.addEventListener("loadeddata", renderLoadedFrame, { once: true });
    return () => {
      video.removeEventListener("loadeddata", renderLoadedFrame);
    };
  }, [displayReady, playing, resolvedSrc, seekPreviewToPlayhead, useCompositedCanvas]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !mediaElementSrc) return;
    let disposed = false;
    let callbackId: number | null = null;
    let generation = presentedClockRef.current?.snapshot()?.generation ?? 0;

    lastPresentedFrameAtRef.current = performance.now();
    presentedFrameAwaitingRef.current = false;
    clockFallbackActiveRef.current = false;
    clockFallbackStartedAtRef.current = 0;

    const commitPresented = (mediaTimeSeconds: number, presentedAt: number) => {
      const sourcePtsUs = Math.max(0, Math.round(mediaTimeSeconds * 1_000_000));
      const mappedTimelineMs = sourcePtsUsToTimelineMs(sourceTimeMapRef.current, sourcePtsUs);
      if (
        mappedTimelineMs == null ||
        (clockFallbackActiveRef.current &&
          playingRef.current &&
          mappedTimelineMs < presentedPlayheadRef.current)
      ) {
        return;
      }
      const state = presentedClockRef.current?.commitPresentedFrame(sourcePtsUs, generation);
      if (!state) return;
      lastPresentedFrameAtRef.current = presentedAt;
      presentedFrameAwaitingRef.current = false;
      if (clockFallbackActiveRef.current) {
        const fallbackDurationMs = Math.max(0, presentedAt - clockFallbackStartedAtRef.current);
        clockFallbackActiveRef.current = false;
        clockFallbackStartedAtRef.current = 0;
        frontendLog.info("post-production/PreviewPlayer", "presented-frame clock recovered", {
          fields: {
            fallback_duration_ms: Math.round(fallbackDurationMs),
            retry_count: mediaRetryCountRef.current,
            ready_state: video.readyState,
            network_state: video.networkState,
            output_mode: "composited-canvas",
          },
        });
      }
      presentedPlayheadRef.current = state.timelineMs;
      applyPreviewZoom(state.timelineMs);
      renderCursorOverlay(state.timelineMs);
      if (useCompositedCanvas) {
        requestCanonicalFrame(state.timelineMs);
      }
    };

    const onVideoFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (disposed) return;
      commitPresented(metadata.mediaTime, now);
      callbackId = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => commitPresented(video.currentTime, performance.now());
    const onSeeking = () => {
      generation = presentedClockRef.current?.beginDiscontinuity() ?? generation + 1;
      presentedFrameAwaitingRef.current = true;
      clockFallbackActiveRef.current = false;
      clockFallbackStartedAtRef.current = 0;
      lastPresentedFrameAtRef.current = performance.now();
    };
    const onSeeked = () => {
      presentedFrameAwaitingRef.current = false;
      lastPresentedFrameAtRef.current = performance.now();
    };

    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    if (typeof video.requestVideoFrameCallback === "function") {
      callbackId = video.requestVideoFrameCallback(onVideoFrame);
    } else {
      video.addEventListener("timeupdate", onTimeUpdate);
    }
    return () => {
      disposed = true;
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
    };
  }, [
    applyPreviewZoom,
    renderCursorOverlay,
    requestCanonicalFrame,
    mediaElementSrc,
    useCompositedCanvas,
  ]);

  useEffect(() => {
    if (!playing || useCompositedCanvas) return;
    const video = videoRef.current;
    if (!video || !resolvedSrc) return;
    let disposed = false;
    let holdingSourceFrame = false;
    const playbackStartMs = Math.max(0, useEditorStore.getState().playheadMs);
    const playbackStartedAt = performance.now();

    const playbackDurationMs = () => timelinePlaybackDurationMs(video, durationMsRef.current);

    const commitPlayhead = (nextPlayheadMs: number) => {
      setPlayhead(nextPlayheadMs);
      lastPlayheadCommitRef.current = nextPlayheadMs;
    };

    const commitCurrentMediaTime = () => {
      commitPlayhead(video.currentTime * 1000);
    };

    const tick = (now: number) => {
      if (disposed) return;
      const durationMs = playbackDurationMs();
      const elapsedMs = Math.max(0, now - playbackStartedAt);
      const nextPlayheadMs = Math.min(durationMs, playbackStartMs + elapsedMs);
      const sourceDurationMs = mediaDurationMs(video);
      const mediaSeconds = mediaSecondsForPlayhead(video, nextPlayheadMs, sourceTimeMapRef.current);

      if (
        isSourceHoldAt(sourceTimeMapRef.current, nextPlayheadMs) ||
        (sourceDurationMs > 0 &&
          sourcePtsUsForPlayhead(nextPlayheadMs, sourceTimeMapRef.current) >=
            sourceDurationMs * 1000)
      ) {
        holdingSourceFrame = true;
        if (Math.abs(video.currentTime - mediaSeconds) > MEDIA_SYNC_EPSILON_MS / 1000) {
          video.currentTime = mediaSeconds;
        }
        if (!video.paused) video.pause();
        ambientVideoRef.current?.pause();
        syncAmbientVideo(mediaSeconds);
      } else {
        holdingSourceFrame = false;
        syncAmbientPlayback(video);
      }
      const renderedTimelineMs = holdingSourceFrame
        ? (presentedClockRef.current?.commitHold(nextPlayheadMs)?.timelineMs ?? nextPlayheadMs)
        : presentedPlayheadRef.current;
      applyPreviewZoom(renderedTimelineMs);
      renderCursorOverlay(renderedTimelineMs);
      if (
        Math.abs(nextPlayheadMs - lastPlayheadCommitRef.current) >=
        NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS
      ) {
        setPlayhead(nextPlayheadMs);
        lastPlayheadCommitRef.current = nextPlayheadMs;
      }
      if (Number.isFinite(durationMs) && nextPlayheadMs >= durationMs) {
        commitPlayhead(durationMs);
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const stopPlayback = () => {
      if (disposed) return;
      if (holdingSourceFrame) return;
      const sourceDurationMs = mediaDurationMs(video);
      if (
        sourceDurationMs > 0 &&
        playbackDurationMs() > sourceDurationMs + MEDIA_SYNC_EPSILON_MS &&
        (video.ended || video.currentTime * 1000 >= sourceDurationMs - MEDIA_SYNC_EPSILON_MS)
      ) {
        holdingSourceFrame = true;
        return;
      }
      commitCurrentMediaTime();
      setPlaying(false);
    };

    video.addEventListener("pause", stopPlayback);
    video.addEventListener("ended", stopPlayback);

    seekPreviewToPlayhead(playbackStartMs);
    const sourceDurationMs = mediaDurationMs(video);
    if (sourceDurationMs > 0 && playbackStartMs >= sourceDurationMs) {
      holdingSourceFrame = true;
      rafRef.current = requestAnimationFrame(tick);
    } else {
      void video
        .play()
        .then(() => {
          if (!disposed) {
            syncAmbientPlayback(video);
            void ambientVideoRef.current?.play().catch(() => undefined);
            rafRef.current = requestAnimationFrame(tick);
          }
        })
        .catch((error) => {
          if (!disposed) {
            playingRef.current = false;
            setPlaying(false);
            frontendLog.warn("post-production/PreviewPlayer", "video play request rejected", {
              error,
              fields: { output_mode: "native-video" },
            });
          }
        });
    }

    return () => {
      disposed = true;
      video.removeEventListener("pause", stopPlayback);
      video.removeEventListener("ended", stopPlayback);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      ambientVideoRef.current?.pause();
    };
  }, [
    playing,
    applyPreviewZoom,
    renderCursorOverlay,
    resolvedSrc,
    seekPreviewToPlayhead,
    setPlayhead,
    syncAmbientPlayback,
    syncAmbientVideo,
    useCompositedCanvas,
  ]);

  // rAF loop while playing the visible composited canvas.
  useEffect(() => {
    if (!playing || !useCompositedCanvas || !engineReady) return;
    const video = videoRef.current;
    const eng = engineRef.current;
    if (!video || !resolvedSrc) return;
    if (!eng) return;
    let disposed = false;
    let holdingSourceFrame = false;
    let lastRenderedPlayheadMs = Math.max(0, useEditorStore.getState().playheadMs);
    const playbackStartMs = lastRenderedPlayheadMs;
    const playbackStartedAt = performance.now();
    lastPresentedFrameAtRef.current = playbackStartedAt;
    clockFallbackActiveRef.current = false;
    clockFallbackStartedAtRef.current = 0;

    const playbackDurationMs = () => timelinePlaybackDurationMs(video, durationMsRef.current);

    const commitPlayhead = (nextPlayheadMs: number) => {
      setPlayhead(nextPlayheadMs);
      lastPlayheadCommitRef.current = nextPlayheadMs;
    };

    const tick = (now: number) => {
      if (disposed) return;
      const durationMs = playbackDurationMs();
      const elapsedMs = Math.max(0, now - playbackStartedAt);
      const nextPlayheadMs = Math.min(durationMs, playbackStartMs + elapsedMs);
      const sourceDurationMs = mediaDurationMs(video);
      const mediaSeconds = mediaSecondsForPlayhead(video, nextPlayheadMs, sourceTimeMapRef.current);
      const shouldHoldSource =
        isSourceHoldAt(sourceTimeMapRef.current, nextPlayheadMs) ||
        (sourceDurationMs > 0 &&
          sourcePtsUsForPlayhead(nextPlayheadMs, sourceTimeMapRef.current) >=
            sourceDurationMs * 1000);

      if (shouldHoldSource) {
        holdingSourceFrame = true;
        if (Math.abs(video.currentTime - mediaSeconds) > MEDIA_SYNC_EPSILON_MS / 1000) {
          video.currentTime = mediaSeconds;
        }
        if (!video.paused) video.pause();
      } else if (video.ended || video.paused) {
        const finalPlayheadMs = video.currentTime * 1000;
        commitPlayhead(finalPlayheadMs);
        setPlaying(false);
        return;
      } else {
        holdingSourceFrame = false;
      }

      let renderedTimelineMs = presentedPlayheadRef.current;
      if (holdingSourceFrame) {
        renderedTimelineMs =
          presentedClockRef.current?.commitHold(nextPlayheadMs)?.timelineMs ?? nextPlayheadMs;
      } else if (
        typeof video.requestVideoFrameCallback === "function" &&
        video.readyState >= 2 &&
        !video.seeking &&
        !presentedFrameAwaitingRef.current
      ) {
        const staleDurationMs = Math.max(0, now - lastPresentedFrameAtRef.current);
        if (clockFallbackActiveRef.current || staleDurationMs >= presentedFrameStaleMs) {
          if (!clockFallbackActiveRef.current) {
            clockFallbackActiveRef.current = true;
            clockFallbackStartedAtRef.current = now;
            frontendLog.warn(
              "post-production/PreviewPlayer",
              "presented-frame clock fallback activated",
              {
                fields: {
                  stale_duration_ms: Math.round(staleDurationMs),
                  retry_count: mediaRetryCountRef.current,
                  ready_state: video.readyState,
                  network_state: video.networkState,
                  output_mode: "composited-canvas",
                },
              },
            );
          }
          const fallbackState = presentedClockRef.current?.commitPresentedFrame(
            Math.max(0, Math.round(video.currentTime * 1_000_000)),
          );
          if (fallbackState) {
            renderedTimelineMs = Math.max(presentedPlayheadRef.current, fallbackState.timelineMs);
            presentedPlayheadRef.current = renderedTimelineMs;
          }
        }
      }
      lastRenderedPlayheadMs = renderedTimelineMs;
      applyPreviewZoom(renderedTimelineMs);
      renderCursorOverlay(renderedTimelineMs);
      if (
        Math.abs(nextPlayheadMs - lastPlayheadCommitRef.current) >=
        COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS
      ) {
        commitPlayhead(nextPlayheadMs);
      }
      requestCanonicalFrame(renderedTimelineMs);
      if (Number.isFinite(durationMs) && nextPlayheadMs >= durationMs) {
        commitPlayhead(durationMs);
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    seekPreviewToPlayhead(playbackStartMs);
    const sourceDurationMs = mediaDurationMs(video);
    if (sourceDurationMs > 0 && playbackStartMs >= sourceDurationMs) {
      holdingSourceFrame = true;
      rafRef.current = requestAnimationFrame(tick);
    } else {
      void video
        .play()
        .then(() => {
          if (!disposed) {
            rafRef.current = requestAnimationFrame(tick);
          }
        })
        .catch((error) => {
          if (!disposed) {
            playingRef.current = false;
            setPlaying(false);
            frontendLog.warn("post-production/PreviewPlayer", "video play request rejected", {
              error,
              fields: { output_mode: "composited-canvas" },
            });
          }
        });
    }

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      if (holdingSourceFrame) {
        setPlayhead(lastRenderedPlayheadMs);
        lastPlayheadCommitRef.current = lastRenderedPlayheadMs;
      } else {
        const finalPlayheadMs = video.currentTime * 1000;
        setPlayhead(finalPlayheadMs);
        lastPlayheadCommitRef.current = finalPlayheadMs;
      }
    };
  }, [
    playing,
    applyPreviewZoom,
    engineReady,
    renderCursorOverlay,
    requestCanonicalFrame,
    resolvedSrc,
    seekPreviewToPlayhead,
    setPlayhead,
    presentedFrameStaleMs,
    useCompositedCanvas,
  ]);

  const resetPreviewToStart = useCallback(() => {
    setPlayhead(0);
    lastPlayheadCommitRef.current = 0;
    seekPreviewToPlayhead(0);
    applyPreviewZoom(0);
    renderCursorOverlay(0);
  }, [applyPreviewZoom, renderCursorOverlay, seekPreviewToPlayhead, setPlayhead]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }

    const { durationMs, playheadMs } = useEditorStore.getState();
    if (isAtTimelineEnd(playheadMs, durationMs)) {
      resetPreviewToStart();
    }
    playingRef.current = true;
    setPlaying(true);
  }, [resetPreviewToStart]);

  // Space-bar custom event from useEditorHotkeys triggers the same toggle.
  useEffect(() => {
    const h = () => togglePlay();
    window.addEventListener("storycapture:toggle-playback", h);
    return () => window.removeEventListener("storycapture:toggle-playback", h);
  }, [togglePlay]);

  const handleVideoLoaded = useCallback(() => {
    const retryCount = mediaRetryCountRef.current;
    const video = videoRef.current;
    clearMediaRetryTimer();
    mediaRetryCountRef.current = 0;
    lastMediaErrorGenerationRef.current = null;
    setMediaError(false);
    if (retryCount > 0) {
      frontendLog.info("post-production/PreviewPlayer", "video element recovered", {
        fields: {
          retry_count: retryCount,
          network_state: video?.networkState ?? null,
          ready_state: video?.readyState ?? null,
        },
      });
    }
  }, [clearMediaRetryTimer]);

  const retryMediaSource = useCallback(() => {
    clearMediaRetryTimer();
    mediaRetryCountRef.current = 0;
    lastMediaErrorGenerationRef.current = null;
    setMediaError(false);
    setCanonicalError(false);
    setMediaSourceGeneration((generation) => generation + 1);
  }, [clearMediaRetryTimer]);

  const handleVideoError = useCallback(() => {
    if (lastMediaErrorGenerationRef.current === mediaSourceGeneration) return;
    lastMediaErrorGenerationRef.current = mediaSourceGeneration;
    const video = videoRef.current;
    const err = video?.error;
    playingRef.current = false;
    setPlaying(false);
    frontendLog.warn("post-production/PreviewPlayer", "video element failed", {
      fields: {
        retry_count: mediaRetryCountRef.current,
        code: err?.code ?? null,
        network_state: video?.networkState ?? null,
        ready_state: video?.readyState ?? null,
      },
    });
    const retryDelayMs = MEDIA_RETRY_DELAYS_MS[mediaRetryCountRef.current];
    if (retryDelayMs !== undefined) {
      mediaRetryCountRef.current += 1;
      clearMediaRetryTimer();
      mediaRetryTimerRef.current = setTimeout(() => {
        mediaRetryTimerRef.current = null;
        setMediaSourceGeneration((generation) => generation + 1);
      }, retryDelayMs);
      return;
    }
    clearMediaRetryTimer();
    setMediaError(true);
  }, [clearMediaRetryTimer, mediaSourceGeneration]);

  const handleVideoMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    setMediaAspect(safeAspect(video.videoWidth, video.videoHeight));
  }, []);

  const selectTextClip = useCallback(
    (clipId: string) => {
      setSelectedClipId(clipId);
      setSelectedTab("effects");
    },
    [setSelectedClipId, setSelectedTab],
  );

  const pushAnnotationParamChange = useCallback(
    (clipId: string, field: string, prev: unknown, next: unknown) => {
      if (Object.is(prev, next)) return;
      const index = useEditorStore
        .getState()
        .tracks.annotations.findIndex((item) => item.id === clipId);
      if (index < 0) return;
      pushAction({
        kind: "set-effect-param",
        nodePath: `tracks.annotations[${index}]`,
        field,
        prev,
        next,
      });
    },
    [pushAction],
  );

  const commitTextDraft = useCallback(() => {
    const clip = editingTextClip;
    if (!clip) {
      setEditingTextClipId(null);
      return;
    }
    const next = textDraft.trim() ? textDraft : clip.text;
    setEditingTextClipId(null);
    pushAnnotationParamChange(clip.id, "text", clip.text, next);
  }, [editingTextClip, pushAnnotationParamChange, textDraft]);

  const beginTextEdit = useCallback(
    (clip: AnnotationClip) => {
      selectTextClip(clip.id);
      setTextDraft(clip.text);
      setEditingTextClipId(clip.id);
    },
    [selectTextClip],
  );

  const focusTextEditor = useCallback((node: HTMLTextAreaElement | null) => {
    node?.focus();
  }, []);

  const onTextPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, clip: AnnotationClip) => {
      if (editingTextClipId === clip.id) return;
      e.preventDefault();
      e.stopPropagation();
      selectTextClip(clip.id);
      const frame = e.currentTarget.parentElement?.getBoundingClientRect();
      if (!frame || frame.width <= 0 || frame.height <= 0) return;
      const origin = resolveTextAnchorPosition(
        clip,
        playheadMs,
        actions,
        cursorClips,
        stepTiming,
        captureRect,
        cursorSchedules,
      );
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: PointerEvent) => {
        const next = {
          x: clampTextPosition(origin.x + (ev.clientX - startX) / frame.width),
          y: clampTextPosition(origin.y + (ev.clientY - startY) / frame.height),
        };
        updateAnnotationClipDirect(clip.id, { pos: next, anchor: { kind: "screen", pos: next } });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const finalClip = useEditorStore
          .getState()
          .tracks.annotations.find((item) => item.id === clip.id);
        if (!finalClip) return;
        if (finalClip.pos.x === origin.x && finalClip.pos.y === origin.y) return;
        pushAnnotationParamChange(clip.id, "pos", clip.pos, finalClip.pos);
        pushAnnotationParamChange(clip.id, "anchor", clip.anchor, finalClip.anchor);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [
      actions,
      captureRect,
      cursorClips,
      cursorSchedules,
      editingTextClipId,
      playheadMs,
      pushAnnotationParamChange,
      selectTextClip,
      stepTiming,
    ],
  );

  const onTextResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>, clip: AnnotationClip) => {
      e.preventDefault();
      e.stopPropagation();
      selectTextClip(clip.id);
      const origin = clip.sizePt;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: PointerEvent) => {
        const delta = (ev.clientX - startX + ev.clientY - startY) * 0.16;
        updateAnnotationClipDirect(clip.id, {
          sizePt: Math.max(12, Math.min(72, Math.round(origin + delta))),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const finalClip = useEditorStore
          .getState()
          .tracks.annotations.find((item) => item.id === clip.id);
        if (!finalClip || finalClip.sizePt === origin) return;
        pushAnnotationParamChange(clip.id, "sizePt", origin, finalClip.sizePt);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pushAnnotationParamChange, selectTextClip],
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-[var(--color-background-card)]"
      data-story-id={storyId}
      data-preview-ready={displayReady ? "true" : "false"}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <div
          ref={stageRef}
          className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--radius-container)] border border-[color-mix(in_oklch,var(--color-border)_72%,transparent)]"
          style={useCompositedCanvas ? undefined : stageStyle}
        >
          {useDomAmbientBackdrop && resolvedSrc ? (
            <>
              <div
                ref={ambientLayerRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{ background: ambientBackground(DEFAULT_AMBIENT_PALETTE) }}
              />
              {!ambientSamplingReady ? (
                <video
                  key={`ambient:${mediaSourceKey}`}
                  ref={ambientVideoRef}
                  data-testid="preview-ambient-video"
                  aria-hidden="true"
                  tabIndex={-1}
                  muted
                  playsInline
                  preload="auto"
                  src={mediaElementSrc}
                  className="pointer-events-none absolute inset-0 h-full w-full scale-[1.08] object-cover opacity-26 blur-3xl saturate-[1.15]"
                />
              ) : null}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(255,255,255,0.08),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(0,0,0,0.16))]"
              />
            </>
          ) : null}
          {!resolvedSrc && !useCompositedCanvas ? (
            <>
              <img
                src={previewBackdrop}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover opacity-92"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(16,20,27,0.10),rgba(16,20,27,0.32))]" />
              <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-white/72">
                <span className="rounded-full border border-white/10 bg-zinc-950/42 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                  PRV_01_FINAL_RENDER
                </span>
                <span className="rounded-full border border-white/10 bg-zinc-950/42 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                  4K UHD
                </span>
              </div>
            </>
          ) : null}
          {!resolvedSrc && !useCompositedCanvas ? (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center">
              <div className="grid h-16 w-16 place-items-center rounded-[var(--radius-container)] border border-white/10 bg-zinc-950/42 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <Film className="h-7 w-7 text-white/82" />
              </div>
            </div>
          ) : null}

          <div
            className={`relative z-10 flex items-center justify-center overflow-visible bg-transparent ${
              useCompositedCanvas
                ? "max-w-none"
                : "max-w-[1480px] rounded-[18px] shadow-[0_22px_58px_-38px_rgba(0,0,0,0.68)]"
            }`}
            style={frameStyle}
          >
            <div
              ref={previewFrameContentRef}
              className="relative h-full w-full overflow-hidden rounded-[inherit] will-change-transform"
              data-testid="preview-zoom-layer"
            >
              {resolvedSrc && !useCompositedCanvas ? (
                <video
                  key={`source:${mediaSourceKey}`}
                  ref={videoRef}
                  muted
                  playsInline
                  preload="auto"
                  src={mediaElementSrc}
                  onError={handleVideoError}
                  onLoadedData={handleVideoLoaded}
                  onLoadedMetadata={handleVideoMetadata}
                  className="relative h-full w-full object-contain"
                  aria-label="Source video preview"
                />
              ) : null}
              {useCompositedCanvas ? (
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 h-full w-full"
                  aria-label="Canonical composited preview canvas"
                />
              ) : null}
            </div>
            {mediaError || canonicalError ? (
              <div className="absolute inset-0 z-30 grid place-items-center bg-zinc-950/72 px-6 text-center">
                <div className="space-y-3">
                  <p className="text-sm font-medium text-white">Preview could not be rendered.</p>
                  <button
                    type="button"
                    className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15"
                    onClick={retryMediaSource}
                  >
                    Retry preview
                  </button>
                </div>
              </div>
            ) : null}
            {!useCompositedCanvas && activeHighlights.length > 0 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
                data-testid="highlight-overlay"
              >
                {activeHighlights.map((clip) => {
                  const highlight = clip.highlight;
                  if (!highlight) return null;
                  if (highlight.bounds && !hasReliableHighlightBounds(highlight.bounds))
                    return null;
                  const center = applyZoomToPoint(highlight.center, previewZoom);
                  const zoomedBounds = highlight.bounds
                    ? applyZoomToBounds(highlight.bounds, previewZoom)
                    : null;
                  const progress = Math.max(
                    0,
                    Math.min(
                      1,
                      (playheadMs - clip.startMs) /
                        Math.max(1, highlight.durationMs ?? clip.durationMs),
                    ),
                  );
                  const baseOpacity = highlight.opacity ?? 0.72;
                  const effectiveOpacity = Math.max(0, 1 - progress) * baseOpacity;
                  const radius = Math.max(8, highlight.radiusPx * Math.max(1, previewZoom.scale));
                  const borderRadius = highlight.bounds
                    ? Math.min(12, Math.max(4, highlight.radiusPx * 0.18))
                    : radius;
                  const paddingPx = zoomedBounds
                    ? (highlight.paddingPx ?? Math.min(12, Math.max(6, radius * 0.14)))
                    : 0;
                  const strokePx = highlight.strokePx ?? 2;
                  const glowPx = highlight.glowPx ?? 16;
                  const isSpotlight = highlight.shape === "spotlight";
                  const highlightBoundsStyle = highlight.bounds
                    ? boundedHighlightStyle(zoomedBounds, paddingPx)
                    : null;
                  if (highlight.bounds && !highlightBoundsStyle) return null;
                  return (
                    <div
                      key={clip.id}
                      className="absolute border-solid"
                      data-testid="highlight-frame"
                      style={{
                        ...(highlightBoundsStyle ?? {
                          left: percent(center.x),
                          top: percent(center.y),
                          width: `${radius * 2}px`,
                          height: `${radius * 2}px`,
                          transform: "translate3d(-50%, -50%, 0)",
                        }),
                        borderColor: highlight.color,
                        borderWidth: `${strokePx}px`,
                        borderRadius: `${borderRadius}px`,
                        opacity: effectiveOpacity,
                        boxShadow: isSpotlight
                          ? `0 0 0 9999px rgba(0,0,0,0.46), 0 0 ${glowPx}px ${highlight.color ?? "#ffffff"}`
                          : `0 0 ${glowPx}px rgba(255,255,255,0.28)`,
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
            {!useCompositedCanvas ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
                data-testid="virtual-cursor-overlay"
              >
                {CURSOR_CLICK_FEEDBACK_NODE_KEYS.map((nodeKey, nodeIndex) => (
                  <div
                    key={nodeKey}
                    ref={(node) => {
                      cursorClickFeedbackRefs.current[nodeIndex] = node;
                    }}
                    className="absolute box-border opacity-0 invisible"
                    data-feedback-slot={Math.floor(nodeIndex / CURSOR_CLICK_EFFECT_MAX_PRIMITIVES)}
                    data-primitive-slot={nodeIndex % CURSOR_CLICK_EFFECT_MAX_PRIMITIVES}
                    data-testid="cursor-click-feedback-primitive"
                  />
                ))}
                <img
                  ref={cursorRef}
                  alt=""
                  className="absolute opacity-0 drop-shadow-[0_5px_12px_rgba(0,0,0,0.42)]"
                  draggable={false}
                />
              </div>
            ) : null}
            {activeTextOverlays.length > 0 ? (
              <div
                className={`pointer-events-none absolute overflow-visible ${
                  useCompositedCanvas ? "" : "inset-0"
                }`}
                data-testid="text-overlay"
                style={useCompositedCanvas ? compositionInteractionStyle : undefined}
              >
                {activeTextOverlays.map((clip) => {
                  const style = resolvedTextStyle(clip);
                  const selected = selectedClipId === clip.id;
                  const editing = editingTextClipId === clip.id;
                  const canonicalInteractionOnly = useCompositedCanvas && !editing;
                  const anchorPosition = resolveTextAnchorPosition(
                    clip,
                    playheadMs,
                    actions,
                    cursorClips,
                    stepTiming,
                    captureRect,
                    cursorSchedules,
                  );
                  const position =
                    clip.anchor?.kind === "target" || clip.anchor?.kind === "cursor"
                      ? applyZoomToPoint(anchorPosition, previewZoom)
                      : anchorPosition;
                  const font = textFontCss(style.font);
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: this composite drag/edit surface contains its own resize button and cannot be a button element.
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Text overlay ${clip.text}`}
                      data-text-clip-id={clip.id}
                      data-canonical-interaction-only={
                        canonicalInteractionOnly ? "true" : undefined
                      }
                      className={`pointer-events-auto absolute whitespace-pre-wrap transition-[box-shadow,outline-color,transform,opacity] ${
                        selected
                          ? "rounded-md outline outline-2 outline-[var(--color-accent-muted)]"
                          : "outline outline-1 outline-transparent hover:outline-white/32"
                      }`}
                      style={{
                        left: percent(position.x),
                        top: percent(position.y),
                        ...textMotionStyle(style.animation, clip, playheadMs, position.x),
                        color: canonicalInteractionOnly ? "transparent" : style.color,
                        fontFamily: font.fontFamily,
                        fontSize: `clamp(12px, ${style.sizePt}px, 72px)`,
                        fontWeight: font.fontWeight,
                        fontStyle: font.fontStyle,
                        textAlign: style.align,
                        letterSpacing: `${style.letterSpacingPx}px`,
                        lineHeight: style.lineHeight,
                        width: "max-content",
                        maxWidth: `${style.maxWidthPct}%`,
                        boxSizing: "content-box",
                        overflowWrap: "break-word",
                        padding: style.boxStyle ? `${style.boxStyle.paddingPx}px` : undefined,
                        borderRadius: style.boxStyle ? `${style.boxStyle.radiusPx}px` : undefined,
                        background: canonicalInteractionOnly
                          ? "transparent"
                          : style.boxStyle?.bgColor,
                        border:
                          !canonicalInteractionOnly &&
                          style.boxStyle?.borderColor &&
                          style.boxStyle.borderWidthPx > 0
                            ? `${style.boxStyle.borderWidthPx}px solid ${style.boxStyle.borderColor}`
                            : undefined,
                        boxShadow:
                          !canonicalInteractionOnly && style.boxStyle?.shadow
                            ? textShadowCss(style.boxStyle.shadow)
                            : undefined,
                        textShadow:
                          !canonicalInteractionOnly && style.textShadow
                            ? textShadowCss(style.textShadow)
                            : undefined,
                      }}
                      onPointerDown={(e) => onTextPointerDown(e, clip)}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        beginTextEdit(clip);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") beginTextEdit(clip);
                      }}
                    >
                      {editing ? (
                        <textarea
                          ref={focusTextEditor}
                          aria-label="Edit text overlay"
                          value={textDraft}
                          className="min-h-[2.4em] w-[min(420px,62vw)] resize-none rounded-md border border-white/18 bg-zinc-950/82 px-2 py-1 text-inherit outline-none"
                          onPointerDown={(e) => e.stopPropagation()}
                          onChange={(e) => setTextDraft(e.currentTarget.value)}
                          onBlur={commitTextDraft}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingTextClipId(null);
                            }
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              commitTextDraft();
                            }
                          }}
                        />
                      ) : (
                        clip.text
                      )}
                      {selected && !editing ? (
                        <button
                          type="button"
                          aria-label="Resize text overlay"
                          className="absolute -bottom-2 -right-2 h-4 w-4 rounded-full border border-white/70 bg-zinc-950/88 shadow-[0_4px_12px_rgba(0,0,0,0.34)]"
                          onPointerDown={(e) => onTextResizePointerDown(e, clip)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="absolute bottom-3 left-3 z-20 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)]/88 px-2.5 py-2 shadow-[var(--shadow-low)] backdrop-blur">
            <TransportControls playing={playing} onTogglePlay={togglePlay} />
          </div>
        </div>
        {resolvedSrc && useCompositedCanvas ? (
          <video
            key={`source:${mediaSourceKey}`}
            ref={videoRef}
            hidden
            muted
            playsInline
            preload="auto"
            src={mediaElementSrc}
            onError={handleVideoError}
            onLoadedData={handleVideoLoaded}
            onLoadedMetadata={handleVideoMetadata}
          />
        ) : null}
        {!resolvedSrc ? (
          <video
            key={`source:${mediaSourceKey}`}
            ref={videoRef}
            hidden
            muted
            playsInline
            preload="auto"
            onError={handleVideoError}
          />
        ) : null}
      </div>
    </div>
  );
}
