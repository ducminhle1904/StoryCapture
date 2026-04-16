/**
 * PreviewPlayer (Plan 02-12b).
 *
 * Wraps Plan 04's `PreviewEngine` with a React component:
 *   - owns the <canvas> + hidden <video> refs
 *   - instantiates the engine in useEffect (D-33: single GPU ctx per mount)
 *   - drives `renderFrame` from a requestAnimationFrame loop while playing,
 *     or on-demand when the store playhead changes (scrub case)
 *   - syncs `<video>.currentTime = playheadMs / 1000` on every scrub
 *
 * The PreviewRenderPlan consumed here is a MINIMUM viable plan for P12b
 * — zoom identity, no ripples, no cursor atlas, no background. P05 / P06 /
 * P09 / P11 will enrich the plan builder; the engine already understands
 * the full shape from Plan 04 so no changes are needed here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";

import previewBackdrop from "@/assets/gradients/forest-emerald.png";
import { useEditorStore } from "../state/store";
import type { PreviewRenderPlan } from "./types";
import { PreviewEngine } from "./preview-engine";
import { TransportControls } from "./transport-controls";

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

  // Construct/dispose the engine exactly once per mount — D-33.
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
        // eslint-disable-next-line no-console
        console.warn("[post-production] PreviewEngine init failed", err);
      });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scrub: when playheadMs changes externally, re-render a single frame
  // + sync the <video> element. Skipped while the rAF loop is driving.
  useEffect(() => {
    if (playing) return;
    const eng = engineRef.current;
    if (!eng || !videoRef.current) return;
    videoRef.current.currentTime = playheadMs / 1000;
    void eng.renderFrame(playheadMs, buildPlan(width, height));
  }, [playheadMs, playing, width, height]);

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

  const resolvedSrc = videoSrc
    ? videoSrc.startsWith("asset:") || videoSrc.startsWith("http")
      ? videoSrc
      : convertFileSrc(videoSrc)
    : undefined;

  return (
    <div
      className="flex h-full w-full flex-col bg-[linear-gradient(180deg,#131922_0%,#0f141b_100%)]"
      data-story-id={storyId}
      data-preview-ready={ready ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] px-5 py-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
            Preview
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
            Frame the final output, inspect timing, and scrub before export.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
          <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2 py-1">
            {width}×{height}
          </span>
          <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2 py-1">
            {ready ? "ready" : "warming"}
          </span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#0c1016_0%,#090c11_100%)] p-5">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-fg-primary)] shadow-[var(--shadow-card)]">
          {resolvedSrc ? null : (
            <>
              <img
                src={previewBackdrop}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover opacity-92"
              />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,10,14,0.15),rgba(7,10,14,0.35))]" />
              <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-primary)]/72">
                <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
                  PRV_01_FINAL_RENDER
                </span>
                <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-500)] px-2 py-1">
                  4K UHD
                </span>
              </div>
            </>
          )}
          {!resolvedSrc ? (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center">
              <div className="grid h-20 w-20 place-items-center rounded-[var(--radius-2xl)] border border-[var(--color-border-default)] bg-[var(--color-surface-500)] shadow-[var(--shadow-card)]">
                <Film className="h-8 w-8 text-[var(--color-fg-primary)]/82" />
              </div>
            </div>
          ) : null}

          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="relative z-10 max-h-full max-w-full"
            aria-label="Preview canvas"
          />
        </div>
        <video
          ref={videoRef}
          hidden
          muted
          playsInline
          preload="auto"
          src={resolvedSrc}
          crossOrigin="anonymous"
        />
      </div>
      <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-4 py-3">
        <TransportControls playing={playing} onTogglePlay={togglePlay} />
      </div>
    </div>
  );
}
