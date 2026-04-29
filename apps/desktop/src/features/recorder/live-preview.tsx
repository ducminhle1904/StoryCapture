import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import {
  type AuthorInputEvent,
  type AuthorKeyModifiers,
  type AuthorMouseButton,
  authorDispatchInput,
  type PreviewFramePayload,
  startPreviewStream,
  stopPreviewStream,
} from "@/ipc/preview";
import { frontendLog } from "@/lib/log";

interface LivePreviewProps {
  width?: number;
  height?: number;
  // When set, lifecycle is owned externally and frames arrive on the
  // per-stream event channel `preview://frame/${streamId}`.
  streamId?: string | null;
  // Page viewport dimensions in CSS px — used to transform canvas coords
  // into page coords when forwarding pointer events to the headless
  // author browser. Set to null to disable input forwarding (read-only
  // preview). Default: null.
  pageWidth?: number | null;
  pageHeight?: number | null;
  // When the picker overlay is armed in the headless browser, suppress
  // keyboard forwarding so the user's element-selection key presses
  // don't insert text into focused fields. Sidecar enforces the same
  // gate as a defense-in-depth.
  pickerArmed?: boolean;
  className?: string;
  style?: CSSProperties;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const MODIFIER_CODE: Record<string, string> = {
  Shift: "ShiftLeft",
  Control: "ControlLeft",
  Alt: "AltLeft",
  Meta: "MetaLeft",
};
// Cmd/Ctrl + these keys must reach the desktop app (preferences/quit/
// close-window) instead of being eaten by the canvas. Everything else
// gets forwarded.
const ESCAPE_META_KEYS = new Set([",", "q", "w"]);

function shouldEscapeToApp(e: React.KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  return ESCAPE_META_KEYS.has(e.key.toLowerCase());
}

function extractMods(e: React.KeyboardEvent): AuthorKeyModifiers {
  return {
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

export type PreviewStatus = "attaching" | "streaming" | "recovering" | "unavailable";

function isUnavailableBackend(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" && kind === "UnavailableOnBackend";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SATURATION_LOG_INTERVAL_MS = 30_000;
const DIMENSION_MISMATCH_LOG_INTERVAL_MS = 30_000;
const RETRY_BACKOFF_MS = 500;

type PendingPreviewBitmap = {
  bitmap: ImageBitmap;
  sharp: boolean;
};

function frameMimeType(frame: PreviewFramePayload): string {
  if (typeof frame.mimeType === "string" && frame.mimeType.length > 0) return frame.mimeType;
  return frame.format === "png" ? "image/png" : "image/jpeg";
}

function isEffectiveSharpFrame(
  frame: Pick<PreviewFramePayload, "format" | "sharp">,
  bmp: ImageBitmap,
  baseWidth: number,
  baseHeight: number,
): boolean {
  return (
    frame.sharp === true &&
    frame.format === "png" &&
    bmp.width >= baseWidth * 1.5 &&
    bmp.height >= baseHeight * 1.5
  );
}

function isSameAspectRatio(aWidth: number, aHeight: number, bWidth: number, bHeight: number) {
  return Math.abs(aWidth / aHeight - bWidth / bHeight) < 0.01;
}

function shouldResizeCanvasForFrame(
  canvas: HTMLCanvasElement,
  bmp: ImageBitmap,
  pending: PendingPreviewBitmap,
): boolean {
  if (pending.sharp) return canvas.width !== bmp.width || canvas.height !== bmp.height;
  const wouldDownscaleSharpBacking =
    canvas.width > bmp.width &&
    canvas.height > bmp.height &&
    isSameAspectRatio(canvas.width, canvas.height, bmp.width, bmp.height);
  return (
    !wouldDownscaleSharpBacking && (canvas.width !== bmp.width || canvas.height !== bmp.height)
  );
}

function updatePreviewDiagnostics(
  canvas: HTMLCanvasElement,
  frame: Pick<PreviewFramePayload, "width" | "height" | "format" | "sharp">,
  bmp: ImageBitmap,
  effectiveSharp: boolean,
  lastDimensionsRef: { current: string },
  lastLogRef: { current: number },
) {
  const dimensionsKey = `${frame.width}x${frame.height}/${bmp.width}x${bmp.height}/${frame.format ?? "jpeg"}`;
  if (lastDimensionsRef.current !== dimensionsKey) {
    lastDimensionsRef.current = dimensionsKey;
    canvas.dataset.frameWidth = String(frame.width);
    canvas.dataset.frameHeight = String(frame.height);
    canvas.dataset.bitmapWidth = String(bmp.width);
    canvas.dataset.bitmapHeight = String(bmp.height);
    canvas.dataset.frameFormat = frame.format ?? "jpeg";
    canvas.dataset.frameSharp = effectiveSharp ? "true" : "false";
    if (effectiveSharp) {
      frontendLog.info("LivePreview", "sharp frame decoded", {
        fields: {
          frame_width: frame.width,
          frame_height: frame.height,
          bitmap_width: bmp.width,
          bitmap_height: bmp.height,
          canvas_width: canvas.width,
          canvas_height: canvas.height,
          format: frame.format ?? "png",
        },
      });
    }
  }

  if (bmp.width === canvas.width && bmp.height === canvas.height) return;
  const expectedSharpMismatch =
    effectiveSharp &&
    bmp.width >= canvas.width &&
    bmp.height >= canvas.height &&
    isSameAspectRatio(bmp.width, bmp.height, canvas.width, canvas.height);
  const expectedRealtimeOnSharpBacking =
    !effectiveSharp &&
    frame.sharp !== true &&
    canvas.width >= bmp.width * 1.5 &&
    canvas.height >= bmp.height * 1.5 &&
    isSameAspectRatio(canvas.width, canvas.height, bmp.width, bmp.height);
  if (expectedSharpMismatch || expectedRealtimeOnSharpBacking) return;
  const now = Date.now();
  if (now - lastLogRef.current < DIMENSION_MISMATCH_LOG_INTERVAL_MS) return;
  lastLogRef.current = now;
  frontendLog.warn("LivePreview", "frame dimension mismatch", {
    fields: {
      frame_width: frame.width,
      frame_height: frame.height,
      bitmap_width: bmp.width,
      bitmap_height: bmp.height,
      canvas_width: canvas.width,
      canvas_height: canvas.height,
      format: frame.format ?? "jpeg",
      sharp: frame.sharp === true,
      effective_sharp: effectiveSharp,
    },
  });
}

export function LivePreview({
  width = 1280,
  height = 720,
  streamId = null,
  pageWidth = null,
  pageHeight = null,
  pickerArmed = false,
  className,
  style,
}: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingBitmap = useRef<PendingPreviewBitmap | null>(null);
  const rafRef = useRef<number | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const dropCountRef = useRef(0);
  const lastPreviewDimensionsRef = useRef("");
  const lastDimensionMismatchLogRef = useRef(0);
  const saturationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("attaching");
  // Tracks modifier keys currently pressed inside the canvas so that we
  // can synthesize keyup events on blur — otherwise Playwright's keyboard
  // state stays "Shift down" forever after the user blurs mid-press.
  const heldModifiersRef = useRef<Set<string>>(new Set());

  // rAF-throttled mousemove forwarding. On every pointermove we stash the
  // latest page coord; the rAF callback reads the stash, dispatches once,
  // and clears. Flood of native moves (~200-1000Hz) collapses to 60Hz IPC.
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const inputEnabled = streamId != null && pageWidth != null && pageHeight != null;

  const toPageCoord = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas || pageWidth == null || pageHeight == null) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * pageWidth;
      const y = ((clientY - rect.top) / rect.height) * pageHeight;
      if (x < 0 || y < 0 || x > pageWidth || y > pageHeight) return null;
      return { x, y };
    },
    [pageWidth, pageHeight],
  );

  const dispatchInput = useCallback(
    (event: AuthorInputEvent) => {
      if (streamId == null) return;
      authorDispatchInput(streamId, event).catch((err) => {
        // IPC is best-effort; session may have torn down between hover and dispatch.
        console.debug("authorDispatchInput failed:", err);
      });
    },
    [streamId],
  );

  // Cleanup pending rAF + held-modifier state on unmount / stream change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stream changes must clear stale input state even though the cleanup only touches refs.
  useEffect(() => {
    return () => {
      if (moveRafRef.current != null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      pendingMoveRef.current = null;
      heldModifiersRef.current.clear();
    };
  }, [streamId]);

  useEffect(() => {
    let cancelled = false;
    const eventName = streamId != null ? `preview://frame/${streamId}` : "preview://frame";

    const attachListener = async (): Promise<boolean> => {
      const unlisten = await listen<PreviewFramePayload>(eventName, async (ev) => {
        try {
          const { data } = ev.payload;
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: frameMimeType(ev.payload) });
          const bmp = await createImageBitmap(blob);
          const canvas = canvasRef.current;
          const effectiveSharp = isEffectiveSharpFrame(ev.payload, bmp, width, height);
          if (canvas) {
            updatePreviewDiagnostics(
              canvas,
              ev.payload,
              bmp,
              effectiveSharp,
              lastPreviewDimensionsRef,
              lastDimensionMismatchLogRef,
            );
          }
          if (ev.payload.sharp === true && !effectiveSharp) {
            bmp.close();
            return;
          }
          if (pendingBitmap.current) {
            pendingBitmap.current.bitmap.close();
            dropCountRef.current += 1;
            if (canvasRef.current) {
              canvasRef.current.dataset.dropCount = String(dropCountRef.current);
            }
          }
          pendingBitmap.current = { bitmap: bmp, sharp: effectiveSharp };
        } catch (e) {
          console.debug("preview frame decode skipped:", e);
        }
      });
      if (cancelled) {
        unlisten();
        return false;
      }
      unlistenRef.current = unlisten;
      return true;
    };

    const scheduleDraw = () => {
      if (rafRef.current != null) return;
      const draw = () => {
        const canvas = canvasRef.current;
        const pending = pendingBitmap.current;
        const bmp = pending?.bitmap ?? null;
        if (canvas && pending && bmp) {
          if (shouldResizeCanvasForFrame(canvas, bmp, pending)) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            canvas.dataset.canvasBackingWidth = String(bmp.width);
            canvas.dataset.canvasBackingHeight = String(bmp.height);
            if (pending.sharp) {
              frontendLog.info("LivePreview", "sharp frame promoted to canvas", {
                fields: {
                  canvas_backing_width: bmp.width,
                  canvas_backing_height: bmp.height,
                  css_width: canvas.getBoundingClientRect().width,
                  css_height: canvas.getBoundingClientRect().height,
                },
              });
            }
          }
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          }
          bmp.close();
          pendingBitmap.current = null;
        }
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
    };

    const startWithRetry = async (retriesLeft: number): Promise<void> => {
      if (streamId != null) {
        if (cancelled) return;
        const attached = await attachListener();
        if (!attached) return;
        setStatus("streaming");
        scheduleDraw();
        return;
      }
      try {
        await startPreviewStream();
      } catch (err) {
        if (isUnavailableBackend(err)) {
          if (!cancelled) setStatus("unavailable");
          return;
        }
        if (retriesLeft > 0) {
          if (!cancelled) setStatus("recovering");
          await delay(RETRY_BACKOFF_MS);
          if (cancelled) return;
          return startWithRetry(retriesLeft - 1);
        }
        frontendLog.warn("LivePreview", "startPreviewStream failed after retry", { error: err });
        if (!cancelled) setStatus("unavailable");
        return;
      }

      if (cancelled) {
        stopPreviewStream().catch(() => {});
        return;
      }

      const attached = await attachListener();
      if (!attached) {
        stopPreviewStream().catch(() => {});
        return;
      }
      setStatus("streaming");
      scheduleDraw();
    };

    saturationTimerRef.current = setInterval(() => {
      if (dropCountRef.current > 0) {
        frontendLog.warn("LivePreview", "frames dropped", {
          fields: { dropped: dropCountRef.current },
        });
        dropCountRef.current = 0;
      }
    }, SATURATION_LOG_INTERVAL_MS);

    void startWithRetry(1);

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
        pendingBitmap.current.bitmap.close();
        pendingBitmap.current = null;
      }
      if (saturationTimerRef.current) {
        clearInterval(saturationTimerRef.current);
        saturationTimerRef.current = null;
      }
      if (streamId == null) {
        stopPreviewStream().catch(() => {});
      }
    };
  }, [streamId, width, height]);

  if (status === "unavailable") {
    return (
      <div
        data-testid="live-preview-unavailable"
        className="flex aspect-video w-full max-w-5xl items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] text-xs text-[var(--color-fg-muted)]"
      >
        Live preview unavailable on this backend
      </div>
    );
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    const p = toPageCoord(e.clientX, e.clientY);
    if (!p) return;
    pendingMoveRef.current = p;
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const latest = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (latest) {
        dispatchInput({ type: "mousemove", x: latest.x, y: latest.y });
      }
    });
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    // Pull focus to the canvas so the user can immediately start typing
    // after a click — without this, keydown listeners never fire.
    canvasRef.current?.focus();
    const p = toPageCoord(e.clientX, e.clientY);
    if (!p) return;
    const button: AuthorMouseButton = e.button === 1 ? "middle" : e.button === 2 ? "right" : "left";
    dispatchInput({ type: "click", x: p.x, y: p.y, button });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!inputEnabled || pickerArmed) return;
    if (shouldEscapeToApp(e)) return;
    e.preventDefault();
    if (MODIFIER_KEYS.has(e.key)) {
      heldModifiersRef.current.add(e.key);
    }
    dispatchInput({
      type: "keydown",
      key: e.key,
      code: e.code,
      modifiers: extractMods(e),
      repeat: e.repeat,
    });
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!inputEnabled || pickerArmed) return;
    if (shouldEscapeToApp(e)) return;
    e.preventDefault();
    if (MODIFIER_KEYS.has(e.key)) {
      heldModifiersRef.current.delete(e.key);
    }
    dispatchInput({
      type: "keyup",
      key: e.key,
      code: e.code,
      modifiers: extractMods(e),
    });
  };

  // Paste: read the clipboard payload and forward it as a single text
  // event so the page sees the full string in one shot. `paste` fires on
  // focused tabIndex-able elements, including a canvas — beforeinput
  // does not, since canvas is not editable.
  const onPaste = (e: React.ClipboardEvent<HTMLCanvasElement>) => {
    if (!inputEnabled || pickerArmed) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    e.preventDefault();
    dispatchInput({ type: "text", text });
  };

  // IME composition: commit the composed text as a single text event so
  // diacritics (Vietnamese, etc.) reach the page intact. The browser
  // also fires a synthetic keyup at the end of composition; that's
  // harmless because the page never saw the matching keydown.
  const onCompositionEnd = (e: React.CompositionEvent<HTMLCanvasElement>) => {
    if (!inputEnabled || pickerArmed) return;
    const text = e.data ?? "";
    if (text.length === 0) return;
    dispatchInput({ type: "text", text });
  };

  const onCanvasBlur = () => {
    // Release any modifier still considered held — otherwise Playwright
    // keeps "Shift down" until the next matching keyup, which may never
    // arrive once focus has left the canvas.
    if (inputEnabled) {
      for (const k of heldModifiersRef.current) {
        dispatchInput({
          type: "keyup",
          key: k,
          code: MODIFIER_CODE[k] ?? k,
          modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        });
      }
    }
    heldModifiersRef.current.clear();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!inputEnabled) return;
    const p = toPageCoord(e.clientX, e.clientY);
    if (!p) return;
    // Block the surrounding panel from scrolling while the pointer is
    // over a wheel-forwarded canvas.
    e.preventDefault();
    dispatchInput({
      type: "wheel",
      x: p.x,
      y: p.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="live-preview-canvas"
      data-status={status}
      data-drop-count="0"
      data-frame-width="0"
      data-frame-height="0"
      data-bitmap-width="0"
      data-bitmap-height="0"
      data-canvas-backing-width={width}
      data-canvas-backing-height={height}
      data-frame-format="jpeg"
      data-frame-sharp="false"
      data-input-enabled={inputEnabled}
      tabIndex={inputEnabled ? 0 : -1}
      width={width}
      height={height}
      className={
        className ??
        "aspect-video w-full max-w-5xl rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--sc-n-950)]"
      }
      onPointerMove={inputEnabled ? onPointerMove : undefined}
      onClick={inputEnabled ? onClick : undefined}
      onWheel={inputEnabled ? onWheel : undefined}
      onKeyDown={inputEnabled ? onKeyDown : undefined}
      onKeyUp={inputEnabled ? onKeyUp : undefined}
      onPaste={inputEnabled ? onPaste : undefined}
      onCompositionEnd={inputEnabled ? onCompositionEnd : undefined}
      onBlur={inputEnabled ? onCanvasBlur : undefined}
      style={{
        ...style,
        ...(inputEnabled ? { cursor: "default", touchAction: "none" } : {}),
      }}
    />
  );
}
