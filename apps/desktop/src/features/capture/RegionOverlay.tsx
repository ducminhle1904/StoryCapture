/**
 * RegionOverlay for selecting a capture region.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function RegionOverlay() {
  const [searchParams] = useSearchParams();
  const displayId = Number(searchParams.get("display_id") ?? "0");

  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [currentPt, setCurrentPt] = useState<{ x: number; y: number } | null>(
    null,
  );
  const confirmingRef = useRef(false);

  const rect: Rect | null = useMemo(() => {
    if (!startPt || !currentPt) return null;
    const x = Math.min(startPt.x, currentPt.x);
    const y = Math.min(startPt.y, currentPt.y);
    const w = Math.abs(currentPt.x - startPt.x);
    const h = Math.abs(currentPt.y - startPt.y);
    return { x, y, w, h };
  }, [startPt, currentPt]);

  const emitAndClose = useCallback(
    async (payload: Record<string, unknown>) => {
      if (confirmingRef.current) return;
      confirmingRef.current = true;
      try {
        // Emit to the main window only.
        await emitTo("main", "region://selected", payload);
      } catch (e) {
        // Non-fatal: surface the reason if the main window is gone.
        // eslint-disable-next-line no-console
        console.warn("[RegionOverlay] emit region://selected failed:", e);
      } finally {
        try {
          await getCurrentWebviewWindow().close();
        } catch (e) {
          // The overlay may already be closing.
          // eslint-disable-next-line no-console
          console.warn("[RegionOverlay] close overlay window failed:", e);
        }
      }
    },
    [],
  );

  const commit = useCallback(
    async (r: Rect | null) => {
      if (!r || r.w < 1 || r.h < 1) {
        await emitAndClose({ cancelled: true });
        return;
      }
      await emitAndClose({
        display_id: displayId,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
      });
    },
    [displayId, emitAndClose],
  );

  const cancel = useCallback(async () => {
    await emitAndClose({ cancelled: true });
  }, [emitAndClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void commit(rect);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, commit, rect]);

  return (
    <div
      role="dialog"
      aria-label="Select capture region"
      className="fixed inset-0 select-none"
      style={{
        cursor: "crosshair",
        // Subtle dim for visibility.
        background: "rgba(0, 0, 0, 0.2)",
      }}
      onMouseDown={(e) => {
        setStartPt({ x: e.clientX, y: e.clientY });
        setCurrentPt({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e) => {
        if (startPt) setCurrentPt({ x: e.clientX, y: e.clientY });
      }}
      onMouseUp={(e) => {
        const final = {
          x: Math.min(startPt?.x ?? e.clientX, e.clientX),
          y: Math.min(startPt?.y ?? e.clientY, e.clientY),
          w: Math.abs(e.clientX - (startPt?.x ?? e.clientX)),
          h: Math.abs(e.clientY - (startPt?.y ?? e.clientY)),
        };
        void commit(final);
      }}
    >
      {rect && (
        <>
          <div
            data-testid="region-rect"
            className="pointer-events-none absolute border-2 border-[var(--color-accent-primary,_#3ea6ff)]"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              background: "rgba(62, 166, 255, 0.1)",
            }}
          />
          <div
            data-testid="region-dimensions"
            className="font-mono pointer-events-none absolute rounded-sm bg-black/70 px-2 py-0.5 text-[11px] tabular-nums text-white"
            style={{
              left: rect.x + 4,
              top: Math.max(0, rect.y - 20),
            }}
          >
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </div>
        </>
      )}

      {/* Affordance hint */}
      <div
        className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-black/70 px-3 py-1.5 text-[11px] text-white/90"
        aria-hidden="true"
      >
        Drag to draw a region · Enter to confirm · Esc to cancel
      </div>
    </div>
  );
}
