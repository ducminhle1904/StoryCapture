// Phase 09-04 — editor-surface Live Preview hook.
//
// Manages the ephemeral author-time Playwright session lifecycle for the
// editor preview rail: spawn on toggle-on, teardown on toggle-off /
// unmount, update viewport on switcher change. Cold-start budget is
// preserved by defaulting the toggle OFF (D-17); caller opts in.
//
// If meta.app is missing or not http(s), the backend spawns the session
// on about:blank and the canvas shows the usual muted placeholder until
// the user edits meta.app.

import { useEffect, useRef } from "react";

import {
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
  const streamId = useEditorStore((s) => s.previewStreamId);
  const setStreamId = useEditorStore((s) => s.setPreviewStreamId);

  // Guard against React strict-mode double-invoke and racey toggles.
  const startingRef = useRef(false);

  // Lifecycle — mount a session when enabled, tear it down when disabled
  // or on unmount.
  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      if (startingRef.current || streamId != null) return;
      startingRef.current = true;
      try {
        const { w, h } = VIEWPORT_SIZES[viewport];
        const id = await startAuthorPreview({
          initialUrl: sanitizeAppUrl(appUrl),
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

    const stop = async (id: string) => {
      try {
        await stopAuthorPreview(id);
      } catch (err) {
        console.warn("stop_author_preview failed:", err);
      }
    };

    if (enabled && streamId == null) {
      void start();
    } else if (!enabled && streamId != null) {
      const id = streamId;
      setStreamId(null);
      void stop(id);
    }

    return () => {
      cancelled = true;
    };
  }, [enabled, streamId, viewport, appUrl, setStreamId]);

  // Final unmount — kill any still-running session.
  useEffect(() => {
    return () => {
      const id = useEditorStore.getState().previewStreamId;
      if (id != null) {
        stopAuthorPreview(id).catch(() => {});
        useEditorStore.getState().setPreviewStreamId(null);
      }
    };
  }, []);

  // Viewport switcher → setViewport RPC. Debounced-free: happens on every
  // click, cheap page.setViewportSize call.
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

  return { streamId, enabled };
}
