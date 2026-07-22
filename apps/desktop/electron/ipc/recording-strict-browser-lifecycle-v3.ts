import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StartRecordingArgs } from "@storycapture/shared-types";
import {
  type RecordingFailureCodeV3,
  type RecordingHostSessionSnapshotV3,
  type RecordingPreflightV3Dto,
  type RecordingPreflightV3Request,
  type RecordingResultV3,
  RECORDING_V3_STRICT_DIMENSIONS,
  readRecordingCaptureContractV3,
  recordingV3FailureMessage,
  validateRecordingV3Dimensions,
} from "@storycapture/shared-types/recording-v3";
import { app, BrowserWindow, type WebContents } from "electron";
import {
  type ActionCursorTiming,
  type ActionTimelineEvent,
  recordingActionsFromSession,
} from "./action-timeline";
import { ffmpegExecutablePath } from "./export-binaries";
import { channelIdFrom, closeChannel, sendChannel } from "./legacy/shared";
import { recordEngineLog } from "./recording-observability";
import { RecordingPauseGate } from "./recording-pause-gate";
import { recordingV3QualificationFromPreflight } from "./recording-v3-capability";
import { BrowserCaptureBackendV3 } from "./recording-v3-browser-backend";
import { RecordingV3BundleWriter } from "./recording-v3-bundle-writer";
import { RecordingV3Engine, RecordingV3EngineError } from "./recording-v3-engine";
import {
  loadRecordingV3NativeAddon,
  RecordingV3NativeBridge,
  RecordingV3NativeError,
  type RecordingV3NativeSession,
  recordingV3NativeAddonPathForRuntime,
} from "./recording-v3-native-addon";
import { probeRecordingV3RuntimeCapability } from "./recording-v3-runtime-preflight";
import {
  type RecordingV3CoordinatorSession,
  RecordingV3HostSessionRegistry,
} from "./recording-v3-session-registry";
import { RecordingV3TransitionQueue } from "./recording-v3-transition-queue";

