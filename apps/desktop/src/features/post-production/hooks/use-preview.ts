/**
 * Preview engine lifecycle hook (Plan 02-12b).
 *
 * Encapsulates the PreviewEngine creation / init / dispose pattern
 * required by D-33 (single GPU context per component lifetime). Returns
 * the engine instance once init resolves, plus a `render(t_ms)` callback
 * the player loop uses to drive frames.
 *
 * Plan 04 owns the engine internals; this hook is strictly wiring.
 */

import { useEffect, useRef, useState, useCallback } from "react";

import { frontendLog } from "@/lib/log";

import { PreviewEngine } from "../preview/preview-engine";
import type { PreviewRenderPlan } from "../preview/types";

export interface UsePreviewArgs {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  outputWidth: number;
  outputHeight: number;
}

export interface UsePreviewResult {
  engine: PreviewEngine | null;
  ready: boolean;
  render: (t_ms: number, plan: PreviewRenderPlan) => void;
}

export function usePreview({
  canvasRef,
  videoRef,
  outputWidth,
  outputHeight,
}: UsePreviewArgs): UsePreviewResult {
  const engineRef = useRef<PreviewEngine | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    let disposed = false;
    const engine = new PreviewEngine({
      canvas,
      videoElement: video,
      outputWidth,
      outputHeight,
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
        // Capture lost / no backend — UI falls back to a static preview
        // poster; surface so we can debug "preview never showed up" reports.
        frontendLog.warn(
          "post-production/usePreview",
          "PreviewEngine init failed (falling back to static poster)",
          {
            error: err,
            fields: { outputWidth, outputHeight },
          },
        );
      });

    // Observe canvas size changes and forward to the backend. Without this
    // the WebGPU swapchain or WebGL2 viewport stays at the initial size
    // and the preview becomes blurry / letterboxed on container resize.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Prefer `contentBoxSize` (physical device px for HiDPI canvases);
      // fall back to `contentRect` for older runtimes.
      let w: number;
      let h: number;
      const box = entry.devicePixelContentBoxSize?.[0] ?? entry.contentBoxSize?.[0];
      if (box) {
        w = box.inlineSize;
        h = box.blockSize;
      } else {
        w = entry.contentRect.width;
        h = entry.contentRect.height;
      }
      if (w <= 0 || h <= 0) return;
      // Keep canvas backing store in sync with CSS size. Setting these
      // attributes is what the WebGPU swapchain reads on `configure`.
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      engineRef.current?.resize(w, h);
    });
    ro.observe(canvas);

    return () => {
      disposed = true;
      ro.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
      setReady(false);
    };
    // outputWidth / outputHeight are the *logical* output resolution and
    // are captured at mount; canvas pixel size is handled by the
    // ResizeObserver above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const render = useCallback((t_ms: number, plan: PreviewRenderPlan) => {
    const eng = engineRef.current;
    if (!eng) return;
    void eng.renderFrame(t_ms, plan);
  }, []);

  return { engine: engineRef.current, ready, render };
}
