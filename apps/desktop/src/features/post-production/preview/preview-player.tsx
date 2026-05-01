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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import previewBackdrop from "@/assets/gradients/forest-emerald.png";
import { frontendLog } from "@/lib/log";
import { useEditorStore } from "../state/store";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";
import type { PreviewRenderPlan } from "./types";

type PreviewOutputMode = "native-video" | "composited-canvas";

const DEFAULT_PREVIEW_OUTPUT_MODE: PreviewOutputMode = "native-video";
const NATIVE_PLAYHEAD_COMMIT_INTERVAL_MS = 16;
const COMPOSITED_PLAYHEAD_COMMIT_INTERVAL_MS = 100;

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

export function PreviewPlayer({
  storyId,
  videoSrc,
  width = 1920,
  height = 1080,
  outputMode = DEFAULT_PREVIEW_OUTPUT_MODE,
}: PreviewPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastPlayheadCommitRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const playingRef = useRef(false);

  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const useCompositedCanvas = outputMode === "composited-canvas";
  const displayReady = !useCompositedCanvas || engineReady;
  const renderPlan = useMemo(() => buildPlan(width, height), [width, height]);

  const resolvedSrc = videoSrc
    ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
      ? videoSrc
      : convertFileSrc(videoSrc)
    : undefined;

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
    return useEditorStore.subscribe((state, prevState) => {
      if (state.playheadMs === prevState.playheadMs || playingRef.current) return;
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = state.playheadMs / 1000;
      lastPlayheadCommitRef.current = state.playheadMs;

      if (useCompositedCanvas) {
        const eng = engineRef.current;
        if (eng) void eng.renderFrame(state.playheadMs, renderPlan);
      }
    });
  }, [renderPlan, useCompositedCanvas]);

  useEffect(() => {
    if (playing) return;
    const video = videoRef.current;
    if (!displayReady || !video || !resolvedSrc) return;
    const eng = engineRef.current;
    if (useCompositedCanvas && !eng) return;

    const renderLoadedFrame = () => {
      const currentPlayheadMs = useEditorStore.getState().playheadMs;
      video.currentTime = currentPlayheadMs / 1000;
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
  }, [displayReady, playing, renderPlan, resolvedSrc, useCompositedCanvas]);

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
        if (!disposed) rafRef.current = requestAnimationFrame(tick);
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
      commitCurrentTime();
    };
  }, [playing, resolvedSrc, setPlayhead, useCompositedCanvas]);

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
        if (!disposed) rafRef.current = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!disposed) setPlaying(false);
      });

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      const finalPlayheadMs = video.currentTime * 1000;
      setPlayhead(finalPlayheadMs);
      lastPlayheadCommitRef.current = finalPlayheadMs;
    };
  }, [playing, renderPlan, resolvedSrc, setPlayhead, useCompositedCanvas]);

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

  return (
    <div
      className="flex h-full w-full flex-col bg-[var(--sc-surface-2)]"
      data-story-id={storyId}
      data-preview-ready={displayReady ? "true" : "false"}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[color-mix(in_oklch,var(--sc-text)_5%,var(--sc-surface))] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--sc-surface)_92%,transparent)]">
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

          {resolvedSrc && !useCompositedCanvas ? (
            <video
              ref={videoRef}
              muted
              playsInline
              preload="auto"
              src={resolvedSrc}
              onError={handleVideoError}
              className="relative z-10 h-full w-full object-contain"
              aria-label="Source video preview"
            />
          ) : null}
          {useCompositedCanvas ? (
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              className="relative z-10 h-full w-full object-contain"
              aria-label="Composited preview canvas"
            />
          ) : null}
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
