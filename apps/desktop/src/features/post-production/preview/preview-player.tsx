/**
 * PreviewPlayer — owns the post-production preview surface:
 *   - default path displays the source through native <video>
 *   - composited mode keeps the <video> as a source and renders <canvas>
 *   - syncs `<video>.currentTime = playheadMs / 1000` on every scrub
 *
 * The PreviewRenderPlan consumed here is a minimum viable plan: zoom
 * identity, no ripples, no cursor atlas, no background. The engine
 * already understands the full shape, so future enrichments slot in
 * without changes here.
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
import { type EditorBackgroundKind, readEditorBackground, useEditorStore } from "../state/store";
import {
  activeCursorClip,
  isActionsCursorClip,
  resolveTextAnchorPosition,
} from "../state/text-anchor";
import { resolvedTextStyle, type TextStylePreset, textFontCss } from "../state/text-style";
import type {
  AnnotationClip,
  CursorClip,
  CursorMotionPreset,
  CursorSkin,
  ZoomClip,
} from "../state/timeline-slice";
import {
  buildVirtualCursorSchedule,
  type VirtualCursorSchedule,
} from "../state/virtual-cursor-scheduler";
import {
  applyZoomToBounds,
  applyZoomToPoint,
  normalizedZoomCropTopLeft,
  sampleZoom,
} from "../state/zoom-motion";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";
import type { PreviewRenderPlan } from "./types";
import { samplePreparedVirtualCursor, sampleTrajectoryCursor } from "./virtual-cursor-path";

type PreviewOutputMode = "native-video" | "composited-canvas";

const DEFAULT_PREVIEW_OUTPUT_MODE: PreviewOutputMode = "native-video";
const NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS = 16;
const COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS = 100;
const MEDIA_SYNC_EPSILON_MS = 80;
const TIMELINE_END_EPSILON_MS = 16;
const PREVIEW_FRAME_SCALE = 0.86;
const AMBIENT_SAMPLE_WIDTH = 40;
const AMBIENT_SAMPLE_HEIGHT = 22;
const AMBIENT_SAMPLE_INTERVAL_MS = 90;
const AMBIENT_FRAME_SMOOTHING = 0.13;
const CURSOR_BASE_SIZE_PX = 32;
const CURSOR_RIPPLE_MAX_PX = 96;
const SOURCE_HOLD_EPSILON_SECONDS = 0.001;
const TEXT_DRAG_OVERSCAN = 0.25;
const MIN_HIGHLIGHT_BOUNDS_SIZE = 0.0001;

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

function buildPlan(width: number, height: number): PreviewRenderPlan {
  return {
    output_width: width,
    output_height: height,
    fps: 60,
    zoom_matrices: [],
    cursor_atlas_ref: null,
    ripples: [],
    highlights: [],
    text_boxes: [],
    background: null,
  };
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

function mediaSecondsForPlayhead(video: HTMLVideoElement, playheadMs: number): number {
  const requestedSeconds = Math.max(0, playheadMs) / 1000;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return requestedSeconds;
  return Math.min(requestedSeconds, Math.max(0, video.duration - SOURCE_HOLD_EPSILON_SECONDS));
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampTextPosition(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(-TEXT_DRAG_OVERSCAN, Math.min(1 + TEXT_DRAG_OVERSCAN, value));
}

function textTranslateX(posX: number): string {
  if (!Number.isFinite(posX)) return "-50%";
  if (posX < 0.18) return "0%";
  if (posX > 0.82) return "-100%";
  return "-50%";
}

function textMotionStyle(
  animation: TextStylePreset["animation"],
  clip: AnnotationClip,
  playheadMs: number,
  posX: number,
): CSSProperties {
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
    transformOrigin: posX < 0.18 ? "left center" : posX > 0.82 ? "right center" : "center center",
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
      "radial-gradient(circle at 24% 18%, color-mix(in oklch, var(--sc-accent) 12%, transparent), transparent 34%), linear-gradient(135deg, color-mix(in oklch, var(--sc-surface) 96%, var(--sc-text) 4%), color-mix(in oklch, var(--sc-surface-2) 95%, var(--sc-text) 5%))",
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
  const cursorRippleRef = useRef<HTMLDivElement | null>(null);
  const ambientVideoRef = useRef<HTMLVideoElement | null>(null);
  const ambientSampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ambientDisplayedPaletteRef = useRef<AmbientPalette>(DEFAULT_AMBIENT_PALETTE);
  const ambientTargetPaletteRef = useRef<AmbientPalette>(DEFAULT_AMBIENT_PALETTE);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const ambientRafRef = useRef<number | null>(null);
  const ambientLastSampleTimeRef = useRef(0);
  const lastPlayheadCommitRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [ambientSamplingReady, setAmbientSamplingReady] = useState(false);
  const [editingTextClipId, setEditingTextClipId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [mediaAspect, setMediaAspect] = useState(() => safeAspect(width, height));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const playingRef = useRef(false);
  const cursorClipsRef = useRef<CursorClip[]>([]);
  const cursorSchedulesRef = useRef(new Map<CursorMotionPreset, VirtualCursorSchedule | null>());
  const zoomClipsRef = useRef<ZoomClip[]>([]);
  const trajectoryRef = useRef<RecordingTrajectory | null>(trajectory);
  const durationMsRef = useRef(0);

  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const pushAction = useEditorStore((s) => s.pushAction);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const cursorClips = useEditorStore((s) => s.tracks.cursor);
  const zoomClips = useEditorStore((s) => s.tracks.zoom);
  const annotationClips = useEditorStore((s) => s.tracks.annotations);
  const cursorSchedules = useMemo(() => {
    const schedules = new Map<CursorMotionPreset, VirtualCursorSchedule | null>();
    if (!actions) return schedules;
    for (const clip of cursorClips) {
      const motionPreset = clip.motionPreset ?? "natural";
      if (!isActionsCursorClip(clip) || schedules.has(motionPreset)) continue;
      schedules.set(motionPreset, buildVirtualCursorSchedule(actions, motionPreset));
    }
    return schedules;
  }, [actions, cursorClips]);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const durationMs = useEditorStore((s) => s.durationMs);
  const useCompositedCanvas = outputMode === "composited-canvas";
  const displayReady = !useCompositedCanvas || engineReady;
  const renderPlan = useMemo(() => buildPlan(width, height), [width, height]);
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
  const previewZoom = useMemo(() => sampleZoom(zoomClips, playheadMs), [playheadMs, zoomClips]);
  const editingTextClip = useMemo(
    () => annotationClips.find((clip) => clip.id === editingTextClipId) ?? null,
    [annotationClips, editingTextClipId],
  );
  const frameStyle = useMemo<CSSProperties>(() => {
    const maxWidth = stageSize.width * PREVIEW_FRAME_SCALE;
    const maxHeight = stageSize.height * PREVIEW_FRAME_SCALE;
    if (maxWidth > 0 && maxHeight > 0) {
      const frameWidth = Math.min(maxWidth, maxHeight * mediaAspect);
      const frameHeight = frameWidth / mediaAspect;
      return {
        width: Math.round(frameWidth),
        height: Math.round(frameHeight),
      };
    }
    return {
      aspectRatio: `${mediaAspect}`,
      maxHeight: `${PREVIEW_FRAME_SCALE * 100}%`,
      maxWidth: `${PREVIEW_FRAME_SCALE * 100}%`,
      width: `${PREVIEW_FRAME_SCALE * 100}%`,
    };
  }, [mediaAspect, stageSize.height, stageSize.width]);

  const resolvedSrc = videoSrc
    ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
      ? videoSrc
      : convertFileSrc(videoSrc)
    : undefined;
  const useAmbientBackdrop = editorBackground.kind === "transparent" && Boolean(resolvedSrc);

  const hideCursorOverlay = useCallback(() => {
    const cursor = cursorRef.current;
    const ripple = cursorRippleRef.current;
    if (cursor) cursor.style.opacity = "0";
    if (ripple) ripple.style.opacity = "0";
  }, []);

  const applyPreviewZoom = useCallback((playheadMs: number) => {
    const frame = previewFrameContentRef.current;
    if (!frame) return;

    const zoom = sampleZoom(zoomClipsRef.current, playheadMs);
    const crop = normalizedZoomCropTopLeft(zoom.center, zoom.scale);
    const width = frame.clientWidth || frame.getBoundingClientRect().width;
    const height = frame.clientHeight || frame.getBoundingClientRect().height;
    const tx = -crop.x * width * zoom.scale;
    const ty = -crop.y * height * zoom.scale;
    frame.style.transformOrigin = "0 0";
    frame.style.transform = `matrix(${zoom.scale}, 0, 0, ${zoom.scale}, ${tx}, ${ty})`;
  }, []);

  const renderCursorOverlay = useCallback(
    (playheadMs: number) => {
      const cursor = cursorRef.current;
      const ripple = cursorRippleRef.current;
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

      const relativeMs = playheadMs - clip.startMs;
      const motionPreset = clip.motionPreset ?? "natural";
      const sample = isActionsCursorClip(clip)
        ? samplePreparedVirtualCursor(cursorSchedulesRef.current.get(motionPreset), relativeMs)
        : clip.trajectoryKind === "trajectory"
          ? sampleTrajectoryCursor(currentTrajectory, relativeMs)
          : null;
      const src = cursorSkinSrc(clip.skin);
      if (!sample || !src) {
        hideCursorOverlay();
        return;
      }

      if (cursor.getAttribute("src") !== src) cursor.setAttribute("src", src);
      const zoom = sampleZoom(zoomClipsRef.current, playheadMs);
      const cursorPoint = applyZoomToPoint(sample, zoom);
      const size = CURSOR_BASE_SIZE_PX * Math.max(0.1, clip.sizeScale || 1);
      setStyleValue(cursor.style, "width", `${size}px`);
      setStyleValue(cursor.style, "height", `${size}px`);
      setStyleValue(cursor.style, "left", `${cursorPoint.x * 100}%`);
      setStyleValue(cursor.style, "top", `${cursorPoint.y * 100}%`);
      setStyleValue(cursor.style, "opacity", "1");
      setStyleValue(cursor.style, "transform", "translate3d(-1px, -1px, 0)");

      if (!ripple) return;
      const activeRipple = sample.ripple;
      if (!activeRipple) {
        ripple.style.opacity = "0";
        return;
      }
      const ripplePoint = applyZoomToPoint({ x: activeRipple.x, y: activeRipple.y }, zoom);
      const rippleSize = 18 + activeRipple.progress * CURSOR_RIPPLE_MAX_PX;
      setStyleValue(ripple.style, "width", `${rippleSize}px`);
      setStyleValue(ripple.style, "height", `${rippleSize}px`);
      setStyleValue(ripple.style, "left", `${ripplePoint.x * 100}%`);
      setStyleValue(ripple.style, "top", `${ripplePoint.y * 100}%`);
      setStyleValue(ripple.style, "opacity", String(Math.max(0, activeRipple.opacity * 0.72)));
      setStyleValue(ripple.style, "transform", "translate3d(-50%, -50%, 0)");
    },
    [hideCursorOverlay],
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
    if (!useAmbientBackdrop || !video || video.readyState < 2 || !video.videoWidth) return false;

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
  }, [useAmbientBackdrop]);

  const seekPreviewToPlayhead = useCallback(
    (targetMs: number) => {
      const video = videoRef.current;
      if (!video) return;
      const nextMs = Math.max(0, targetMs);
      const nextSeconds = mediaSecondsForPlayhead(video, nextMs);

      video.currentTime = nextSeconds;
      syncAmbientVideo(nextSeconds);
      if (sampleAmbientPalette()) {
        ambientDisplayedPaletteRef.current = smoothPalette(
          ambientDisplayedPaletteRef.current,
          ambientTargetPaletteRef.current,
          0.55,
        );
        applyAmbientPalette(ambientDisplayedPaletteRef.current);
      }
      lastPlayheadCommitRef.current = nextMs;
      applyPreviewZoom(nextMs);
      renderCursorOverlay(nextMs);

      if (useCompositedCanvas) {
        const eng = engineRef.current;
        if (eng) void eng.renderFrame(nextMs, renderPlan);
      }
    },
    [
      applyAmbientPalette,
      applyPreviewZoom,
      renderPlan,
      renderCursorOverlay,
      sampleAmbientPalette,
      syncAmbientVideo,
      useCompositedCanvas,
    ],
  );

  // The current UI shows native video. Keep the compositor dormant until its
  // canvas output is visible, otherwise playback pays hidden GPU work.
  useEffect(() => {
    if (!useCompositedCanvas) {
      engineRef.current?.dispose();
      engineRef.current = null;
      setEngineReady(false);
      return;
    }

    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    let disposed = false;
    const engine = new PreviewEngine({
      canvas,
      videoElement: video,
      outputWidth: width,
      outputHeight: height,
    });
    engine
      .init()
      .then(() => {
        if (disposed) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        setEngineReady(true);
      })
      .catch((err) => {
        frontendLog.warn(
          "post-production/PreviewPlayer",
          "PreviewEngine init failed (preview disabled)",
          { error: err },
        );
      });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      setEngineReady(false);
    };
  }, [useCompositedCanvas, width, height]);

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
    zoomClipsRef.current = zoomClips;
    applyPreviewZoom(useEditorStore.getState().playheadMs);
  }, [applyPreviewZoom, zoomClips]);

  useEffect(() => {
    setMediaAspect(safeAspect(width, height));
  }, [width, height]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateStageSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize((prev) => {
        const nextWidth = Math.round(rect.width);
        const nextHeight = Math.round(rect.height);
        if (prev.width === nextWidth && prev.height === nextHeight) return prev;
        return { width: nextWidth, height: nextHeight };
      });
    };

    updateStageSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateStageSize);
      return () => window.removeEventListener("resize", updateStageSize);
    }

    const resizeObserver = new ResizeObserver(updateStageSize);
    resizeObserver.observe(stage);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!useAmbientBackdrop) {
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
  }, [applyAmbientPalette, sampleAmbientPalette, useAmbientBackdrop]);

  useEffect(() => {
    return useEditorStore.subscribe((state, prevState) => {
      if (state.playheadMs === prevState.playheadMs) return;
      const video = videoRef.current;
      if (!video) return;

      if (playingRef.current) {
        const currentVideoMs = video.currentTime * 1000;
        if (Math.abs(state.playheadMs - currentVideoMs) <= MEDIA_SYNC_EPSILON_MS) return;
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
      const mediaSeconds = mediaSecondsForPlayhead(video, nextPlayheadMs);

      if (sourceDurationMs > 0 && nextPlayheadMs >= sourceDurationMs) {
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
      applyPreviewZoom(nextPlayheadMs);
      renderCursorOverlay(nextPlayheadMs);
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
        .catch(() => {
          if (!disposed) setPlaying(false);
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
    if (!playing || !useCompositedCanvas) return;
    const video = videoRef.current;
    const eng = engineRef.current;
    if (!video || !resolvedSrc) return;
    if (!eng) return;
    let disposed = false;
    let holdingSourceFrame = false;
    let lastRenderedPlayheadMs = Math.max(0, useEditorStore.getState().playheadMs);
    const playbackStartMs = lastRenderedPlayheadMs;
    const playbackStartedAt = performance.now();

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
      const mediaSeconds = mediaSecondsForPlayhead(video, nextPlayheadMs);
      const shouldHoldSource = sourceDurationMs > 0 && nextPlayheadMs >= sourceDurationMs;

      if (shouldHoldSource) {
        holdingSourceFrame = true;
        if (Math.abs(video.currentTime - mediaSeconds) > MEDIA_SYNC_EPSILON_MS / 1000) {
          video.currentTime = mediaSeconds;
        }
        if (!video.paused) video.pause();
        ambientVideoRef.current?.pause();
        syncAmbientVideo(mediaSeconds);
      } else if (video.ended || video.paused) {
        const finalPlayheadMs = video.currentTime * 1000;
        commitPlayhead(finalPlayheadMs);
        setPlaying(false);
        return;
      } else {
        holdingSourceFrame = false;
        syncAmbientPlayback(video);
      }

      lastRenderedPlayheadMs = nextPlayheadMs;
      applyPreviewZoom(nextPlayheadMs);
      renderCursorOverlay(nextPlayheadMs);
      if (
        Math.abs(nextPlayheadMs - lastPlayheadCommitRef.current) >=
        COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS
      ) {
        commitPlayhead(nextPlayheadMs);
      }
      void eng.renderFrame(nextPlayheadMs, renderPlan);
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
            syncAmbientPlayback(video);
            void ambientVideoRef.current?.play().catch(() => undefined);
            rafRef.current = requestAnimationFrame(tick);
          }
        })
        .catch(() => {
          if (!disposed) setPlaying(false);
        });
    }

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      ambientVideoRef.current?.pause();
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
    renderCursorOverlay,
    renderPlan,
    resolvedSrc,
    seekPreviewToPlayhead,
    setPlayhead,
    syncAmbientPlayback,
    syncAmbientVideo,
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

  const handleVideoError = useCallback(() => {
    const video = videoRef.current;
    const err = video?.error;
    frontendLog.warn("post-production/PreviewPlayer", "video element failed", {
      fields: {
        src: resolvedSrc,
        code: err?.code ?? null,
        message: err?.message ?? null,
        network_state: video?.networkState ?? null,
        ready_state: video?.readyState ?? null,
      },
    });
  }, [resolvedSrc]);

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
      className="flex h-full w-full flex-col bg-[var(--sc-surface-2)]"
      data-story-id={storyId}
      data-preview-ready={displayReady ? "true" : "false"}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <div
          ref={stageRef}
          className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--sc-r-xl)] border border-[color-mix(in_oklch,var(--sc-border)_72%,transparent)]"
          style={stageStyle}
        >
          {useAmbientBackdrop && resolvedSrc ? (
            <>
              <div
                ref={ambientLayerRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{ background: ambientBackground(DEFAULT_AMBIENT_PALETTE) }}
              />
              {!ambientSamplingReady ? (
                <video
                  ref={ambientVideoRef}
                  aria-hidden="true"
                  tabIndex={-1}
                  muted
                  playsInline
                  preload="auto"
                  src={resolvedSrc}
                  className="pointer-events-none absolute inset-0 h-full w-full scale-[1.08] object-cover opacity-26 blur-3xl saturate-[1.15]"
                />
              ) : null}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(255,255,255,0.08),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(0,0,0,0.16))]"
              />
            </>
          ) : null}
          {resolvedSrc ? null : (
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
          )}
          {!resolvedSrc ? (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center">
              <div className="grid h-16 w-16 place-items-center rounded-[var(--sc-r-xl)] border border-white/10 bg-zinc-950/42 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <Film className="h-7 w-7 text-white/82" />
              </div>
            </div>
          ) : null}

          <div
            className="relative z-10 flex max-w-[1480px] items-center justify-center overflow-visible rounded-[18px] border border-white/14 bg-transparent shadow-[0_22px_58px_-38px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.10)]"
            style={frameStyle}
          >
            <div
              ref={previewFrameContentRef}
              className="relative h-full w-full overflow-hidden rounded-[inherit] will-change-transform"
              data-testid="preview-zoom-layer"
            >
              {resolvedSrc && !useCompositedCanvas ? (
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  preload="auto"
                  src={resolvedSrc}
                  onError={handleVideoError}
                  onLoadedMetadata={handleVideoMetadata}
                  className="relative h-full w-full object-contain"
                  aria-label="Source video preview"
                />
              ) : null}
              {useCompositedCanvas ? (
                <canvas
                  ref={canvasRef}
                  width={width}
                  height={height}
                  className="relative h-full w-full object-contain"
                  aria-label="Composited preview canvas"
                />
              ) : null}
            </div>
            {activeHighlights.length > 0 ? (
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
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
              data-testid="virtual-cursor-overlay"
            >
              <div
                ref={cursorRippleRef}
                className="absolute rounded-full border-2 border-white/80 bg-white/10 opacity-0 shadow-[0_0_18px_rgba(255,255,255,0.28)]"
              />
              <img
                ref={cursorRef}
                alt=""
                className="absolute opacity-0 drop-shadow-[0_5px_12px_rgba(0,0,0,0.42)]"
                draggable={false}
              />
            </div>
            {activeTextOverlays.length > 0 ? (
              <div
                className="pointer-events-none absolute inset-0 overflow-visible"
                data-testid="text-overlay"
              >
                {activeTextOverlays.map((clip) => {
                  const style = resolvedTextStyle(clip);
                  const selected = selectedClipId === clip.id;
                  const editing = editingTextClipId === clip.id;
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
                  const hasBox = Boolean(style.boxStyle);
                  return (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Text overlay ${clip.text}`}
                      data-text-clip-id={clip.id}
                      className={`pointer-events-auto absolute max-w-[78%] whitespace-pre-wrap transition-[box-shadow,outline-color,transform,opacity] ${
                        selected
                          ? "rounded-md outline outline-2 outline-[var(--sc-focus-ring)]"
                          : "outline outline-1 outline-transparent hover:outline-white/32"
                      }`}
                      style={{
                        left: percent(position.x),
                        top: percent(position.y),
                        ...textMotionStyle(style.animation, clip, playheadMs, position.x),
                        color: style.color,
                        fontFamily: font.fontFamily,
                        fontSize: `clamp(12px, ${style.sizePt}px, 72px)`,
                        fontWeight: font.fontWeight,
                        textAlign: style.align,
                        letterSpacing: "0",
                        lineHeight: hasBox ? 1.18 : 1.08,
                        width: "max-content",
                        maxWidth: `${style.maxWidthPct}%`,
                        padding: style.boxStyle ? `${style.boxStyle.paddingPx}px` : undefined,
                        borderRadius: style.boxStyle ? `${style.boxStyle.radiusPx}px` : undefined,
                        background: style.boxStyle?.bgColor,
                        border: style.boxStyle?.borderColor
                          ? `1px solid ${style.boxStyle.borderColor}`
                          : undefined,
                        boxShadow: hasBox
                          ? "inset 0 1px 0 rgba(255,255,255,0.10), 0 16px 42px -28px rgba(0,0,0,0.72)"
                          : "0 3px 12px rgba(0,0,0,0.62)",
                        backdropFilter: hasBox ? "blur(10px)" : undefined,
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
                          autoFocus
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
          <div className="absolute bottom-3 left-3 z-20 rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]/88 px-2.5 py-2 shadow-[var(--sc-sh-1)] backdrop-blur">
            <TransportControls playing={playing} onTogglePlay={togglePlay} />
          </div>
        </div>
        {resolvedSrc && useCompositedCanvas ? (
          <video
            ref={videoRef}
            hidden
            muted
            playsInline
            preload="auto"
            src={resolvedSrc}
            onError={handleVideoError}
            onLoadedMetadata={handleVideoMetadata}
          />
        ) : null}
        {!resolvedSrc ? (
          <video
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
