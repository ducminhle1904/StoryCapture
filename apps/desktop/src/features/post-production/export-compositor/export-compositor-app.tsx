import { useEffect, useRef } from "react";

import {
  CanonicalExportCompositorAdapter,
  type CanonicalExportCompositorPayload,
} from "./canonical-export-adapter";

export type ExportCompositorPayload = CanonicalExportCompositorPayload;

export interface ExportCompositorViewport {
  canvasBackingWidth: number;
  canvasBackingHeight: number;
  cssViewportWidth: number;
  cssViewportHeight: number;
  devicePixelRatio: number;
}

interface ExportCompositorBridge {
  configure(
    payload: ExportCompositorPayload,
  ): Promise<{ ok: true; viewport: ExportCompositorViewport }>;
  renderFrame(timeMs: number): Promise<{ ok: true }>;
  dispose(): Promise<{ ok: true }>;
}

declare global {
  interface Window {
    __STORYCAPTURE_EXPORT_COMPOSITOR__?: ExportCompositorBridge;
  }
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function readExportCompositorViewport(canvas: HTMLCanvasElement): ExportCompositorViewport {
  const rect = canvas.getBoundingClientRect();
  return {
    canvasBackingWidth: canvas.width,
    canvasBackingHeight: canvas.height,
    cssViewportWidth: rect.width,
    cssViewportHeight: rect.height,
    devicePixelRatio: positiveFinite(window.devicePixelRatio, 1),
  };
}

export function ExportCompositorApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const compositor = new CanonicalExportCompositorAdapter(canvas);
    window.__STORYCAPTURE_EXPORT_COMPOSITOR__ = {
      configure: async (payload) => {
        await compositor.configure(payload);
        const dpr = positiveFinite(window.devicePixelRatio, 1);
        const cssWidth = positiveFinite(payload.cssViewportWidth, payload.graph.output_width / dpr);
        const cssHeight = positiveFinite(
          payload.cssViewportHeight,
          payload.graph.output_height / dpr,
        );
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        return { ok: true, viewport: readExportCompositorViewport(canvas) };
      },
      renderFrame: async (timeMs) => {
        await compositor.renderFrame(timeMs);
        return { ok: true };
      },
      dispose: () => compositor.dispose(),
    };
    return () => {
      void compositor.dispose();
      delete window.__STORYCAPTURE_EXPORT_COMPOSITOR__;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        position: "fixed",
        inset: 0,
        right: "auto",
        bottom: "auto",
        background: "#000",
      }}
    />
  );
}
