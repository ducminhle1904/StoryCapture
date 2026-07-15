import { useEffect, useRef } from "react";

import {
  CanonicalExportCompositorAdapter,
  type CanonicalExportCompositorPayload,
} from "./canonical-export-adapter";

export type ExportCompositorPayload = CanonicalExportCompositorPayload;

interface ExportCompositorBridge {
  configure(payload: ExportCompositorPayload): Promise<{ ok: true }>;
  renderFrame(timeMs: number): Promise<{ ok: true }>;
  dispose(): Promise<{ ok: true }>;
}

declare global {
  interface Window {
    __STORYCAPTURE_EXPORT_COMPOSITOR__?: ExportCompositorBridge;
  }
}

export function ExportCompositorApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const compositor = new CanonicalExportCompositorAdapter(canvas);
    window.__STORYCAPTURE_EXPORT_COMPOSITOR__ = {
      configure: (payload) => compositor.configure(payload),
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
        background: "#000",
      }}
    />
  );
}
