import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  authorDispatchInput,
  startPreviewStream,
  stopPreviewStream,
  type AuthorInputEvent,
  type AuthorKeyModifiers,
  type AuthorMouseButton,
  type PreviewFramePayload,
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

export type PreviewStatus =
  | "attaching"
  | "streaming"
  | "recovering"
  | "unavailable";

function isUnavailableBackend(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" && kind === "UnavailableOnBackend";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SATURATION_LOG_INTERVAL_MS = 30_000;
const RETRY_BACKOFF_MS = 500;

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
  const pendingBitmap = useRef<ImageBitmap | null>(null);
  const rafRef = useRef<number | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const dropCountRef = useRef(0);
  const saturationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("attaching");
  const [focused, setFocused] = useState(false);
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
    const eventName =
      streamId != null ? `preview://frame/${streamId}` : "preview://frame";

    const attachListener = async (): Promise<boolean> => {
      const unlisten = await listen<PreviewFramePayload>(eventName, async (ev) => {
        try {
          const { data } = ev.payload;
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: "image/jpeg" });
          const bmp = await createImageBitmap(blob);
          if (pendingBitmap.current) {
            pendingBitmap.current.close();
            dropCountRef.current += 1;
            if (canvasRef.current) {
              canvasRef.current.dataset.dropCount = String(dropCountRef.current);
            }
          }
          pendingBitmap.current = bmp;
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
        pendingBitmap.current.close();
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
  }, [streamId]);

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
    const button: AuthorMouseButton =
      e.button === 1 ? "middle" : e.button === 2 ? "right" : "left";
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

  const onBeforeInput = (e: React.FormEvent<HTMLCanvasElement>) => {
    if (!inputEnabled || pickerArmed) return;
    const ie = e.nativeEvent as InputEvent;
    const t = ie.inputType;
    // Forward IME-composed text + paste as a single text dispatch so the
    // page receives properly-shaped characters (Vietnamese diacritics,
    // pasted clipboard contents) instead of raw key sequences.
    if (
      t === "insertFromPaste" ||
      t === "insertCompositionText" ||
      t === "insertText"
    ) {
      const text = ie.data ?? "";
      if (text.length === 0) return;
      e.preventDefault();
      dispatchInput({ type: "text", text });
    }
  };

  const onCanvasFocus = () => setFocused(true);

  const onCanvasBlur = () => {
    setFocused(false);
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
      data-input-enabled={inputEnabled}
      data-focused={focused}
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
      onBeforeInput={inputEnabled ? onBeforeInput : undefined}
      onFocus={inputEnabled ? onCanvasFocus : undefined}
      onBlur={inputEnabled ? onCanvasBlur : undefined}
      style={{
        ...style,
        ...(inputEnabled ? { cursor: "default", touchAction: "none" } : {}),
      }}
    />
  );
}
