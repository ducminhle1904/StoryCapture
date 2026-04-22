import { useEffect, useRef, useState } from "react";

import {
  setAuthorPreviewUrl,
  setAuthorPreviewViewport,
  startAuthorPreview,
  stopAuthorPreview,
} from "@/ipc/preview";
import {
  VIEWPORT_SIZES,
  type PreviewViewport,
  useEditorStore,
} from "@/state/editor";

function sanitizeAppUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return raw;
  } catch {
    /* not a URL */
  }
  return null;
}

export function useEditorLivePreview(appUrl: string | null | undefined) {
  const enabled = useEditorStore((s) => s.previewEnabled);
  const viewport = useEditorStore((s) => s.previewViewport);
  const [streamId, setStreamId] = useState<string | null>(null);
  const streamIdRef = useRef<string | null>(null);
  streamIdRef.current = streamId;

  const startingRef = useRef(false);
  const appUrlRef = useRef(appUrl);
  const viewportRef = useRef(viewport);
  appUrlRef.current = appUrl;
  viewportRef.current = viewport;

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      if (startingRef.current || streamIdRef.current != null) return;
      startingRef.current = true;
      try {
        const { w, h } = VIEWPORT_SIZES[viewportRef.current];
        const id = await startAuthorPreview({
          initialUrl: sanitizeAppUrl(appUrlRef.current),
          viewportWidth: w,
          viewportHeight: h,
        });
        if (cancelled) {
          stopAuthorPreview(id).catch(() => {});
          return;
        }
        setStreamId(id);
      } catch (err) {
        console.warn("start_author_preview failed:", err);
      } finally {
        startingRef.current = false;
      }
    };

    if (enabled) {
      void start();
    } else if (streamIdRef.current != null) {
      const id = streamIdRef.current;
      setStreamId(null);
      stopAuthorPreview(id).catch((err) => {
        console.warn("stop_author_preview failed:", err);
      });
    }

    return () => {
      cancelled = true;
      if (enabled && streamIdRef.current != null) {
        const id = streamIdRef.current;
        setStreamId(null);
        stopAuthorPreview(id).catch(() => {});
      }
    };
  }, [enabled]);

  const lastSentViewport = useRef<PreviewViewport | null>(null);
  useEffect(() => {
    if (streamId == null) return;
    if (lastSentViewport.current === viewport) return;
    lastSentViewport.current = viewport;
    const { w, h } = VIEWPORT_SIZES[viewport];
    setAuthorPreviewViewport(streamId, w, h).catch((err) => {
      console.warn("set_author_preview_viewport failed:", err);
    });
  }, [streamId, viewport]);

  const lastSentUrl = useRef<string | null>(null);
  useEffect(() => {
    if (streamId == null) return;
    const url = sanitizeAppUrl(appUrl);
    if (url == null) return;
    if (lastSentUrl.current === url) return;
    lastSentUrl.current = url;
    setAuthorPreviewUrl(streamId, url).catch((err) => {
      console.warn("set_author_preview_url failed:", err);
    });
  }, [streamId, appUrl]);

  return { streamId, enabled };
}
