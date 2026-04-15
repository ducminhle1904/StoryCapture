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
        // Capture lost / no backend — surface to console; the UI falls
        // back to a static preview poster.
        // eslint-disable-next-line no-console
        console.warn("[post-production] PreviewEngine init failed", err);
      });

    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      setReady(false);
    };
    // outputWidth / outputHeight intentionally captured at mount; resize
    // handling would recreate the engine, not mutate it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const render = useCallback((t_ms: number, plan: PreviewRenderPlan) => {
    const eng = engineRef.current;
    if (!eng) return;
    void eng.renderFrame(t_ms, plan);
  }, []);

  return { engine: engineRef.current, ready, render };
}
