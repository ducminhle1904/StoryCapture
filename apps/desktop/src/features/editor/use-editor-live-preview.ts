import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
  acquirePreview,
  INITIAL_NAV,
  pausePreview,
  type PreviewLifecycleStatus,
  type PreviewNavState,
  resumePreview,
  subscribeNav,
  subscribeStatus,
  updateAppUrl,
  updateViewport,
} from "@/features/editor/preview-lifecycle";
import { frontendLog } from "@/lib/log";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

const COLD_START_DEFER_MS = 250;

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
  const viewport = useEditorStore((s) => s.previewViewport);
  const [streamId, setStreamId] = useState<string | null>(null);
  const sanitized = sanitizeAppUrl(appUrl);

  useEffect(() => {
    if (sanitized == null) return;

    let release: (() => void) | null = null;
    const deferHandle = window.setTimeout(() => {
      release = acquirePreview(sanitized, viewport, (id) => setStreamId(id));
    }, COLD_START_DEFER_MS);

    return () => {
      window.clearTimeout(deferHandle);
      if (release) release();
      setStreamId(null);
    };
  }, [sanitized]);

  useEffect(() => {
    if (streamId == null) return;
    updateAppUrl(sanitized ?? "");
  }, [streamId, sanitized]);

  useEffect(() => {
    if (streamId == null) return;
    updateViewport(viewport);
  }, [streamId, viewport]);

  const simulatorRunning = useSimulatorStore((s) => s.runState === "running");
  const [windowFocused, setWindowFocused] = useState(true);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onFocusChanged(({ payload }) => {
          setWindowFocused(Boolean(payload));
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch (err) {
        frontendLog.warn(
          "useEditorLivePreview",
          "webview onFocusChanged listener registration failed",
          { error: err },
        );
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (streamId == null) return;
    const shouldPause = simulatorRunning || !windowFocused;
    if (shouldPause) pausePreview();
    else resumePreview();
  }, [streamId, simulatorRunning, windowFocused]);

  const [nav, setNav] = useState<PreviewNavState>(INITIAL_NAV);
  useEffect(() => subscribeNav(setNav), []);

  const [lifecycleStatus, setLifecycleStatus] =
    useState<PreviewLifecycleStatus>("idle");
  useEffect(() => subscribeStatus(setLifecycleStatus), []);

  return {
    streamId,
    appUrlValid: sanitized != null,
    nav,
    status: sanitized == null ? "idle" : lifecycleStatus,
  };
}