export interface StrictBrowserSessionV3 extends RecordingV3CoordinatorSession {
  request: RecordingPreflightV3Request;
  startedAt: number;
  pauseGate: RecordingPauseGate;
  sender: WebContents | null;
  eventChannelId: number | null;
  window: BrowserWindow;
  native: RecordingV3NativeSession;
  engine: RecordingV3Engine;
  backend: BrowserCaptureBackendV3;
  bundleWriter: RecordingV3BundleWriter;
  actionEvents: ActionTimelineEvent[];
  cursorMotionPreset: ActionCursorTiming["motion_preset"] | undefined;
  sourceReady: boolean;
  acceptingFrames: boolean;
  firstFrameTimeoutMs: number;
  heartbeat: ReturnType<typeof setInterval>;
  stopPromise: Promise<RecordingResultV3> | null;
  boundaryFrameResolve: (() => void) | null;
  boundaryFrameReject: ((error: Error) => void) | null;
  boundaryKind: "pause" | "stop" | null;
  transitionQueue: RecordingV3TransitionQueue;
  terminalError: Error | null;
  terminalizing: boolean;
  paintListener: (event: Electron.Event) => void;
  navigationListener: (
    event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
  renderProcessGoneListener: (
    event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ) => void;
}

const registry = new RecordingV3HostSessionRegistry<StrictBrowserSessionV3>();

export function recordingV3Request(args: StartRecordingArgs): RecordingPreflightV3Request {
  if (!isRecordingV3Request(args)) {
    throw new Error("Recording V3 requires an explicit Strict Local or Strict Certified policy");
  }
  const captureContract = readRecordingCaptureContractV3(args.capture_contract);
  return {
    version: 3,
    enforcement_mode: "strict",
    certification_mode: args.certification_mode,
    target_class: args.target.kind === "author_preview" ? "browser" : "display",
    requested_fps: { numerator: 60, denominator: 1 },
    dimensions: captureContract?.dimensions ?? RECORDING_V3_STRICT_DIMENSIONS,
    cursor_policy: "sidecar_reconstructed",
    audio_roles: args.audio_device_id ? ["microphone"] : [],
  };
}

export function isRecordingV3Request(args: StartRecordingArgs): boolean {
  return (
    args.contract_version === 3 &&
    args.enforcement_mode === "strict" &&
    (args.certification_mode === "local" || args.certification_mode === "certified") &&
    args.delivery_policy === "strict"
  );
}

export async function probeBrowserRecordingV3Capability(
  args: StartRecordingArgs,
  url: string,
): Promise<RecordingPreflightV3Dto> {
  const captureContract = readRecordingCaptureContractV3(args.capture_contract);
  const preflight = await probeRecordingV3RuntimeCapability({
    request: recordingV3Request(args),
    projectFolder: args.project_folder,
    url,
  });
  const startContractMatches =
    captureContract !== null &&
    args.width === captureContract.dimensions.logical_width &&
    args.height === captureContract.dimensions.logical_height &&
    args.fps === 60 &&
    args.include_cursor !== true;
  if (startContractMatches) return preflight;
  return {
    ...preflight,
    runtime_eligible: false,
    certification_eligible: false,
    eligible: false,
    failure_codes: [...new Set(["contract_mismatch" as const, ...preflight.failure_codes])],
  };
}

export const probeStrictBrowserRecordingV3Capability = probeBrowserRecordingV3Capability;

function send(session: StrictBrowserSessionV3, event: unknown): void {
  if (session.sender) sendChannel(session.sender, session.eventChannelId, event);
}

function closeEventChannel(session: StrictBrowserSessionV3): void {
  if (session.sender) closeChannel(session.sender, session.eventChannelId);
  session.sender = null;
  session.eventChannelId = null;
}

function detachSurface(session: StrictBrowserSessionV3): void {
  session.window.webContents.off("paint", session.paintListener);
  session.window.webContents.off("did-start-navigation", session.navigationListener);
  session.window.webContents.off("render-process-gone", session.renderProcessGoneListener);
}

function failureFrom(error: unknown): { code: RecordingFailureCodeV3; error: Error } {
  if (error instanceof RecordingV3EngineError || error instanceof RecordingV3NativeError) {
    return { code: error.code, error };
  }
  return {
    code: "runtime_integrity_failed",
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

async function failSession(session: StrictBrowserSessionV3, error: unknown): Promise<never> {
  const failure = failureFrom(error);
  if (!session.terminalizing) {
    session.terminalizing = true;
    const rejectBoundary = session.boundaryFrameReject;
    session.boundaryFrameResolve = null;
    session.boundaryFrameReject = null;
    session.boundaryKind = null;
    rejectBoundary?.(failure.error);
    clearInterval(session.heartbeat);
    session.acceptingFrames = false;
    session.pauseGate.cancel();
    detachSurface(session);
    try {
      session.engine.abort();
    } catch {
      // Preserve the first terminal failure.
    }
    await session.bundleWriter.abort().catch(() => undefined);
    if (!session.window.isDestroyed()) session.window.destroy();
    session.terminalError = failure.error;
    registry.fail(session.id, [failure.code], failure.error.message);
    send(session, {
      type: "failed",
      message: failure.error.message,
      failure_codes: [failure.code],
    });
    void recordEngineLog({
      level: "error",
      event: "recording.terminal",
      context: {
        session_id: session.id,
        backend_id: session.backend.backendId,
        phase: "recording_v3",
        reason_code: failure.code,
      },
      details: { outcome: "failed", contract_version: 3 },
      error: failure.error,
    });
    closeEventChannel(session);
  }
  throw session.terminalError ?? failure.error;
}

function waitForNativeCommits(
  session: StrictBrowserSessionV3,
  minimumCommits: number,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (session.terminalError) {
          reject(session.terminalError);
          return;
        }
        if (session.native.getStats().nativeCommits >= minimumCommits) {
          resolve();
          return;
        }
        if (Date.now() - startedAt >= session.firstFrameTimeoutMs) {
          reject(new RecordingV3EngineError("native_deadline_missed", "frame commit timed out"));
          return;
        }
        setTimeout(poll, 5).unref?.();
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

export async function startBrowserRecordingV3(
  args: StartRecordingArgs,
  onEvent: unknown,
  sender: WebContents,
  url: string,
): Promise<{ id: string }> {
  if (!isRecordingV3Request(args))
    throw new Error("Recording V3 requires an explicit Strict Local or Strict Certified policy");
  const local = args.certification_mode === "local";
  if (args.target.kind !== "author_preview" || !url || url === "about:blank") {
    throw new Error(recordingV3FailureMessage("target_unsupported"));
  }

  const eventChannelId = channelIdFrom(onEvent);
  const request = recordingV3Request(args);
  const dimensionValidation = validateRecordingV3Dimensions(
    request.certification_mode,
    request.dimensions,
  );
  const preflight = await probeStrictBrowserRecordingV3Capability(args, url);
  sendChannel(sender, eventChannelId, { type: "preflight", result: preflight });
  const qualification = recordingV3QualificationFromPreflight(preflight);
  if (!preflight.eligible || !qualification) {
    closeChannel(sender, eventChannelId);
    const code = preflight.failure_codes[0] ?? (local ? "contract_mismatch" : "profile_mismatch");
    const detail = code === "contract_mismatch" ? dimensionValidation.detail : null;
    throw new Error(
      `${recordingV3FailureMessage(code)}${detail ? ` ${detail}` : ""} (${preflight.failure_codes.join(", ")})`,
    );
  }

  const id = randomUUID();
  const exportsDir = path.join(args.project_folder, "exports");
  const name = `recording-${new Date().toISOString().replaceAll(/[:.]/g, "-")}${
    local ? "-strict-local" : ""
  }`;
  const bundleWriter = await RecordingV3BundleWriter.create({
    exportsDir,
    name,
    captureContract: {
      version: 3,
      guarantee_boundary: "electron_offscreen_delivery",
      source_ordinal_kind: "electron_frame_count",
      target_class: "browser",
      exact_fps: { numerator: 60, denominator: 1 },
      dimensions: request.dimensions,
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    },
    qualification,
    width: request.dimensions.requested_output_width,
    height: request.dimensions.requested_output_height,
  });

  let window: BrowserWindow | null = null;
  let session: StrictBrowserSessionV3 | null = null;
  try {
    const addonPath = recordingV3NativeAddonPathForRuntime({
      app,
      resourcesPath: process.resourcesPath,
      desktopRoot: app.getAppPath(),
    });
    const bridge = new RecordingV3NativeBridge(loadRecordingV3NativeAddon(addonPath));
    const native = bridge.start({
      width: request.dimensions.physical_width,
      height: request.dimensions.physical_height,
      ffmpegPath: ffmpegExecutablePath(),
      outputPath: bundleWriter.masterPath,
    });
    const engine = new RecordingV3Engine(native);
    const backend = new BrowserCaptureBackendV3(engine, {
      width: request.dimensions.physical_width,
      height: request.dimensions.physical_height,
    });
    window = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      width: request.dimensions.logical_width,
      height: request.dimensions.logical_height,
      webPreferences: {
        partition: `storycapture-recording-v3-${id}`,
        offscreen: {
          useSharedTexture: true,
          sharedTexturePixelFormat: "argb",
          deviceScaleFactor: request.dimensions.capture_dpr,
        },
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    let heartbeatSeq = 0;
    const placeholderHeartbeat = setInterval(() => undefined, 60_000);
    placeholderHeartbeat.unref?.();
    const activeSession: StrictBrowserSessionV3 = {
      id,
      projectFolder: args.project_folder,
      preflight,
      request,
      startedAt: Date.now(),
      pauseGate: new RecordingPauseGate(),
      sender,
      eventChannelId,
      window,
      native,
      engine,
      backend,
      bundleWriter,
      actionEvents: [],
      cursorMotionPreset: undefined,
      sourceReady: false,
      acceptingFrames: false,
      firstFrameTimeoutMs: Number(args.first_frame_timeout_ms ?? 8_000),
      heartbeat: placeholderHeartbeat,
      stopPromise: null,
      boundaryFrameResolve: null,
      boundaryFrameReject: null,
      boundaryKind: null,
      transitionQueue: new RecordingV3TransitionQueue(),
      terminalError: null,
      terminalizing: false,
      paintListener: (_event: Electron.Event) => undefined,
      navigationListener: (
        _event: Electron.Event,
        _url: string,
        _isInPlace: boolean,
        _isMainFrame: boolean,
      ) => undefined,
      renderProcessGoneListener: (
        _event: Electron.Event,
        _details: Electron.RenderProcessGoneDetails,
      ) => undefined,
    };
    session = activeSession;
    clearInterval(placeholderHeartbeat);
    activeSession.paintListener = (event: Electron.Event) => {
      const texture = (event as Electron.Event & { texture?: Electron.OffscreenSharedTexture })
        .texture;
      if (!texture) return;
      if (!activeSession.acceptingFrames) {
        texture.release();
        return;
      }
      try {
        activeSession.backend.submitTexture(texture);
        if (activeSession.boundaryFrameResolve && activeSession.boundaryKind) {
          const readiness =
            activeSession.boundaryKind === "pause"
              ? activeSession.engine.preparePause()
              : activeSession.engine.prepareStop();
          if (readiness === "frame_required") return;
          activeSession.acceptingFrames = false;
          activeSession.window.webContents.stopPainting();
          const resolve = activeSession.boundaryFrameResolve;
          activeSession.boundaryFrameResolve = null;
          activeSession.boundaryFrameReject = null;
          activeSession.boundaryKind = null;
          resolve();
        }
      } catch (error) {
        void failSession(activeSession, error).catch(() => undefined);
      }
    };
    activeSession.navigationListener = (_event, _url, isInPlace, isMainFrame) => {
      if (!activeSession.sourceReady || isInPlace || !isMainFrame || activeSession.terminalizing)
        return;
      try {
        activeSession.engine.closeEpoch();
      } catch (error) {
        void failSession(activeSession, error).catch(() => undefined);
      }
    };
    activeSession.renderProcessGoneListener = (_event, details) => {
      void failSession(
        activeSession,
        new RecordingV3EngineError(
          "target_lost",
          `browser render process exited: ${details.reason}`,
        ),
      ).catch(() => undefined);
    };
    activeSession.heartbeat = setInterval(() => {
      heartbeatSeq += 1;
      send(activeSession, { type: "heartbeat", seq: heartbeatSeq });
    }, 1_000);
    activeSession.heartbeat.unref?.();
    registry.register(activeSession);

    window.webContents.setFrameRate(60);
    window.webContents.on("paint", activeSession.paintListener);
    window.webContents.on("did-start-navigation", activeSession.navigationListener);
    window.webContents.on("render-process-gone", activeSession.renderProcessGoneListener);
    await window.loadURL(url);
    activeSession.sourceReady = true;
    send(activeSession, { type: "readiness", state: "source_ready" });
    activeSession.acceptingFrames = true;
    window.webContents.invalidate();
    await waitForNativeCommits(activeSession, 1);
    send(activeSession, { type: "readiness", state: "first_frame_committed" });
    return { id };
  } catch (error) {
    if (session) return failSession(session, error);
    if (window && !window.isDestroyed()) window.destroy();
    await bundleWriter.abort().catch(() => undefined);
    throw error;
  }
}

export function strictBrowserRecordingV3Session(id: string): StrictBrowserSessionV3 | null {
  const snapshot = registry.snapshot(id);
  return snapshot && snapshot.lifecycle !== "terminal_unacknowledged" ? registry.session(id) : null;
}

export function queryStrictBrowserRecordingV3(
  projectFolder: string,
): RecordingHostSessionSnapshotV3[] {
  return registry.query(projectFolder);
}

export function reattachStrictBrowserRecordingV3(
  id: string,
  sender: WebContents,
  onEvent: unknown,
): RecordingHostSessionSnapshotV3 | null {
  const session = registry.session(id);
  const snapshot = registry.snapshot(id);
  if (!session || !snapshot) return null;
  closeEventChannel(session);
  session.sender = sender;
  session.eventChannelId = channelIdFrom(onEvent);
  send(session, { type: "preflight", result: snapshot.preflight });
  if (snapshot.result) {
    send(session, {
      type: snapshot.result.status === "completed" ? "completed" : "quality-failed",
      result: snapshot.result,
    });
    closeEventChannel(session);
  } else if (snapshot.failure_message) {
    send(session, {
      type: "failed",
      message: snapshot.failure_message,
      failure_codes: snapshot.failure_codes,
    });
    closeEventChannel(session);
  }
  return snapshot;
}

export function acknowledgeStrictBrowserRecordingV3(id: string): boolean {
  const session = registry.session(id);
  if (session) closeEventChannel(session);
  return registry.acknowledge(id);
}

export function strictBrowserRecordingV3Contents(id: string): WebContents | null {
  const session = strictBrowserRecordingV3Session(id);
  return session && !session.window.isDestroyed() ? session.window.webContents : null;
}

export function strictBrowserRecordingV3ClockMs(id: string): number | null {
  return strictBrowserRecordingV3Session(id)?.engine.recordingClockMs() ?? null;
}

export function recordingV3SessionNativeStats(id: string) {
  return registry.session(id)?.native.getStats() ?? null;
}

export async function requireStrictBrowserRecordingV3Readiness(
  id: string,
  state: "source_ready" | "first_frame_committed" | "pre_input_frame_committed",
): Promise<void> {
  const session = strictBrowserRecordingV3Session(id);
  if (!session) throw new Error(`Recording V3 session ${id} not found`);
  if (state === "source_ready") {
    if (!session.sourceReady) throw new Error("Recording V3 browser source is not ready");
    return;
  }
  const current = session.native.getStats().nativeCommits;
  const minimum = state === "first_frame_committed" ? Math.max(1, current) : current + 1;
  if (state === "pre_input_frame_committed") session.window.webContents.invalidate();
  await waitForNativeCommits(session, minimum);
  if (state === "pre_input_frame_committed") {
    send(session, { type: "readiness", state });
  }
}

async function reconcileRecordingV3Boundary(
  session: StrictBrowserSessionV3,
  kind: "pause" | "stop",
): Promise<void> {
  const reconciliationDeadline = Date.now() + session.firstFrameTimeoutMs;
  while (true) {
    const readiness =
      kind === "pause" ? session.engine.preparePause() : session.engine.prepareStop();
    if (readiness === "ready") {
      session.acceptingFrames = false;
      session.window.webContents.stopPainting();
      return;
    }
    if (Date.now() >= reconciliationDeadline) {
      return failSession(
        session,
        new RecordingV3EngineError(
          "native_deadline_missed",
          `Recording V3 ${kind} reconciliation timed out`,
        ),
      );
    }
    if (readiness === "clock_pending") {
      session.acceptingFrames = false;
      session.window.webContents.stopPainting();
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (session.boundaryFrameResolve === complete) {
          session.boundaryFrameResolve = null;
          session.boundaryFrameReject = null;
          session.boundaryKind = null;
        }
        reject(
          new RecordingV3EngineError(
            "native_deadline_missed",
            `Recording V3 ${kind} frame did not arrive`,
          ),
        );
      }, session.firstFrameTimeoutMs);
      session.boundaryFrameResolve = complete;
      session.boundaryFrameReject = reject;
      session.boundaryKind = kind;
      session.acceptingFrames = true;
      session.window.webContents.startPainting();
      session.window.webContents.invalidate();
    }).catch((error) => failSession(session, error));
  }
}

export async function pauseStrictBrowserRecordingV3(id: string): Promise<boolean> {
  const session = strictBrowserRecordingV3Session(id);
  if (!session) return false;
  return session.transitionQueue.run(async () => {
    try {
      await reconcileRecordingV3Boundary(session, "pause");
      session.engine.pause();
      session.pauseGate.pause();
      registry.updateLifecycle(id, "paused");
      return true;
    } catch (error) {
      return failSession(session, error);
    }
  });
}

export async function resumeStrictBrowserRecordingV3(id: string): Promise<boolean> {
  const session = strictBrowserRecordingV3Session(id);
  if (!session) return false;
  return session.transitionQueue.run(async () => {
    session.engine.resume();
    session.pauseGate.resume();
    session.window.webContents.startPainting();
    session.acceptingFrames = true;
    registry.updateLifecycle(id, "recording");
    session.window.webContents.invalidate();
    return true;
  });
}

export function setStrictBrowserRecordingV3Actions(
  id: string,
  events: readonly ActionTimelineEvent[],
  cursorMotionPreset?: ActionCursorTiming["motion_preset"],
): boolean {
  const session = strictBrowserRecordingV3Session(id);
  if (!session) return false;
  session.actionEvents = [...events];
  session.cursorMotionPreset = cursorMotionPreset;
  return true;
}

export async function stopStrictBrowserRecordingV3(id: string): Promise<RecordingResultV3 | null> {
  const snapshot = registry.snapshot(id);
  if (!snapshot) return null;
  if (snapshot.result) return snapshot.result;
  const session = registry.session(id);
  if (!session) return null;
  if (session.terminalError) throw session.terminalError;
  if (!session.stopPromise) {
    session.stopPromise = session.transitionQueue.run(() => stopSession(session));
  }
  return session.stopPromise;
}

async function stopSession(session: StrictBrowserSessionV3): Promise<RecordingResultV3> {
  registry.updateLifecycle(session.id, "stopping");
  await reconcileRecordingV3Boundary(session, "stop");
  session.terminalizing = true;
  clearInterval(session.heartbeat);
  session.boundaryFrameResolve = null;
  session.boundaryFrameReject = null;
  session.boundaryKind = null;
  session.pauseGate.cancel();
  detachSurface(session);
  session.window.webContents.stopPainting();
  send(session, { type: "verifying", progress: 0 });
  try {
    const engineResult = session.engine.stop();
    const actions =
      session.actionEvents.length > 0
        ? recordingActionsFromSession(
            {
              outputPath: "master/video.mkv",
              width: session.request.dimensions.physical_width,
              height: session.request.dimensions.physical_height,
              outputWidth: session.request.dimensions.requested_output_width,
              outputHeight: session.request.dimensions.requested_output_height,
              fps: 60,
              frameSeq: engineResult.expectedSlots,
              target: { kind: "author_preview" },
              frameCrop: null,
            },
            session.actionEvents,
            { cursorMotionPreset: session.cursorMotionPreset, version: 3 },
          )
        : null;
    const result = await session.bundleWriter.finalize({ engineResult, actions });
    registry.complete(session.id, result);
    send(session, { type: "verifying", progress: 1 });
    send(session, {
      type: result.status === "completed" ? "completed" : "quality-failed",
      result,
    });
    void recordEngineLog({
      level: result.status === "completed" ? "info" : "error",
      event: "recording.terminal",
      context: {
        session_id: session.id,
        backend_id: session.backend.backendId,
        phase: "verification",
      },
      details: {
        outcome: result.status,
        bundle_path: result.bundle_path,
        contract_version: 3,
        failure_codes: [
          ...result.cadence_evidence.failure_codes,
          ...result.quality_evidence.failure_codes,
        ],
      },
    });
    return result;
  } catch (error) {
    session.terminalizing = false;
    return failSession(session, error);
  } finally {
    if (!session.window.isDestroyed()) session.window.destroy();
    closeEventChannel(session);
  }
}
