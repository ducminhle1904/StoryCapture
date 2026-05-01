/**
 * PreviewPlayer — wraps `PreviewEngine` with a React component:
 *   - owns the <canvas> + hidden <video> refs
 *   - instantiates the engine in useEffect (single GPU ctx per mount)
 *   - drives `renderFrame` from a requestAnimationFrame loop while
 *     playing, or on-demand when the store playhead changes (scrub case)
 *   - syncs `<video>.currentTime = playheadMs / 1000` on every scrub
 *
 * The PreviewRenderPlan consumed here is a minimum viable plan: zoom
 * identity, no ripples, no cursor atlas, no background. The engine
 * already understands the full shape, so future enrichments slot in
 * without changes here.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import previewBackdrop from "@/assets/gradients/forest-emerald.png";
import { frontendLog } from "@/lib/log";
import { useEditorStore } from "../state/store";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";
import type { PreviewRenderPlan } from "./types";

export interface PreviewPlayerProps {
  storyId: string;
  /** Absolute or asset:// path to the recorded source video. */
  videoSrc?: string;
  width?: number;
  height?: number;
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
}: PreviewPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  const playheadMs = useEditorStore((s) => s.playheadMs);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);

  const resolvedSrc = videoSrc
    ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
      ? videoSrc
      : convertFileSrc(videoSrc)
    : undefined;

  // Construct/dispose the engine exactly once per mount.
  useEffect(() => {
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
        setReady(true);
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
      setReady(false);
    };
  }, [width, height]);

  // Scrub: when playheadMs changes externally, re-render a single frame
  // + sync the <video> element. Skipped while the rAF loop is driving.
  useEffect(() => {
    if (playing) return;
    const eng = engineRef.current;
    if (!eng || !videoRef.current) return;
    videoRef.current.currentTime = playheadMs / 1000;
    void eng.renderFrame(playheadMs, buildPlan(width, height));
  }, [playheadMs, playing, width, height]);

  useEffect(() => {
    const video = videoRef.current;
    const eng = engineRef.current;
    if (!ready || !video || !eng || !resolvedSrc) return;

    const renderLoadedFrame = () => {
      video.currentTime = playheadMs / 1000;
      void eng.renderFrame(playheadMs, buildPlan(width, height));
    };

    if (video.readyState >= 2) {
      renderLoadedFrame();
      return;
    }

    video.addEventListener("loadeddata", renderLoadedFrame, { once: true });
    return () => {
      video.removeEventListener("loadeddata", renderLoadedFrame);
    };
  }, [resolvedSrc, ready, playheadMs, width, height]);

  // rAF loop while playing.
  useEffect(() => {
    if (!playing) return;
    const video = videoRef.current;
    const eng = engineRef.current;
    if (!video || !eng) return;
    void video.play().catch(() => setPlaying(false));

    const tick = () => {
      const t_ms = video.currentTime * 1000;
      setPlayhead(t_ms);
      void eng.renderFrame(t_ms, buildPlan(width, height));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
    };
  }, [playing, setPlayhead, width, height]);

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
      data-preview-ready={ready ? "true" : "false"}
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

          {resolvedSrc ? (
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
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-0"
            aria-label="Composited preview canvas"
          />
          <div className="absolute bottom-3 left-3 z-20 rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]/88 px-2.5 py-2 shadow-[var(--sc-sh-1)] backdrop-blur">
            <TransportControls playing={playing} onTogglePlay={togglePlay} />
          </div>
        </div>
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
