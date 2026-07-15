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
import { type PreviewViewport, VIEWPORT_SIZES } from "@/state/editor";

const STOP_GRACE_MS = 60_000;
const RECORDING_PREVIEW_SUPERSEDED_MESSAGE =
  "Preview URL or session changed while preparing recording";

type Listener = (streamId: string | null) => void;
export type PreviewLifecycleStatus = "idle" | "starting" | "live" | "error";

export interface PreviewNavState {
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PreviewRecordingLease {
  streamId: string;
  release: () => void;
}

export interface PreviewViewportSize {
  width: number;
  height: number;
}

type PreviewViewportRequest = PreviewViewport | PreviewViewportSize;

export interface AcquirePreviewForRecordingArgs {
  appUrl: string;
  viewport: PreviewViewportRequest;
  reason: string;
  timeoutMs?: number;
}

export const INITIAL_NAV: PreviewNavState = {
  url: null,
  canGoBack: false,
  canGoForward: false,
};

function navEqual(a: PreviewNavState, b: PreviewNavState): boolean {
  return a.url === b.url && a.canGoBack === b.canGoBack && a.canGoForward === b.canGoForward;
}

type NavListener = (s: PreviewNavState) => void;
type StatusListener = (status: PreviewLifecycleStatus) => void;

interface AppUrlDrain {
  streamId: string;
  promise: Promise<void>;
  errorObserver: {
    appUrls: Set<string>;
    reported: boolean;
  };
}

interface State {
  streamId: string | null;
  appUrl: string | null;
  desiredAppUrl: string | null;
  appUrlDrain: AppUrlDrain | null;
  viewportKey: string;
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
  desiredAppUrl: null,
  appUrlDrain: null,
  viewportKey: "preset:desktop",
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

function viewportDimensions(viewport: PreviewViewportRequest): PreviewViewportSize {
  if (typeof viewport === "string") {
    const { w, h } = VIEWPORT_SIZES[viewport];
    return { width: w, height: h };
  }
  return viewport;
}

function viewportKey(viewport: PreviewViewportRequest): string {
  return typeof viewport === "string"
    ? `preset:${viewport}`
    : `size:${viewport.width}x${viewport.height}`;
}

function recordingPreviewSupersededError(): Error {
  return new Error(RECORDING_PREVIEW_SUPERSEDED_MESSAGE);
}

async function drainAppUrlQueue(drain: AppUrlDrain): Promise<void> {
  while (state.streamId === drain.streamId) {
    const targetUrl = state.desiredAppUrl;
    if (targetUrl == null || targetUrl === state.appUrl) return;

    try {
      await setAuthorPreviewUrl(drain.streamId, targetUrl);
    } catch (err) {
      if (state.streamId !== drain.streamId) return;
      if (state.desiredAppUrl !== targetUrl) continue;
      throw err;
    }

    if (state.streamId !== drain.streamId) return;
    state.appUrl = targetUrl;
  }
}

function queueAppUrl(
  appUrl: string,
  errorObserver?: AppUrlDrain["errorObserver"],
): Promise<void> | null {
  state.desiredAppUrl = appUrl;

  const streamId = state.streamId;
  if (streamId == null) return null;

  const activeDrain = state.appUrlDrain;
  if (activeDrain?.streamId === streamId) return activeDrain.promise;
  if (state.appUrl === state.desiredAppUrl) return null;

  const drain: AppUrlDrain = {
    streamId,
    promise: Promise.resolve(),
    errorObserver: errorObserver ?? { appUrls: new Set(), reported: false },
  };
  state.appUrlDrain = drain;
  drain.promise = drainAppUrlQueue(drain).then(
    () => {
      if (state.appUrlDrain !== drain) return;
      state.appUrlDrain = null;
      if (
        state.streamId === streamId &&
        state.desiredAppUrl != null &&
        state.desiredAppUrl !== state.appUrl
      ) {
        return queueAppUrl(state.desiredAppUrl, drain.errorObserver) ?? undefined;
      }
    },
    (err) => {
      if (state.appUrlDrain === drain) state.appUrlDrain = null;
      throw err;
    },
  );
  return drain.promise;
}

function assertRecordingPreview(streamId: string, appUrl: string): void {
  if (
    state.streamId !== streamId ||
    state.appUrl !== appUrl ||
    state.desiredAppUrl !== appUrl ||
    state.appUrlDrain != null
  ) {
    throw recordingPreviewSupersededError();
  }
}

async function ensureAppUrlForRecording(streamId: string, appUrl: string): Promise<void> {
  queueAppUrl(appUrl);

  while (true) {
    if (state.streamId !== streamId) throw recordingPreviewSupersededError();
    const drain = state.appUrlDrain;
    if (drain == null) break;
    if (drain.streamId !== streamId) throw recordingPreviewSupersededError();

    try {
      await drain.promise;
    } catch (err) {
      if (state.streamId !== streamId || state.desiredAppUrl !== appUrl) {
        throw recordingPreviewSupersededError();
      }
      throw err;
    }
  }

  assertRecordingPreview(streamId, appUrl);
}

async function launch(appUrl: string, viewport: PreviewViewportRequest) {
  state.desiredAppUrl = appUrl;
  if (state.starting || state.streamId != null) return;
  state.starting = true;
  setStatus("starting");
  try {
    const { width, height } = viewportDimensions(viewport);
    const id = await startAuthorPreview({
      initialUrl: appUrl,
      viewportWidth: width,
      viewportHeight: height,
    });
    state.streamId = id;
    state.appUrl = appUrl;
    state.appUrlDrain = null;
    state.viewportKey = viewportKey(viewport);
    state.paused = false;
    setStatus("live");
    // Seed the nav URL so the URL bar can render the initial value before
    // the first framenavigated event arrives from the sidecar.
    setNav({ ...INITIAL_NAV, url: appUrl });
    try {
      const unlisten = await listen<AuthorPreviewNavPayload>(`preview://nav/${id}`, (ev) => {
        setNav({
          url: ev.payload.url || null,
          canGoBack: ev.payload.canGoBack,
          canGoForward: ev.payload.canGoForward,
        });
      });
      state.navUnlisten = unlisten;
    } catch (err) {
      frontendLog.warn("previewLifecycle", "preview://nav listen failed", {
        error: err,
        fields: { stream_id: id },
      });
    }
    notify();
    if (
      state.streamId === id &&
      state.desiredAppUrl != null &&
      state.desiredAppUrl !== state.appUrl
    ) {
      updateAppUrl(state.desiredAppUrl);
    }
  } catch (err) {
    setStatus("error");
    frontendLog.warn("previewLifecycle", "start_author_preview failed", {
      error: err,
      fields: { app_url: appUrl, viewport: viewportKey(viewport) },
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
  state.desiredAppUrl = null;
  state.appUrlDrain = null;
  state.paused = false;
  setStatus("idle");
  if (state.navUnlisten) {
    try {
      state.navUnlisten();
    } catch {
      /* unlisten is best-effort */
    }
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
  viewport: PreviewViewportRequest,
  listener: Listener,
): () => void {
  cancelPendingStop();
  state.refcount += 1;
  state.listeners.add(listener);

  if (state.streamId != null) {
    listener(state.streamId);
    updateAppUrl(appUrl);
    updateViewport(viewport);
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

export function retainPreviewForRecording(reason: string): PreviewRecordingLease | null {
  cancelPendingStop();
  if (state.streamId == null) return null;
  state.refcount += 1;
  const streamId = state.streamId;
  frontendLog.info("previewLifecycle", "retaining preview for recording", {
    fields: { reason, stream_id: streamId, refcount: state.refcount },
  });
  let released = false;
  return {
    streamId,
    release: () => {
      if (released) return;
      released = true;
      if (state.streamId === streamId) {
        state.refcount = Math.max(0, state.refcount - 1);
      }
      frontendLog.info("previewLifecycle", "released recording preview lease", {
        fields: { reason, stream_id: streamId, refcount: state.refcount },
      });
      if (state.streamId === streamId && state.refcount === 0) scheduleStop();
    },
  };
}

async function finalizePreviewForRecording(
  lease: PreviewRecordingLease,
  appUrl: string,
  viewport: PreviewViewportRequest,
): Promise<PreviewRecordingLease> {
  const streamId = lease.streamId;
  try {
    await ensureAppUrlForRecording(streamId, appUrl);
    assertRecordingPreview(streamId, appUrl);
    await updateViewportForRecording(viewport);
    assertRecordingPreview(streamId, appUrl);
    return lease;
  } catch (err) {
    lease.release();
    throw err;
  }
}

export async function acquirePreviewForRecording({
  appUrl,
  viewport,
  reason,
  timeoutMs = 8_000,
}: AcquirePreviewForRecordingArgs): Promise<PreviewRecordingLease> {
  const retained = retainPreviewForRecording(reason);
  if (retained) {
    return finalizePreviewForRecording(retained, appUrl, viewport);
  }

  let release: (() => void) | null = null;
  let pendingStreamId: string | null = null;
  let settled = false;
  const lease = await new Promise<PreviewRecordingLease>((resolve, reject) => {
    const finish = (streamId: string) => {
      if (settled) return;
      if (!release) {
        pendingStreamId = streamId;
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      frontendLog.info("previewLifecycle", "acquired preview for recording", {
        fields: { reason, stream_id: streamId, refcount: state.refcount },
      });
      resolve({
        streamId,
        release: () => {
          if (!release) return;
          release();
          release = null;
          frontendLog.info("previewLifecycle", "released recording preview lease", {
            fields: { reason, stream_id: streamId, refcount: state.refcount },
          });
        },
      });
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      release?.();
      release = null;
      reject(new Error("Timed out waiting for browser preview"));
    }, timeoutMs);
    release = acquirePreview(appUrl, viewport, (streamId) => {
      if (streamId) finish(streamId);
    });
    if (pendingStreamId) finish(pendingStreamId);
  });
  return finalizePreviewForRecording(lease, appUrl, viewport);
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
  const streamId = state.streamId;
  const drain = queueAppUrl(appUrl);
  if (drain == null) return;
  const errorObserver = state.appUrlDrain?.errorObserver;
  if (errorObserver?.appUrls.has(appUrl)) return;
  errorObserver?.appUrls.add(appUrl);

  drain.catch((err) => {
    if (state.streamId !== streamId || state.desiredAppUrl !== appUrl) return;
    if (errorObserver?.reported) return;
    if (errorObserver) errorObserver.reported = true;
    frontendLog.warn("previewLifecycle", "set_author_preview_url failed", {
      error: err,
      fields: { stream_id: streamId, app_url: appUrl },
    });
  });
}

export function updateViewport(viewport: PreviewViewportRequest) {
  updateViewportForRecording(viewport).catch((err) => {
    const { width, height } = viewportDimensions(viewport);
    frontendLog.warn("previewLifecycle", "set_author_preview_viewport failed", {
      error: err,
      fields: { stream_id: state.streamId, width, height, viewport: viewportKey(viewport) },
    });
  });
}

async function updateViewportForRecording(viewport: PreviewViewportRequest): Promise<void> {
  if (state.streamId == null) return;
  const nextKey = viewportKey(viewport);
  if (state.viewportKey === nextKey) return;
  const { width, height } = viewportDimensions(viewport);
  const streamId = state.streamId;
  await setAuthorPreviewViewport(streamId, width, height);
  if (state.streamId === streamId) {
    state.viewportKey = nextKey;
  }
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
