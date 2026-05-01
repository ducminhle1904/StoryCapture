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
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import previewBackdrop from "@/assets/gradients/forest-emerald.png";
import { frontendLog } from "@/lib/log";
import { type EditorBackgroundKind, readEditorBackground, useEditorStore } from "../state/store";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";
import type { PreviewRenderPlan } from "./types";

type PreviewOutputMode = "native-video" | "composited-canvas";

const DEFAULT_PREVIEW_OUTPUT_MODE: PreviewOutputMode = "native-video";
const NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS = 16;
const COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS = 100;
const PREVIEW_FRAME_SCALE = 0.86;
const AMBIENT_SAMPLE_WIDTH = 40;
const AMBIENT_SAMPLE_HEIGHT = 22;
const AMBIENT_SAMPLE_INTERVAL_MS = 90;
const AMBIENT_FRAME_SMOOTHING = 0.13;

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
}

function buildPlan(width: number, height: number): PreviewRenderPlan {
  return {
    output_width: width,
    output_height: height,
    fps: 60,
    zoom_matrices: [],
    cursor_atlas_ref: null,
    ripples: [],
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
}: PreviewPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ambientLayerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const [mediaAspect, setMediaAspect] = useState(() => safeAspect(width, height));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const playingRef = useRef(false);

  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const useCompositedCanvas = outputMode === "composited-canvas";
  const displayReady = !useCompositedCanvas || engineReady;
  const renderPlan = useMemo(() => buildPlan(width, height), [width, height]);
  const editorBackground = useEditorStore(readEditorBackground);
  const stageStyle = useMemo(() => stageBackgroundStyle(editorBackground), [editorBackground]);
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
    if (Math.abs(ambientVideo.currentTime - sourceVideo.currentTime) > 0.08) {
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
      if (state.playheadMs === prevState.playheadMs || playingRef.current) return;
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = state.playheadMs / 1000;
      syncAmbientVideo(video.currentTime);
      if (sampleAmbientPalette()) {
        ambientDisplayedPaletteRef.current = smoothPalette(
          ambientDisplayedPaletteRef.current,
          ambientTargetPaletteRef.current,
          0.55,
        );
        applyAmbientPalette(ambientDisplayedPaletteRef.current);
      }
      lastPlayheadCommitRef.current = state.playheadMs;

      if (useCompositedCanvas) {
        const eng = engineRef.current;
        if (eng) void eng.renderFrame(state.playheadMs, renderPlan);
      }
    });
  }, [
    applyAmbientPalette,
    renderPlan,
    sampleAmbientPalette,
    syncAmbientVideo,
    useCompositedCanvas,
  ]);

  useEffect(() => {
    if (playing) return;
    const video = videoRef.current;
    if (!displayReady || !video || !resolvedSrc) return;
    const eng = engineRef.current;
    if (useCompositedCanvas && !eng) return;

    const renderLoadedFrame = () => {
      const currentPlayheadMs = useEditorStore.getState().playheadMs;
      video.currentTime = currentPlayheadMs / 1000;
      syncAmbientVideo(video.currentTime);
      if (sampleAmbientPalette()) {
        ambientDisplayedPaletteRef.current = smoothPalette(
          ambientDisplayedPaletteRef.current,
          ambientTargetPaletteRef.current,
          0.55,
        );
        applyAmbientPalette(ambientDisplayedPaletteRef.current);
      }
      lastPlayheadCommitRef.current = currentPlayheadMs;
      if (useCompositedCanvas && eng) {
        void eng.renderFrame(currentPlayheadMs, renderPlan);
      }
    };

    if (video.readyState >= 2) {
      renderLoadedFrame();
      return;
    }

    video.addEventListener("loadeddata", renderLoadedFrame, { once: true });
    return () => {
      video.removeEventListener("loadeddata", renderLoadedFrame);
    };
  }, [
    displayReady,
    playing,
    applyAmbientPalette,
    renderPlan,
    resolvedSrc,
    sampleAmbientPalette,
    syncAmbientVideo,
    useCompositedCanvas,
  ]);

  useEffect(() => {
    if (!playing || useCompositedCanvas) return;
    const video = videoRef.current;
    if (!video || !resolvedSrc) return;
    let disposed = false;

    const commitCurrentTime = () => {
      const nextPlayheadMs = video.currentTime * 1000;
      setPlayhead(nextPlayheadMs);
      lastPlayheadCommitRef.current = nextPlayheadMs;
    };

    const tick = () => {
      if (disposed) return;
      if (video.ended || video.paused) {
        commitCurrentTime();
        setPlaying(false);
        return;
      }

      const nextPlayheadMs = video.currentTime * 1000;
      syncAmbientPlayback(video);
      if (
        Math.abs(nextPlayheadMs - lastPlayheadCommitRef.current) >=
        NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS
      ) {
        setPlayhead(nextPlayheadMs);
        lastPlayheadCommitRef.current = nextPlayheadMs;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const stopPlayback = () => {
      if (disposed) return;
      commitCurrentTime();
      setPlaying(false);
    };

    video.addEventListener("pause", stopPlayback);
    video.addEventListener("ended", stopPlayback);

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

    return () => {
      disposed = true;
      video.removeEventListener("pause", stopPlayback);
      video.removeEventListener("ended", stopPlayback);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      ambientVideoRef.current?.pause();
      commitCurrentTime();
    };
  }, [playing, resolvedSrc, setPlayhead, syncAmbientPlayback, useCompositedCanvas]);

  // rAF loop while playing the visible composited canvas.
  useEffect(() => {
    if (!playing || !useCompositedCanvas) return;
    const video = videoRef.current;
    const eng = engineRef.current;
    if (!video || !resolvedSrc) return;
    if (!eng) return;
    let disposed = false;

    const tick = () => {
      if (disposed) return;
      if (video.ended || video.paused) {
        const finalPlayheadMs = video.currentTime * 1000;
        setPlayhead(finalPlayheadMs);
        lastPlayheadCommitRef.current = finalPlayheadMs;
        setPlaying(false);
        return;
      }

      const t_ms = video.currentTime * 1000;
      syncAmbientPlayback(video);
      if (
        Math.abs(t_ms - lastPlayheadCommitRef.current) >= COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS
      ) {
        setPlayhead(t_ms);
        lastPlayheadCommitRef.current = t_ms;
      }
      void eng.renderFrame(t_ms, renderPlan);
      rafRef.current = requestAnimationFrame(tick);
    };

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

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      ambientVideoRef.current?.pause();
      const finalPlayheadMs = video.currentTime * 1000;
      setPlayhead(finalPlayheadMs);
      lastPlayheadCommitRef.current = finalPlayheadMs;
    };
  }, [playing, renderPlan, resolvedSrc, setPlayhead, syncAmbientPlayback, useCompositedCanvas]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);

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
            className="relative z-10 flex max-w-[1480px] items-center justify-center overflow-hidden rounded-[18px] border border-white/14 bg-transparent shadow-[0_22px_58px_-38px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.10)]"
            style={frameStyle}
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
