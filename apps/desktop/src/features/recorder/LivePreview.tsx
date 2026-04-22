/**
 * Phase 09-02 — <LivePreview /> canvas renderer.
 *
 * Subscribes to the `preview://frame` Tauri event, decodes each base64
 * JPEG into an ImageBitmap off-main-thread, and draws the latest one on
 * a `<canvas>` at requestAnimationFrame cadence. Backpressure is
 * naturally coalesced — a new frame arriving before rAF drew the last
 * simply replaces it.
 *
 * Preview failure MUST NOT disturb recording — the try/catch around
 * start and the silent-on-error unmount path are intentional isolation
 * (CLAUDE.md), not a workaround.
 */

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  startPreviewStream,
  stopPreviewStream,
  type PreviewFramePayload,
} from "@/ipc/preview";

interface LivePreviewProps {
  width?: number;
  height?: number;
}

type Status = "attaching" | "streaming" | "unavailable";

function isUnavailableBackend(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" && kind === "UnavailableOnBackend";
}

export function LivePreview({ width = 1280, height = 720 }: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingBitmap = useRef<ImageBitmap | null>(null);
  const rafRef = useRef<number | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [status, setStatus] = useState<Status>("attaching");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await startPreviewStream();
      } catch (err) {
        if (isUnavailableBackend(err)) {
          if (!cancelled) setStatus("unavailable");
          return;
        }
        // Other errors: log and render the same neutral placeholder —
        // preview is cosmetic, do not surface via toasts.
        console.warn("startPreviewStream failed:", err);
        if (!cancelled) setStatus("unavailable");
        return;
      }
      if (cancelled) {
        stopPreviewStream().catch(() => {});
        return;
      }

      const unlisten = await listen<PreviewFramePayload>(
        "preview://frame",
        async (ev) => {
          try {
            const { data } = ev.payload;
            const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: "image/jpeg" });
            const bmp = await createImageBitmap(blob);
            if (pendingBitmap.current) {
              pendingBitmap.current.close();
            }
            pendingBitmap.current = bmp;
          } catch (e) {
            // Malformed payload or decode failure — drop the frame.
            console.debug("preview frame decode skipped:", e);
          }
        },
      );
      if (cancelled) {
        unlisten();
        stopPreviewStream().catch(() => {});
        return;
      }
      unlistenRef.current = unlisten;
      setStatus("streaming");

      const draw = () => {
        const canvas = canvasRef.current;
        const bmp = pendingBitmap.current;
        if (canvas && bmp) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          }
          bmp.close();
          pendingBitmap.current = null;
        }
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (pendingBitmap.current) {
        pendingBitmap.current.close();
        pendingBitmap.current = null;
      }
      stopPreviewStream().catch(() => {});
    };
  }, []);

  if (status === "unavailable") {
    return (
      <div
        data-testid="live-preview-unavailable"
        className="flex aspect-video w-full max-w-5xl items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] text-xs text-[var(--color-fg-muted)]"
      >
        Live preview unavailable on this capture target
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="live-preview-canvas"
      width={width}
      height={height}
      className="aspect-video w-full max-w-5xl rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-black"
    />
  );
}
