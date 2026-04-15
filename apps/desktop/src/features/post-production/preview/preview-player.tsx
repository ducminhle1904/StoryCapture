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
      className="flex h-full w-full flex-col bg-black"
      data-story-id={storyId}
      data-preview-ready={ready ? "true" : "false"}
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="max-h-full max-w-full"
          aria-label="Preview canvas"
        />
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
      <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <TransportControls playing={playing} onTogglePlay={togglePlay} />
      </div>
    </div>
  );
}
