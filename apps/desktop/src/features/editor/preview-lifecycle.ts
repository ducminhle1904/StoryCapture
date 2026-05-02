/**
 * Module-level singleton that owns the author-preview Chromium lifecycle.
 *
 * Moved out of React hooks so that the Chromium instance survives the
 * editor component's unmount → remount cycle. This covers two cases:
 *
 *   - Navigating away from /editor and back within the grace window
 *     (e.g. to /recorder to check a capture, then back to iterate).
 *   - Remounting inside the same route when `projectId` changes —
 *     the same Chromium navigates via `setAuthorPreviewUrl` instead
 *     of paying a full cold-start.
 *
 * Subscribers (the editor hook) observe `streamId` updates and drive
 * rendering. The singleton also handles pause/resume to suspend the
 * CDP screencast when no one is looking (window blurred, simulator
 * owns the page), without tearing Chromium down.
 */

import { listen } from "@tauri-apps/api/event";

import {
  type AuthorPreviewNavPayload,
  pauseAuthorPreview,
  resumeAuthorPreview,
  setAuthorPreviewUrl,
  setAuthorPreviewViewport,
  startAuthorPreview,
  stopAuthorPreview,
} from "@/ipc/preview";
import { frontendLog } from "@/lib/log";
import {
  VIEWPORT_SIZES,
  type PreviewViewport,
} from "@/state/editor";

const STOP_GRACE_MS = 60_000;

type Listener = (streamId: string | null) => void;
export type PreviewLifecycleStatus = "idle" | "starting" | "live" | "error";

export interface PreviewNavState {
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export const INITIAL_NAV: PreviewNavState = {
  url: null,
  canGoBack: false,
  canGoForward: false,
};

function navEqual(a: PreviewNavState, b: PreviewNavState): boolean {
  return (
    a.url === b.url &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward
  );
}

type NavListener = (s: PreviewNavState) => void;
type StatusListener = (status: PreviewLifecycleStatus) => void;

interface State {
  streamId: string | null;
  appUrl: string | null;
  viewport: PreviewViewport;
  status: PreviewLifecycleStatus;
  starting: boolean;
  paused: boolean;
  stopTimer: number | null;
  listeners: Set<Listener>;
  statusListeners: Set<StatusListener>;
  refcount: number;
  nav: PreviewNavState;
  navListeners: Set<NavListener>;
  navUnlisten: (() => void) | null;
}

const state: State = {
  streamId: null,
  appUrl: null,
  viewport: "desktop",
  status: "idle",
  starting: false,
  paused: false,
  stopTimer: null,
  listeners: new Set(),
  statusListeners: new Set(),
  refcount: 0,
  nav: { ...INITIAL_NAV },
  navListeners: new Set(),
  navUnlisten: null,
};

function notify() {
  for (const l of state.listeners) l(state.streamId);
}

function setStatus(status: PreviewLifecycleStatus) {
  if (state.status === status) return;
  state.status = status;
  for (const l of state.statusListeners) l(state.status);
}

function setNav(next: PreviewNavState) {
  if (navEqual(state.nav, next)) return;
  state.nav = next;
  for (const l of state.navListeners) l(state.nav);
}

function cancelPendingStop() {
  if (state.stopTimer != null) {
    window.clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }
}

async function launch(appUrl: string, viewport: PreviewViewport) {
  if (state.starting || state.streamId != null) return;
  state.starting = true;
  setStatus("starting");
  try {
    const { w, h } = VIEWPORT_SIZES[viewport];
    const id = await startAuthorPreview({
      initialUrl: appUrl,
      viewportWidth: w,
      viewportHeight: h,
    });
    state.streamId = id;
    state.appUrl = appUrl;
    state.viewport = viewport;
    state.paused = false;
    setStatus("live");
    // Seed the nav URL so the URL bar can render the initial value before
    // the first framenavigated event arrives from the sidecar.
    setNav({ ...INITIAL_NAV, url: appUrl });
    try {
      const unlisten = await listen<AuthorPreviewNavPayload>(
        `preview://nav/${id}`,
        (ev) => {
          setNav({
            url: ev.payload.url || null,
            canGoBack: ev.payload.canGoBack,
            canGoForward: ev.payload.canGoForward,
          });
        },
      );
      state.navUnlisten = unlisten;
    } catch (err) {
      frontendLog.warn("previewLifecycle", "preview://nav listen failed", {
        error: err,
        fields: { stream_id: id },
      });
    }
    notify();
  } catch (err) {
    setStatus("error");
    frontendLog.warn("previewLifecycle", "start_author_preview failed", {
      error: err,
      fields: { app_url: appUrl, viewport },
    });
  } finally {
    state.starting = false;
  }
}

async function teardown() {
  const id = state.streamId;
  if (id == null) return;
  state.streamId = null;
  state.appUrl = null;
  state.paused = false;
  setStatus("idle");
  if (state.navUnlisten) {
    try { state.navUnlisten(); } catch { /* unlisten is best-effort */ }
    state.navUnlisten = null;
  }
  setNav(INITIAL_NAV);
  notify();
  try {
    await stopAuthorPreview(id);
  } catch (err) {
    frontendLog.warn("previewLifecycle", "stop_author_preview failed", {
      error: err,
      fields: { stream_id: id },
    });
  }
}

/**
 * Request a live preview for the given app URL and viewport.
 *
 * Each caller must pair `acquire` with exactly one `release`. The
 * Chromium boots on the first acquire, and stays alive after the
 * last release for a grace window (`STOP_GRACE_MS`) so route
 * churn doesn't trigger repeated cold-starts.
 *
 * Returns an unsubscribe function for stream-id updates.
 */
export function acquirePreview(
  appUrl: string,
  viewport: PreviewViewport,
  listener: Listener,
): () => void {
  cancelPendingStop();
  state.refcount += 1;
  state.listeners.add(listener);

  if (state.streamId != null) {
    listener(state.streamId);
    if (state.appUrl !== appUrl) {
      state.appUrl = appUrl;
      setAuthorPreviewUrl(state.streamId, appUrl).catch((err) => {
        frontendLog.warn("previewLifecycle", "set_author_preview_url failed", {
          error: err,
          fields: { stream_id: state.streamId, app_url: appUrl },
        });
      });
    }
    if (state.viewport !== viewport) {
      state.viewport = viewport;
      const { w, h } = VIEWPORT_SIZES[viewport];
      setAuthorPreviewViewport(state.streamId, w, h).catch((err) => {
        frontendLog.warn("previewLifecycle", "set_author_preview_viewport failed", {
          error: err,
          fields: { stream_id: state.streamId, w, h, viewport },
        });
      });
    }
  } else {
    listener(null);
    void launch(appUrl, viewport);
  }

  return () => {
    state.listeners.delete(listener);
    state.refcount -= 1;
    if (state.refcount <= 0) {
      state.refcount = 0;
      scheduleStop();
    }
  };
}

export async function stopPreviewNow(reason: string) {
  cancelPendingStop();
  state.refcount = 0;
  if (state.streamId == null && !state.starting) return;
  frontendLog.info("previewLifecycle", "stopping preview immediately", {
    fields: { reason },
  });
  await teardown();
}

function scheduleStop() {
  cancelPendingStop();
  if (state.streamId == null) return;
  state.stopTimer = window.setTimeout(() => {
    state.stopTimer = null;
    if (state.refcount === 0) void teardown();
  }, STOP_GRACE_MS);
}

/**
 * Push the current app URL to the live preview (used when the user
 * edits `meta.app` after mount). Cheap — does a same-tab navigation
 * instead of restarting Chromium.
 */
export function updateAppUrl(appUrl: string) {
  if (state.streamId == null) return;
  if (state.appUrl === appUrl) return;
  state.appUrl = appUrl;
  setAuthorPreviewUrl(state.streamId, appUrl).catch((err) => {
    frontendLog.warn("previewLifecycle", "set_author_preview_url failed", {
      error: err,
      fields: { stream_id: state.streamId, app_url: appUrl },
    });
  });
}

export function updateViewport(viewport: PreviewViewport) {
  if (state.streamId == null) return;
  if (state.viewport === viewport) return;
  state.viewport = viewport;
  const { w, h } = VIEWPORT_SIZES[viewport];
  setAuthorPreviewViewport(state.streamId, w, h).catch((err) => {
    frontendLog.warn("previewLifecycle", "set_author_preview_viewport failed", {
      error: err,
      fields: { stream_id: state.streamId, w, h, viewport },
    });
  });
}

/**
 * Pause/resume the CDP screencast. Idempotent. Keeps Chromium + the
 * CDP session alive; only the jpeg frame push stops. Use when no one
 * is looking at the stream (window blurred, simulator owns the page).
 */
export function pausePreview() {
  if (state.streamId == null || state.paused) return;
  state.paused = true;
  pauseAuthorPreview(state.streamId).catch((err) => {
    frontendLog.warn("previewLifecycle", "pause_author_preview failed", {
      error: err,
      fields: { stream_id: state.streamId },
    });
  });
}

export function resumePreview() {
  if (state.streamId == null || !state.paused) return;
  state.paused = false;
  resumeAuthorPreview(state.streamId).catch((err) => {
    frontendLog.warn("previewLifecycle", "resume_author_preview failed", {
      error: err,
      fields: { stream_id: state.streamId },
    });
  });
}

/**
 * Subscribe to nav-state updates (current URL + canGoBack / canGoForward).
 * The listener is invoked once synchronously with the current state and
 * again every time the sidecar emits a `preview/nav` notification.
 */
export function subscribeNav(listener: NavListener): () => void {
  state.navListeners.add(listener);
  listener(state.nav);
  return () => {
    state.navListeners.delete(listener);
  };
}

export function subscribeStatus(listener: StatusListener): () => void {
  state.statusListeners.add(listener);
  listener(state.status);
  return () => {
    state.statusListeners.delete(listener);
  };
}
