import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  type NativeImage,
  screen,
  type WebContents,
} from "electron";
import ffmpegPath from "ffmpeg-static";
import { type FrameSyncOutcome, RecordingActionLandmarkRecorder } from "../action-landmarks";
import {
  authorPreviewTabGrants,
  createRecordingAudioTrackRequest,
  type RecordingAudioTrackRequest,
  recordingAudioMode,
  recordingAudioTracks,
  validateRecordingAudioSelection,
} from "../audio-tracks";
import {
  CaptureBackendContractError,
  CaptureBackendDeliveryGuard,
  type CaptureTargetLostReason,
  resolveCaptureSource,
} from "../capture-backend";
import { resolveRecordingIncludeCursor } from "../cursor-policy";
import {
  type CursorTimingSize,
  HOST_CURSOR_DEFAULT_MIN_LEAD_MS,
  HOST_CURSOR_DEFAULT_MOTION_PRESET,
  HOST_CURSOR_TARGET_STABILITY_THRESHOLD_PX,
} from "../cursor-timing";
import { electronCaptureProvenance } from "../electron-capture-backends";
import { engineHealth, engineHealthInputFromRecording, engineHealthMode } from "../engine-health";
import { readJson, writeJsonAtomic } from "../json-store";
import {
  monotonicEpochMilliseconds,
  recordingAvMode,
  recordingAvSessions,
  recordingUsesLiveVideoSink,
} from "../recording-av-clock";
import {
  RecordingBundleWriter,
  recordingBundleForSession,
  recordingBundleMode,
} from "../recording-bundle";
import {
  disposeRecordingCheckpoints,
  recordingCheckpointMode,
  recordingCheckpointsForSession,
  registerRecordingCheckpoints,
} from "../recording-checkpoints";
import { recordingHealth, recordingHealthMode } from "../recording-health";
import { recordingLifecycle } from "../recording-lifecycle";
import { RecordingMediaClock, recordingFramePtsUs } from "../recording-media-clock";
import { recordEngineLog } from "../recording-observability";
import { RecordingPauseGate } from "../recording-pause-gate";
import {
  type RecordingFitMode,
  type RecordingOutputResolution,
  type RecordingPadColor,
  type RecordingQualityPreset,
  type RecordingScaleAlgo,
  recordingQualityArgs,
  recordingRawVideoInputArgs,
  recordingVideoFilters,
  resolveRecordingOutput,
} from "../recording-pipeline";
import {
  type RecordingReadinessReason,
  recordingReadiness,
  recordingReadinessMode,
} from "../recording-readiness";
import { recordingRepairControllerForSession } from "../recording-repair";
import { recordingSessionJournal } from "../recording-session-journal";
import {
  AUTOMATION_RECORDING_MAX_PADDING_MS,
  recordingFrameCountForElapsedMs,
  recordingTailFrameDelaysMs,
} from "../recording-tail";
import { type ParsedCommand, parseStorySource } from "../story-parser";
import {
  type AuthorPreviewSession,
  type AuthorSnapshotEntry,
  activePickerStreams,
  authorPreviewSessions,
  type CaptureStreamSession,
  type CaptureTarget,
  captureStreamSessions,
  channelIdFrom,
  type DialogButtonSpec,
  type DialogFilterSpec,
  displayById,
  displayInfo,
  EXPORTS_DIRNAME,
  eventListeners,
  type FrameCropRect,
  hostLog,
  type PickResult,
  parseSourceNumericId,
  type RecordingSession,
  recordingSessions,
  type StoryBrowserExecutionProfile,
  sendCallback,
  sendChannel,
  waitMs,
} from "./shared";

export let globalPreviewStreamSessionId: string | null = null;
const recordingHealthSlots = new WeakMap<RecordingSession, number>();
const recordingBackpressureState = new WeakMap<
  RecordingSession,
  { startedAtMs: number; highWater: number }
>();
const tabAudioHandlerSessions = new WeakSet<object>();

function installAuthorPreviewTabAudioHandler(sender: WebContents): void {
  if (tabAudioHandlerSessions.has(sender.session)) return;
  sender.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const grant = request.frame ? authorPreviewTabGrants.consume(request.frame) : null;
      if (!grant) {
        callback({});
        return;
      }
      callback({
        video: grant.source,
        audio: grant.source,
        enableLocalEcho: true,
      });
    },
    { useSystemPicker: false },
  );
  tabAudioHandlerSessions.add(sender.session);
}

function recordingAudioRequests(
  raw: unknown,
  input: {
    sessionId: string;
    target: CaptureTarget;
    audioDeviceId?: string | null;
    audioCaptureId?: string | null;
  },
): RecordingAudioTrackRequest[] {
  if (recordingAudioMode() === "legacy") return [];
  const supplied = Array.isArray(raw) ? raw : [];
  const requests = supplied.map((value) => {
    if (!value || typeof value !== "object") throw new Error("audio track request invalid");
    const candidate = value as Partial<RecordingAudioTrackRequest>;
    if (
      candidate.role !== "microphone" &&
      candidate.role !== "tab" &&
      candidate.role !== "system"
    ) {
      throw new Error("audio track role invalid");
    }
    if (candidate.requirement !== "required" && candidate.requirement !== "optional") {
      throw new Error("audio track requirement invalid");
    }
    return createRecordingAudioTrackRequest({
      track_id: candidate.track_id,
      capture_token: candidate.capture_token,
      role: candidate.role,
      requirement: candidate.requirement,
      source_id: candidate.source_id ?? null,
    });
  });
  if (requests.length === 0 && input.audioDeviceId) {
    requests.push(
      createRecordingAudioTrackRequest({
        track_id: `microphone-${input.sessionId}`,
        capture_token: input.audioCaptureId || `unavailable-${input.sessionId}`,
        role: "microphone",
        requirement: "optional",
        source_id: input.audioDeviceId,
      }),
    );
  }
  const tab = requests.find((request) => request.role === "tab");
  if (tab && input.target.kind === "author_preview" && tab.source_id !== input.target.stream_id) {
    throw new Error("tab audio source must match the active author preview");
  }
  validateRecordingAudioSelection(input.target.kind, requests);
  return requests;
}

interface RecordingCaptureHealthFrame {
  slot: number;
  ptsUs: number;
}

async function recordCheckpointFrameBestEffort(
  session: RecordingSession,
  bitmap: Uint8Array,
  landmark: { frameIndex: number; ptsUs: number },
): Promise<void> {
  try {
    await recordingCheckpointsForSession(session.id)?.recordFrame(bitmap, landmark);
  } catch (error) {
    void hostLog("warn", "recording_scene_segment_frame_failed", {
      session_id: session.id,
      error_name: error instanceof Error ? error.name : "UnknownError",
      reason:
        error && typeof error === "object" && "reason" in error
          ? String((error as { reason: unknown }).reason)
          : "checkpoint_failed",
    });
  }
}

function nextRecordingCaptureHealthFrame(
  session: RecordingSession,
): RecordingCaptureHealthFrame | null {
  const health = recordingHealth.get(session.id);
  if (!health) return null;
  const slot = recordingHealthSlots.get(session) ?? 0;
  recordingHealthSlots.set(session, slot + 1);
  const ptsUs = recordingFramePtsUs(slot, {
    fpsNum: session.effectiveFps,
    fpsDen: 1,
  });
  health.recordScheduledSlot({ slot, ptsUs });
  return { slot, ptsUs };
}

function snapshotRecordingHealth(session: RecordingSession): void {
  recordingHealth.get(session.id)?.snapshot();
}

async function publishEngineHealthBestEffort(
  session: RecordingSession,
  update: Parameters<typeof engineHealthInputFromRecording>[1],
): Promise<void> {
  const publisher = engineHealth.get(session.id);
  if (!publisher) return;
  try {
    const previousState = publisher.evidence()?.latest.state ?? null;
    const statfs = await fs.statfs(path.dirname(session.outputPath));
    const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
    const snapshot = publisher.update(
      engineHealthInputFromRecording(session, update, {
        observedAtMs: Date.now(),
        diskFreeBytes: freeBytes,
        targetLive:
          !session.eventTarget.isDestroyed() && !session.captureBackend?.target_loss_reason,
        repairAvailable: Boolean(recordingRepairControllerForSession(session.id)?.pendingEvent),
      }),
    );
    if (!snapshot) return;
    void recordEngineLog({
      event:
        previousState !== snapshot.state
          ? "recording.health.state_changed"
          : "recording.health.sampled",
      level: snapshot.state === "healthy" || snapshot.state === "starting" ? "info" : "warn",
      context: {
        session_id: session.id,
        phase: snapshot.state,
        reason_code: snapshot.reason_codes[0],
      },
      details: {
        previous_state: previousState,
        sequence: snapshot.sequence,
        effective_fps: snapshot.effective_fps,
        frames_dropped: snapshot.frames_dropped,
        skipped_ticks: snapshot.skipped_ticks,
        encoder_backpressured: snapshot.encoder_backpressured,
        target_liveness: snapshot.target_liveness,
      },
    });
    const bundle = recordingBundleForSession(session.id);
    const evidence = publisher.evidence();
    if (bundle && evidence) {
      const relativePath = "engine-health.json";
      await writeJsonAtomic(path.join(bundle.allocation.stagingRoot, relativePath), evidence);
      bundle.registerArtifact("health", relativePath, false);
    }
    const mode = engineHealthMode();
    if (mode === "internal" || mode === "beta" || mode === "ga") {
      sendChannel(session.eventTarget, session.eventChannelId, {
        type: "health-update",
        snapshot,
      });
    }
  } catch (error) {
    void hostLog("warn", "recording_engine_health_publish_failed", {
      session_id: session.id,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function recordingCaptureActiveMediaMs(session: RecordingSession): number {
  const scheduledSlots = recordingHealthSlots.get(session) ?? 0;
  return (
    recordingFramePtsUs(scheduledSlots, {
      fpsNum: session.effectiveFps,
      fpsDen: 1,
    }) / 1_000
  );
}

export function resizeToFit(image: NativeImage, maxWidth: number, maxHeight: number): NativeImage {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return image;
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  if (!Number.isFinite(scale) || scale >= 1) return image;
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
}

export function cropDisplayRegionThumbnail(
  image: NativeImage,
  target: Extract<CaptureTarget, { kind: "display_region" }>,
): NativeImage {
  const display = displayById(target.display_id);
  const imageSize = image.getSize();
  if (!display || imageSize.width <= 0 || imageSize.height <= 0) return image;

  const displayWidthPx = Math.round(display.bounds.width * display.scaleFactor);
  const displayHeightPx = Math.round(display.bounds.height * display.scaleFactor);
  const scaleX = imageSize.width / displayWidthPx;
  const scaleY = imageSize.height / displayHeightPx;
  const x = Math.max(0, Math.round(target.rect.x * display.scaleFactor * scaleX));
  const y = Math.max(0, Math.round(target.rect.y * display.scaleFactor * scaleY));
  const width = Math.max(1, Math.round(target.rect.w * display.scaleFactor * scaleX));
  const height = Math.max(1, Math.round(target.rect.h * display.scaleFactor * scaleY));
  const crop = {
    x: Math.min(x, Math.max(0, imageSize.width - 1)),
    y: Math.min(y, Math.max(0, imageSize.height - 1)),
    width: Math.min(width, Math.max(1, imageSize.width - x)),
    height: Math.min(height, Math.max(1, imageSize.height - y)),
  };
  return image.crop(crop);
}

export async function windowInfo() {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: true,
  });
  return sources.map((source) => ({
    window_id: parseSourceNumericId(source.id),
    title: source.name || null,
    app_name: source.name || "Window",
    pid: 0,
    bundle_id: "",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    is_on_screen: true,
  }));
}

export async function captureTargetNativeImage(
  target: Exclude<CaptureTarget, { kind: "author_preview" }>,
  maxWidth: number,
  maxHeight: number,
): Promise<NativeImage> {
  const display = target.kind === "display_region" ? displayById(target.display_id) : null;
  const thumbnailSize = display
    ? {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      }
    : { width: maxWidth, height: maxHeight };
  const sourceTypes =
    target.kind === "window" || target.kind === "window_by_pid" ? ["window"] : ["screen"];
  const sources = await desktopCapturer.getSources({
    types: sourceTypes as Array<"window" | "screen">,
    thumbnailSize,
    fetchWindowIcons: true,
  });
  const resolved = resolveCaptureSource(
    target,
    sources.map((candidate) => ({
      source_id: candidate.id,
      native_window_id:
        target.kind === "window" || target.kind === "window_by_pid"
          ? parseSourceNumericId(candidate.id)
          : null,
      display_id: candidate.display_id || null,
      owner_pid: null,
      title: candidate.name || null,
    })),
  );
  const source = sources.find((candidate) => candidate.id === resolved.source_id);
  if (!source) {
    throw new CaptureBackendContractError("target_not_found", "capture target unavailable");
  }
  if (source.thumbnail.isEmpty()) {
    throw new CaptureBackendContractError("target_not_found", "capture target thumbnail is empty");
  }
  const image =
    target.kind === "display_region"
      ? resizeToFit(cropDisplayRegionThumbnail(source.thumbnail, target), maxWidth, maxHeight)
      : source.thumbnail;
  return image;
}

function captureBackendContractEnforced(session: RecordingSession): boolean {
  return (
    session.captureBackend?.mode === "contract_internal" ||
    session.captureBackend?.mode === "contract_ga"
  );
}

function captureTargetLostReason(
  session: RecordingSession,
  error: unknown,
): CaptureTargetLostReason | null {
  if (session.target.kind === "author_preview") return null;
  if (error instanceof CaptureBackendContractError) {
    if (
      error.reason !== "target_not_found" &&
      error.reason !== "target_ambiguous" &&
      error.reason !== "target_invalid" &&
      error.reason !== "pid_resolution_unsupported"
    ) {
      return null;
    }
    if (error.reason === "target_not_found") {
      if (session.target.kind === "window") return "window_closed";
      if (session.target.kind === "window_by_pid") return "process_exited";
      return "display_removed";
    }
    return "source_unresolvable";
  }
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /permission|notallowed|not allowed/i.test(message) ? "permission_revoked" : null;
}

async function deliverCaptureBackendFrame(
  session: RecordingSession,
  payload: Uint8Array,
  healthFrame: RecordingCaptureHealthFrame | null,
): Promise<void> {
  const delivery = session.captureBackendDelivery;
  const backend = session.captureBackend;
  if (!delivery || !backend || session.target.kind === "author_preview") return;
  if (backend.target_loss_reason) return;
  const durationUs = Math.max(1, Math.round(1_000_000 / session.effectiveFps));
  const lastPtsUs = session.captureBackendLastPtsUs ?? null;
  const requestedPtsUs = healthFrame?.ptsUs ?? (lastPtsUs == null ? 0 : lastPtsUs + durationUs);
  const ptsUs =
    lastPtsUs == null ? Math.max(0, requestedPtsUs) : Math.max(lastPtsUs + 1, requestedPtsUs);
  try {
    const disposition = await delivery.deliver({
      type: "frame",
      backend_id: backend.selected_backend_id,
      session_id: session.id,
      sequence: session.captureBackendDeliverySequence ?? 0,
      frame_index: session.captureBackendFrameIndex ?? 0,
      pts_us: ptsUs,
      duration_us: durationUs,
      width: session.width,
      height: session.height,
      pixel_format: "bgra",
      payload,
    });
    if (disposition !== "accepted") {
      throw new CaptureBackendContractError("delivery_invalid", "capture delivery backpressured");
    }
    session.captureBackendDeliverySequence = (session.captureBackendDeliverySequence ?? 0) + 1;
    session.captureBackendFrameIndex = (session.captureBackendFrameIndex ?? 0) + 1;
    session.captureBackendLastPtsUs = ptsUs;
  } catch (error) {
    if (backend.mode !== "contract_shadow") throw error;
    void hostLog("warn", "recording_capture_backend_shadow_delivery_failed", {
      session_id: session.id,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function markRecordingCaptureTargetLost(
  session: RecordingSession,
  error: unknown,
): Promise<boolean> {
  const backend = session.captureBackend;
  if (!backend || backend.mode === "legacy") return false;
  const reason = captureTargetLostReason(session, error);
  if (!reason) return false;
  if (backend.target_loss_reason) return true;

  const sequence = session.captureBackendDeliverySequence ?? 0;
  try {
    await session.captureBackendDelivery?.deliver({
      type: "targetLost",
      backend_id: backend.selected_backend_id,
      session_id: session.id,
      sequence,
      reason,
      observed_at_us: Math.round(
        monotonicEpochMilliseconds(performance.timeOrigin, performance.now()) * 1_000,
      ),
      last_pts_us: session.captureBackendLastPtsUs ?? null,
    });
    session.captureBackendDeliverySequence = sequence + 1;
  } catch (deliveryError) {
    void hostLog("warn", "recording_capture_backend_target_loss_delivery_failed", {
      session_id: session.id,
      error_name: deliveryError instanceof Error ? deliveryError.name : "UnknownError",
    });
  }

  const enforced = captureBackendContractEnforced(session);
  session.captureBackend = {
    ...backend,
    target_loss_reason: reason,
    terminal_status: enforced ? "target_lost" : backend.terminal_status,
  };
  if (enforced) {
    const terminalError = new Error(`capture target lost: ${reason}`);
    terminalError.name = "CaptureTargetLostError";
    session.encoderError ??= terminalError;
    if (session.captureTimer) clearInterval(session.captureTimer);
    session.captureTimer = null;
    const update = recordingHealth.get(session.id)?.latestUpdate();
    if (update) void publishEngineHealthBestEffort(session, update);
  }
  void hostLog("warn", "recording_capture_target_lost", {
    session_id: session.id,
    target_kind: session.target.kind,
    reason,
    enforced,
  });
  void recordEngineLog({
    level: "warn",
    event: "recording.backend.target_lost",
    context: {
      session_id: session.id,
      backend_id: backend.selected_backend_id,
      reason_code: reason,
      phase: "capture",
    },
    details: {
      enforced,
      target_kind: session.target.kind,
      last_pts_us: session.captureBackendLastPtsUs ?? null,
    },
  });
  return true;
}

export async function captureTargetThumbnail(
  target: CaptureTarget,
  maxWidth: number,
  maxHeight: number,
) {
  if (target.kind === "author_preview") {
    const image = await captureAuthorPreviewNativeImage(target.stream_id, maxWidth, maxHeight);
    return Array.from(image.toPNG());
  }
  const image = await captureTargetNativeImage(target, maxWidth, maxHeight);
  return Array.from(image.toPNG());
}

export function snapshotDir(projectDir: string): string {
  const root = path.resolve(projectDir);
  if (!path.isAbsolute(root)) throw new Error(`projectDir must be absolute: ${projectDir}`);
  if (root.split(path.sep).includes("..")) throw new Error("path traversal rejected in projectDir");
  return path.join(root, ".story.snapshots");
}

export function snapshotKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function snapshotEntry(
  url: string,
  html: string,
  htmlPath: string,
  screenshotPath: string,
): AuthorSnapshotEntry {
  const domHash = createHash("sha256").update(html).digest("hex");
  const capturedAt = new Date().toISOString();
  return {
    url,
    dom_hash: domHash,
    domHash,
    captured_at: capturedAt,
    capturedAt,
    screenshot_path: screenshotPath,
    screenshotPath,
    html_path: htmlPath,
    htmlPath,
  };
}

export async function authorSnapshotGet(
  projectDir: string,
  url: string,
): Promise<AuthorSnapshotEntry | null> {
  const manifest = path.join(snapshotDir(projectDir), `${snapshotKey(url)}.json`);
  try {
    return JSON.parse(await fs.readFile(manifest, "utf8")) as AuthorSnapshotEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function authorSnapshotList(projectDir: string): Promise<AuthorSnapshotEntry[]> {
  const dir = snapshotDir(projectDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return JSON.parse(
              await fs.readFile(path.join(dir, entry.name), "utf8"),
            ) as AuthorSnapshotEntry;
          } catch {
            return null;
          }
        }),
    );
    return snapshots.filter((entry): entry is AuthorSnapshotEntry => entry != null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function authorSnapshotCapture(
  projectDir: string,
  url: string,
): Promise<AuthorSnapshotEntry> {
  const dir = snapshotDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await win.loadURL(url);
    const html = (await win.webContents.executeJavaScript(
      "document.documentElement.outerHTML",
      true,
    )) as string;
    const image = await win.webContents.capturePage();
    const key = snapshotKey(url);
    const htmlPath = path.join(dir, `${key}.html`);
    const screenshotPath = path.join(dir, `${key}.png`);
    const manifestPath = path.join(dir, `${key}.json`);
    await fs.writeFile(htmlPath, html, "utf8");
    await fs.writeFile(screenshotPath, image.toPNG());
    const entry = snapshotEntry(win.webContents.getURL() || url, html, htmlPath, screenshotPath);
    await fs.writeFile(manifestPath, JSON.stringify(entry, null, 2), "utf8");
    return entry;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export async function authorSnapshotValidate(projectDir: string, url: string, target: unknown) {
  const entry = await authorSnapshotGet(projectDir, url);
  if (!entry) return { status: "no_snapshot" };
  const html = await fs.readFile(entry.html_path ?? entry.htmlPath, "utf8");
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const result = await win.webContents.executeJavaScript(
      `((target) => {
        const textOf = (el) => (el.innerText || el.textContent || "").trim();
        const all = Array.from(document.querySelectorAll("*"));
        let matches = [];
        if (!target || typeof target !== "object") return { status: "none" };
        switch (target.kind) {
          case "selector":
            try { matches = Array.from(document.querySelectorAll(String(target.value))); } catch { matches = []; }
            break;
          case "test_id":
            matches = all.filter((el) => el.getAttribute("data-testid") === String(target.value));
            break;
          case "aria":
            matches = all.filter((el) => el.getAttribute("aria-label") === String(target.value));
            break;
          case "label":
            matches = all.filter((el) => {
              if (el.tagName === "LABEL" && textOf(el).includes(String(target.value))) return true;
              return el.getAttribute("aria-label")?.includes(String(target.value));
            });
            break;
          case "text_exact":
            matches = all.filter((el) => textOf(el) === String(target.value));
            break;
          case "text":
            matches = all.filter((el) => textOf(el).includes(String(target.value)));
            break;
          case "role": {
            const role = target.value && typeof target.value === "object" ? String(target.value.role || "") : "";
            const name = target.value && typeof target.value === "object" ? String(target.value.name || "") : "";
            matches = all.filter((el) => (!role || el.getAttribute("role") === role) && (!name || textOf(el).includes(name) || el.getAttribute("aria-label")?.includes(name)));
            break;
          }
        }
        if (matches.length === 1) return { status: "unique", strategy: String(target.kind) };
        if (matches.length > 1) return { status: "fuzzy", count: matches.length, reason: "multiple matches" };
        return { status: "none" };
      })(${JSON.stringify(target)})`,
      true,
    );
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

export function defaultCaptureTarget(): CaptureTarget {
  return { kind: "display", display_id: screen.getPrimaryDisplay().id };
}

export function isAuthorPreviewTarget(
  target: CaptureTarget | null | undefined,
): target is Extract<CaptureTarget, { kind: "author_preview" }> {
  return target?.kind === "author_preview";
}

export function displayForTarget(target: CaptureTarget) {
  const displays = displayInfo();
  if (target.kind === "display" || target.kind === "display_region") {
    return (
      displays.find((display) => Number(display.id) === Number(target.display_id)) ?? displays[0]
    );
  }
  return displays[0];
}

export function dimensionsForTarget(
  target: CaptureTarget,
  fallbackWidth = 1280,
  fallbackHeight = 720,
) {
  if (target.kind === "author_preview") {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  const display = displayForTarget(target);
  if (target.kind === "display_region") {
    const scale = display?.scale_factor ?? 1;
    return {
      width: clampDimension(target.rect.w * scale, fallbackWidth),
      height: clampDimension(target.rect.h * scale, fallbackHeight),
    };
  }
  if (display) {
    return {
      width: clampDimension(display.width_px, fallbackWidth),
      height: clampDimension(display.height_px, fallbackHeight),
    };
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

export function captureEventJson(kind: string, payload: Record<string, unknown> = {}) {
  return { json: JSON.stringify({ kind, ...payload }) };
}

export async function pumpCaptureStreamFrame(session: CaptureStreamSession): Promise<void> {
  const frameSequence = session.sequence + 1;
  try {
    const bytes = await captureTargetThumbnail(session.target, session.width, session.height);
    session.sequence = frameSequence;
    session.bytesPeak = Math.max(session.bytesPeak, bytes.length);
    sendChannel(session.sender, session.frameChannelId, {
      sequence: frameSequence,
      pts_ns: Math.round((Date.now() - session.startedAt) * 1_000_000),
      clock_source: "synthetic",
      bytes: bytes.length,
      width_px: session.width,
      height_px: session.height,
    });
    sendChannel(
      session.sender,
      session.eventChannelId,
      captureEventJson("frame-delivered", {
        sequence: frameSequence,
        pts: {
          ns: Math.round((Date.now() - session.startedAt) * 1_000_000),
          source: "synthetic",
        },
        bytes: bytes.length,
      }),
    );
  } catch (error) {
    session.framesDropped += 1;
    sendChannel(
      session.sender,
      session.eventChannelId,
      captureEventJson("frame-dropped", {
        sequence: frameSequence,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function startCaptureStream(
  rawArgs: unknown,
  onEvent: unknown,
  onFrame: unknown,
  sender: WebContents,
) {
  const args = rawArgs as
    | {
        target?: CaptureTarget;
        display_id?: number | string;
        fps_target?: number;
      }
    | undefined;
  const target =
    args?.target ??
    (args?.display_id != null
      ? ({ kind: "display", display_id: args.display_id } as CaptureTarget)
      : defaultCaptureTarget());
  if (isAuthorPreviewTarget(target)) {
    throw new Error("author_preview is only supported by start_recording");
  }
  const fps = clampFps(args?.fps_target);
  const { width, height } = dimensionsForTarget(target);
  const id = randomUUID();
  const session: CaptureStreamSession = {
    id,
    target,
    width,
    height,
    fps,
    startedAt: Date.now(),
    sender,
    eventChannelId: channelIdFrom(onEvent),
    frameChannelId: channelIdFrom(onFrame),
    timer: setInterval(
      () => {
        if (session.captureInFlight) return;
        session.captureInFlight = pumpCaptureStreamFrame(session).finally(() => {
          session.captureInFlight = null;
        });
      },
      Math.max(1000 / fps, 16),
    ),
    sequence: 0,
    framesDropped: 0,
    bytesPeak: 0,
    captureInFlight: null,
  };
  session.timer.unref?.();
  captureStreamSessions.set(id, session);
  const display = displayForTarget(target);
  if (display) {
    sendChannel(sender, session.eventChannelId, captureEventJson("started", { display }));
  }
  await pumpCaptureStreamFrame(session);
  return { id };
}

export async function stopCaptureStream(raw: unknown) {
  const id =
    typeof raw === "string" ? raw : String((raw as { id?: unknown } | undefined)?.id ?? "");
  const session = captureStreamSessions.get(id);
  if (!session) {
    return {
      frames_delivered: 0,
      frames_dropped: 0,
      bytes_peak: 0,
      duration_ms: 0,
    };
  }
  captureStreamSessions.delete(id);
  clearInterval(session.timer);
  if (session.captureInFlight) await session.captureInFlight;
  const stats = {
    frames_delivered: session.sequence,
    frames_dropped: session.framesDropped,
    bytes_peak: session.bytesPeak,
    duration_ms: Math.max(0, Date.now() - session.startedAt),
  };
  sendChannel(session.sender, session.eventChannelId, captureEventJson("stopped", { stats }));
  return stats;
}

export function resolveActiveAuthorPreviewTarget(streamId?: string | null, ensureVisible = false) {
  const candidates =
    streamId && streamId.length > 0
      ? [authorPreviewSessions.get(streamId)].filter((session): session is AuthorPreviewSession =>
          Boolean(session),
        )
      : [...authorPreviewSessions.values()];
  for (const session of candidates) {
    if (session.window.isDestroyed()) continue;
    // Offscreen author previews are not valid desktop-capture recording targets.
    // Browser-story recording must use the author_preview target and capture
    // webContents pixels directly instead of resolving this window id.
    if (ensureVisible && !session.window.isVisible()) {
      session.window.showInactive();
    }
    const mediaSourceId = session.window.getMediaSourceId();
    const windowId = parseSourceNumericId(mediaSourceId);
    const bounds = session.window.getContentBounds();
    void hostLog("info", "resolve_playwright_target", {
      requested_stream_id: streamId ?? "",
      author_session_count: authorPreviewSessions.size,
      resolved_stream_id: session.id,
      browser_window_id: session.window.id,
      media_source_id: mediaSourceId,
      window_id: windowId,
      visible: session.window.isVisible(),
      width_px: bounds.width,
      height_px: bounds.height,
    });
    return {
      window_id: windowId,
      pid: process.pid,
      width_px: bounds.width,
      height_px: bounds.height,
      content_crop: {
        x: 0,
        y: 0,
        w: bounds.width,
        h: bounds.height,
        basis_w: bounds.width,
        basis_h: bounds.height,
        scale_hint: screen.getDisplayMatching(bounds).scaleFactor,
      },
    };
  }
  void hostLog("warn", "resolve_playwright_target unavailable", {
    requested_stream_id: streamId ?? "",
    author_session_count: authorPreviewSessions.size,
    candidate_ids: [...authorPreviewSessions.keys()].join(","),
  });
  return null;
}

export function dialogMessageType(
  kind: unknown,
): "none" | "info" | "error" | "question" | "warning" {
  if (kind === "error" || kind === "warning" || kind === "info") return kind;
  return "info";
}

export function dialogButtonPlan(spec: DialogButtonSpec | null | undefined): {
  buttons: string[];
  cancelId?: number;
  result: (response: number) => string;
} {
  if (spec === "OkCancel") {
    return {
      buttons: ["OK", "Cancel"],
      cancelId: 1,
      result: (response) => (response === 0 ? "Ok" : "Cancel"),
    };
  }
  if (spec === "YesNo") {
    return {
      buttons: ["Yes", "No"],
      cancelId: 1,
      result: (response) => (response === 0 ? "Yes" : "No"),
    };
  }
  if (spec === "YesNoCancel") {
    return {
      buttons: ["Yes", "No", "Cancel"],
      cancelId: 2,
      result: (response) => (response === 0 ? "Yes" : response === 1 ? "No" : "Cancel"),
    };
  }
  if (
    spec &&
    typeof spec === "object" &&
    "OkCancelCustom" in spec &&
    Array.isArray(spec.OkCancelCustom)
  ) {
    const labels = spec.OkCancelCustom;
    return {
      buttons: labels,
      cancelId: 1,
      result: (response) => (response === 0 ? "Ok" : "Cancel"),
    };
  }
  if (
    spec &&
    typeof spec === "object" &&
    "YesNoCancelCustom" in spec &&
    Array.isArray(spec.YesNoCancelCustom)
  ) {
    const labels = spec.YesNoCancelCustom;
    return {
      buttons: labels,
      cancelId: 2,
      result: (response) => (response === 0 ? "Yes" : response === 1 ? "No" : "Cancel"),
    };
  }
  if (spec && typeof spec === "object" && "OkCustom" in spec && typeof spec.OkCustom === "string") {
    return { buttons: [spec.OkCustom], result: () => "Ok" };
  }
  return { buttons: ["OK"], result: () => "Ok" };
}

export async function showDialogMessage(args: unknown): Promise<string> {
  const payload = args as
    | {
        message?: unknown;
        title?: unknown;
        kind?: unknown;
        buttons?: DialogButtonSpec | null;
      }
    | undefined;
  const plan = dialogButtonPlan(payload?.buttons);
  const result = await dialog.showMessageBox({
    title: typeof payload?.title === "string" ? payload.title : app.name,
    message: String(payload?.message ?? ""),
    type: dialogMessageType(payload?.kind),
    buttons: plan.buttons,
    cancelId: plan.cancelId,
    defaultId: 0,
    noLink: true,
  });
  return plan.result(result.response);
}

export function electronDialogFilters(filters: DialogFilterSpec[] | undefined) {
  if (!Array.isArray(filters)) return undefined;
  return filters
    .map((filter) => ({
      name: filter.name || "Files",
      extensions: Array.isArray(filter.extensions)
        ? filter.extensions.map((extension) => extension.replace(/^\./, "")).filter(Boolean)
        : [],
    }))
    .filter((filter) => filter.extensions.length > 0);
}

export async function captureRecordingFrame(
  session: RecordingSession,
  healthFrame: RecordingCaptureHealthFrame | null = null,
): Promise<void> {
  if (session.paused) {
    if (healthFrame) recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "paused");
    return;
  }
  const startedAt = Date.now();
  const frameIndex = session.frameSeq + 1;
  const framePath = path.join(
    session.framesDir,
    `frame-${String(frameIndex).padStart(6, "0")}.png`,
  );
  try {
    const image = await captureRecordingNativeImage(session);
    recordingReadiness.get(session.id)?.markSourceReady();
    await fs.writeFile(framePath, image.toPNG());
    const imageSize = image.getSize();
    const checkpointImage =
      imageSize.width === session.width && imageSize.height === session.height
        ? image
        : image.resize({ width: session.width, height: session.height, quality: "best" });
    const bitmap = checkpointImage.toBitmap({ scaleFactor: 1 });
    await deliverCaptureBackendFrame(session, bitmap, healthFrame);
    if (healthFrame) {
      const health = recordingHealth.get(session.id);
      health?.recordSourceFrame(healthFrame.slot);
      health?.recordSubmission(healthFrame);
    }
    const landmark = session.mediaClock.commitFrame(true);
    if (landmark) {
      session.actionLandmarks.commitFrame(landmark);
      await recordCheckpointFrameBestEffort(session, bitmap, landmark);
    }
    session.frameSeq = session.mediaClock.snapshot().frameCount;
  } catch {
    if (healthFrame) {
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "source_unavailable");
    }
    session.framesDropped += 1;
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "frames-dropped",
      total: session.framesDropped,
      delta: 1,
    });
  } finally {
    const durationMs = Date.now() - startedAt;
    session.captureDurationMs.push(durationMs);
    if (session.captureDurationMs.length > 300) session.captureDurationMs.shift();
    if (durationMs > 1000 / session.effectiveFps) session.lateFrames += 1;
    snapshotRecordingHealth(session);
  }
}

export function startRecordingFfmpegPipe(
  ffmpegArgs: string[],
  onEncodedFrame?: (encodedFrameCount: number) => void,
): {
  child: ChildProcess;
  done: Promise<void>;
} {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");
  const child = spawn(binary, ffmpegArgs, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let progressBuffer = "";
  let lastEncodedFrameCount = 0;
  const appendStderr = (chunk: Buffer) => {
    const text = String(chunk);
    stderr = `${stderr}${text}`.slice(-2000);
    progressBuffer += text;
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^frame=(\d+)$/.exec(line.trim());
      if (!match) continue;
      const frameCount = Number(match[1]);
      if (!Number.isSafeInteger(frameCount) || frameCount <= lastEncodedFrameCount) continue;
      lastEncodedFrameCount = frameCount;
      onEncodedFrame?.(frameCount);
    }
  };
  const done = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", appendStderr);
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
  return { child, done };
}

export function authorPreviewStreamFfmpegArgs(session: RecordingSession): string[] {
  const filters = recordingVideoFilters({
    sourceWidth: session.width,
    sourceHeight: session.height,
    outputWidth: session.outputWidth,
    outputHeight: session.outputHeight,
    fitMode: session.fitMode,
    padColor: session.padColor,
    scaleAlgo: session.scaleAlgo,
  });
  const args = [
    "-y",
    "-nostats",
    "-stats_period",
    "0.1",
    "-progress",
    "pipe:2",
    ...recordingRawVideoInputArgs({
      width: session.width,
      height: session.height,
      fps: session.effectiveFps,
      pixelFormat: "bgra",
    }),
  ];
  args.push("-vf", filters.join(","));
  args.push("-an");
  args.push(
    "-c:v",
    "libx264",
    ...recordingQualityArgs(session.qualityPreset),
    // REC-050 readiness treats FFmpeg progress as the encoded-frame ACK.
    // Disable x264 reordering/lookahead so a bounded tail barrier can observe
    // the final submitted frames before stdin closes.
    "-tune",
    "zerolatency",
    "-movflags",
    "+faststart",
    recordingAvSessions.get(session.id)?.videoOnlyPath ?? session.outputPath,
  );
  return args;
}

export function acknowledgeEncodedRecordingFrames(
  session: RecordingSession,
  encodedFrameCount: number,
): void {
  const readiness = recordingReadiness.get(session.id);
  try {
    while (session.mediaClock.snapshot().frameCount < encodedFrameCount) {
      const wasPaused = session.mediaClock.snapshot().state === "paused";
      if (wasPaused) session.mediaClock.resume();
      const landmark = session.mediaClock.commitFrame(true);
      if (wasPaused) session.mediaClock.pause();
      if (!landmark) break;
      session.actionLandmarks.commitFrame(landmark);
      session.frameSeq = session.mediaClock.snapshot().frameCount;
      recordingAvSessions.get(session.id)?.observeEncodedVideoFrame({
        ptsUs: landmark.ptsUs,
        monotonicEpochMs: monotonicEpochMilliseconds(performance.timeOrigin, performance.now()),
      });
      recordingHealth.get(session.id)?.recordSinkAck({
        ...landmark,
        committedAtMs: Date.now(),
      });
      snapshotRecordingHealth(session);
      readiness?.acknowledgeEncodedFrame({
        sessionId: session.id,
        encodedFrameCount: session.frameSeq,
        landmark,
      });
    }
  } catch (error) {
    session.encoderError = error instanceof Error ? error : new Error(String(error));
    readiness?.markEncoderFailed();
  }
}

export async function startAuthorPreviewRecordingStream(session: RecordingSession): Promise<void> {
  const preview =
    session.target.kind === "author_preview" ? authorSession(session.target.stream_id) : null;
  const { child, done } = startRecordingFfmpegPipe(
    authorPreviewStreamFfmpegArgs(session),
    (encodedFrameCount) => acknowledgeEncodedRecordingFrames(session, encodedFrameCount),
  );
  session.ffmpegProcess = child;
  session.ffmpegDone = done;
  void recordEngineLog({
    event: "recording.encoder.started",
    context: {
      session_id: session.id,
      phase: "capture",
      backend_id: session.captureBackend?.selected_backend_id,
    },
    details: {
      capture_path: "raw_bgra",
      output_width: session.outputWidth,
      output_height: session.outputHeight,
      effective_fps: session.effectiveFps,
    },
  });
  if (!child.stdin) {
    throw new Error("ffmpeg stdin pipe was not created");
  }
  child.stdin.on("error", (error: Error) => {
    session.encoderError = error;
  });

  if (preview && session.target.kind === "author_preview") {
    session.authorPaintHandler = (_event, _dirty, image) => {
      recordAuthorPreviewPaint(session, image);
    };
    preview.window.webContents.on("paint", session.authorPaintHandler);
    if (preview.latestPaintImage) {
      recordAuthorPreviewPaint(session, preview.latestPaintImage);
    } else {
      try {
        recordAuthorPreviewPaint(
          session,
          await captureAuthorPreviewNativeImage(
            session.target.stream_id,
            session.width,
            session.height,
          ),
        );
      } catch {
        // A first paint event may still arrive after start. Stop will fail if none do.
      }
    }
  }
  await queueRecordingFrame(session);
}

export function recordAuthorPreviewPaint(session: RecordingSession, image: NativeImage): void {
  if (session.paused) return;
  session.sourceFramesReceived += 1;
  session.paintSequence += 1;
  session.actionLandmarks.notePaint();
  session.latestAuthorPreviewImage = image;
  recordingReadiness.get(session.id)?.markSourceReady();
}

export async function submitAuthorPreviewFrame(
  session: RecordingSession,
  image: NativeImage,
  healthFrame: RecordingCaptureHealthFrame | null = null,
): Promise<void> {
  if (session.paused) {
    if (healthFrame) recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "paused");
    return;
  }
  if (session.encoderError) {
    session.framesDropped += 1;
    if (healthFrame) {
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "source_unavailable");
    }
    return;
  }
  const child = session.ffmpegProcess;
  if (!child || child.killed || !child.stdin || child.stdin.destroyed) {
    session.framesDropped += 1;
    if (healthFrame) {
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "source_unavailable");
    }
    return;
  }
  const stdin = child.stdin;
  if (session.encoderBackpressured) {
    session.skippedTicks += 1;
    if (healthFrame)
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "backpressure");
    return;
  }
  const startedAt = Date.now();
  try {
    const size = image.getSize();
    const frame =
      size.width === session.width && size.height === session.height
        ? image
        : image.resize({
            width: session.width,
            height: session.height,
            quality: "best",
          });
    const bitmap = frame.toBitmap({ scaleFactor: 1 });
    const expectedBytes = session.width * session.height * 4;
    if (bitmap.byteLength !== expectedBytes) {
      throw new Error(`recording bitmap size ${bitmap.byteLength} did not match ${expectedBytes}`);
    }
    await deliverCaptureBackendFrame(session, bitmap, healthFrame);
    const accepted = stdin.write(bitmap);
    const drainPromise = accepted
      ? null
      : new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            stdin.off("drain", onDrain);
            stdin.off("error", onError);
            child.off("exit", onExit);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onExit = () => {
            cleanup();
            reject(new Error("recording encoder exited while draining input"));
          };
          stdin.once("drain", onDrain);
          stdin.once("error", onError);
          child.once("exit", onExit);
        });
    if (drainPromise) {
      session.encoderBackpressureEvents += 1;
      session.encoderBackpressured = true;
      recordingBackpressureState.set(session, {
        startedAtMs: Date.now(),
        highWater: Math.max(0, stdin.writableLength),
      });
    }
    // The primary encoder may acknowledge this write while the shadow scene
    // encoder is still consuming its copy. Publish submission ownership before
    // awaiting that mirror so a valid primary ACK cannot be rejected as early.
    recordingReadiness.get(session.id)?.markFrameSubmitted();
    const checkpointClock = session.mediaClock.snapshot();
    await recordCheckpointFrameBestEffort(session, bitmap, {
      frameIndex: checkpointClock.frameCount,
      ptsUs: checkpointClock.nextPtsUs,
    });
    if (healthFrame) {
      const health = recordingHealth.get(session.id);
      health?.recordSourceFrame(healthFrame.slot);
      health?.recordSubmission(healthFrame);
    }
    if (drainPromise) {
      await drainPromise.finally(() => {
        session.encoderBackpressured = false;
        const backpressure = recordingBackpressureState.get(session);
        if (backpressure) {
          recordingHealth.get(session.id)?.recordBackpressureSpan({
            startedAtMs: backpressure.startedAtMs,
            endedAtMs: Date.now(),
            highWater: backpressure.highWater,
          });
          recordingBackpressureState.delete(session);
        }
      });
    }
  } catch (error) {
    session.framesDropped += 1;
    if (error instanceof Error) session.encoderError = error;
    recordingReadiness.get(session.id)?.markEncoderFailed();
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "frames-dropped",
      total: session.framesDropped,
      delta: 1,
    });
  } finally {
    const durationMs = Date.now() - startedAt;
    session.captureDurationMs.push(durationMs);
    if (session.captureDurationMs.length > 300) session.captureDurationMs.shift();
    if (durationMs > 1000 / session.effectiveFps) session.lateFrames += 1;
    snapshotRecordingHealth(session);
  }
}

export async function submitLatestAuthorPreviewFrame(
  session: RecordingSession,
  healthFrame: RecordingCaptureHealthFrame | null = null,
): Promise<void> {
  if (session.target.kind !== "author_preview") {
    const image = await captureRecordingNativeImage(session);
    session.sourceFramesReceived += 1;
    recordingReadiness.get(session.id)?.markSourceReady();
    await submitAuthorPreviewFrame(session, image, healthFrame);
    return;
  }
  const preview = authorSession(session.target.stream_id);
  const latestImage = session.latestAuthorPreviewImage;
  const needsFreshCapture = !latestImage || preview.latestPaintImage == null;
  if (needsFreshCapture) {
    const image = await captureAuthorPreviewNativeImage(
      session.target.stream_id,
      session.width,
      session.height,
    );
    recordAuthorPreviewPaint(session, image);
    await submitAuthorPreviewFrame(session, image, healthFrame);
    return;
  }
  await submitAuthorPreviewFrame(session, latestImage, healthFrame);
}

export function queueRecordingFrame(session: RecordingSession): Promise<void> {
  if (session.paused) {
    return Promise.resolve();
  }
  const healthFrame = nextRecordingCaptureHealthFrame(session);
  if (session.captureInFlight) {
    session.skippedTicks += 1;
    if (healthFrame)
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "capture_busy");
    snapshotRecordingHealth(session);
    return session.captureInFlight;
  }
  const capture = (
    session.streaming
      ? submitLatestAuthorPreviewFrame(session, healthFrame)
      : captureRecordingFrame(session, healthFrame)
  ).finally(() => {
    if (session.captureInFlight === capture) session.captureInFlight = null;
  });
  session.captureInFlight = capture;
  return capture;
}

export function scheduleRecordingFrame(
  session: RecordingSession,
  queueFrame: (session: RecordingSession) => Promise<void> = queueRecordingFrame,
): void {
  if (session.captureInFlight) {
    session.skippedTicks += 1;
    const healthFrame = nextRecordingCaptureHealthFrame(session);
    if (healthFrame)
      recordingHealth.get(session.id)?.recordSkipped(healthFrame.slot, "capture_busy");
    snapshotRecordingHealth(session);
    return;
  }
  void queueFrame(session).catch((error) => {
    session.framesDropped += 1;
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "frames-dropped",
      total: session.framesDropped,
      delta: 1,
    });
    void hostLog("warn", "recording_frame_capture_failed", {
      ...recordingCaptureStateSnapshot(session),
      reason: "frame_capture_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  });
}

// The software encoder and scene-segment mirror can legitimately need more
// than 500ms to drain on constrained machines. Presentation latency is still
// measured by REC-060; this budget only bounds how long correctness waits for
// a real encoded landmark before failing closed.
const FRAME_COMMIT_MIN_BUDGET_MS = 2_000;
const FRAME_COMMIT_MAX_BUDGET_MS = 2_000;
const FRAME_COMMIT_BUDGET_INTERVALS = 4;

export function recordingFrameCommitBudgetMs(session: RecordingSession): number {
  const frameIntervalMs = 1_000 / Math.max(1, session.effectiveFps);
  return Math.min(
    FRAME_COMMIT_MAX_BUDGET_MS,
    Math.max(
      FRAME_COMMIT_MIN_BUDGET_MS,
      Math.ceil(frameIntervalMs * FRAME_COMMIT_BUDGET_INTERVALS),
    ),
  );
}

export function recordingCaptureStateSnapshot(session: RecordingSession): Record<string, unknown> {
  return {
    session_id: session.id,
    lifecycle: session.lifecycle,
    paused: session.paused,
    streaming: session.streaming,
    frame_count: session.mediaClock.snapshot().frameCount,
    capture_in_flight: Boolean(session.captureInFlight),
    encoder_backpressured: session.encoderBackpressured,
    encoder_error: Boolean(session.encoderError),
    frames_dropped: session.framesDropped,
    skipped_ticks: session.skippedTicks,
  };
}

async function waitForFrameTaskWithinBudget(
  task: Promise<void>,
  deadlineMs: number,
): Promise<"settled" | "timeout"> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) return "timeout";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function requestRecordingFrameCommit(
  session: RecordingSession,
  queueFrame: (session: RecordingSession) => Promise<void> = queueRecordingFrame,
): Promise<FrameSyncOutcome> {
  const readiness = recordingReadiness.get(session.id);
  if (readiness?.mode === "observe") {
    void readiness.request({
      barrier: "pre_input_frame_committed",
      budgetMs: recordingFrameCommitBudgetMs(session),
      requestedMediaUs: session.mediaClock.snapshot().nextPtsUs,
      queueFrame: () => queueFrame(session),
    });
  } else if (readiness?.mode === "enforce") {
    const result = await readiness.require({
      barrier: "pre_input_frame_committed",
      budgetMs: recordingFrameCommitBudgetMs(session),
      requestedMediaUs: session.mediaClock.snapshot().nextPtsUs,
      queueFrame: () => queueFrame(session),
    });
    if (result.status === "committed" && result.committed_landmark) {
      return { status: "committed", landmark: result.committed_landmark };
    }
    if (result.status === "cancelled") return { status: "cancelled" };
    return {
      status: "degraded",
      reason: readinessFrameSyncReason(result.reason),
    };
  }

  const initialState = recordingFrameSyncAvailability(session);
  if (initialState) return initialState;

  const previous = session.actionLandmarks.latestCommittedFrame();
  const deadlineMs = Date.now() + recordingFrameCommitBudgetMs(session);
  try {
    if (
      session.captureInFlight &&
      (await waitForFrameTaskWithinBudget(session.captureInFlight, deadlineMs)) === "timeout"
    ) {
      return { status: "degraded", reason: "frame_commit_timeout" };
    }
    const stateAfterDrain = recordingFrameSyncAvailability(session);
    if (stateAfterDrain) return stateAfterDrain;
    if ((await waitForFrameTaskWithinBudget(queueFrame(session), deadlineMs)) === "timeout") {
      return { status: "degraded", reason: "frame_commit_timeout" };
    }
  } catch {
    return {
      status: "degraded",
      reason: session.encoderError ? "encoder_error" : "frame_capture_failed",
    };
  }

  const committed = session.actionLandmarks.latestCommittedFrame();
  if (!committed || committed.frameIndex === previous?.frameIndex) {
    return {
      status: "degraded",
      reason: session.encoderError ? "encoder_error" : "frame_capture_failed",
    };
  }
  return { status: "committed", landmark: committed };
}

function readinessFrameSyncReason(
  reason: RecordingReadinessReason | null,
): Extract<FrameSyncOutcome, { status: "degraded" }>["reason"] {
  if (reason === "encoder_error") return "encoder_error";
  if (reason === "frame_commit_timeout") return "frame_commit_timeout";
  if (reason === "recording_cancelled") return "capture_inactive";
  return "frame_capture_failed";
}

function recordingFrameSyncAvailability(session: RecordingSession): FrameSyncOutcome | null {
  if (
    recordingSessions.get(session.id) !== session ||
    session.lifecycle === "stopping" ||
    session.lifecycle === "finalized"
  ) {
    return { status: "cancelled" };
  }
  if (session.paused || session.lifecycle === "paused") {
    return { status: "degraded", reason: "capture_paused" };
  }
  if (session.lifecycle !== "recording") {
    return { status: "degraded", reason: "capture_inactive" };
  }
  if (session.encoderError) return { status: "degraded", reason: "encoder_error" };
  return null;
}

export async function captureAutomationRecordingTail(session: RecordingSession): Promise<void> {
  for (const delayMs of recordingTailFrameDelaysMs()) {
    if (recordingSessions.get(session.id) !== session) return;
    if (session.captureInFlight) await session.captureInFlight;
    if (delayMs > 0) await waitMs(delayMs);
    if (recordingSessions.get(session.id) !== session) return;
    await queueRecordingFrame(session);
  }
}

export async function ensureRecordingFramesCoverElapsedTime(
  session: RecordingSession,
  elapsedMs = Date.now() - session.startedAt,
): Promise<void> {
  const elapsedFrameCount = recordingFrameCountForElapsedMs(elapsedMs, session.effectiveFps);
  const maxPaddingFrameCount = recordingFrameCountForElapsedMs(
    AUTOMATION_RECORDING_MAX_PADDING_MS,
    session.effectiveFps,
  );
  const targetFrameCount = Math.min(elapsedFrameCount, session.frameSeq + maxPaddingFrameCount);
  const maxAttempts = Math.max(0, targetFrameCount - session.frameSeq) + 3;
  let attempts = 0;
  let stalledAttempts = 0;
  while (
    recordingSessions.get(session.id) === session &&
    session.frameSeq < targetFrameCount &&
    attempts < maxAttempts &&
    stalledAttempts < 3
  ) {
    attempts += 1;
    if (session.captureInFlight) await session.captureInFlight;
    if (recordingSessions.get(session.id) !== session) return;
    const frameCountBefore = session.frameSeq;
    await queueRecordingFrame(session);
    if (session.frameSeq <= frameCountBefore) {
      stalledAttempts += 1;
    } else {
      stalledAttempts = 0;
    }
  }
}

export async function captureAuthorPreviewNativeImage(
  streamId: string,
  width: number,
  height: number,
): Promise<NativeImage> {
  const preview = authorSession(streamId);
  const image = preview.latestPaintImage ?? (await preview.window.webContents.capturePage());
  if (image.isEmpty()) {
    throw new Error(`author preview ${streamId} captured empty frame`);
  }
  const size = image.getSize();
  if (size.width === width && size.height === height) return image;
  return image.resize({
    width: Math.max(1, width),
    height: Math.max(1, height),
    quality: "best",
  });
}

export async function captureRecordingNativeImage(session: RecordingSession): Promise<NativeImage> {
  if (session.target.kind === "author_preview") {
    const preview = authorSession(session.target.stream_id);
    const image = await captureAuthorPreviewNativeImage(
      session.target.stream_id,
      session.width,
      session.height,
    );
    if (!session.loggedAuthorPreviewFrame) {
      const size = image.getSize();
      session.loggedAuthorPreviewFrame = true;
      void hostLog("info", "author_preview_recording_frame", {
        stream_id: session.target.stream_id,
        frame_width: size.width,
        frame_height: size.height,
        session_width: session.width,
        session_height: session.height,
        latest_paint_age_ms:
          preview.latestPaintAt == null
            ? "none"
            : String(Math.max(0, Date.now() - preview.latestPaintAt)),
      });
    }
    return image;
  }
  if (session.captureBackend?.target_loss_reason && captureBackendContractEnforced(session)) {
    throw new CaptureBackendContractError(
      "delivery_after_terminal",
      "capture target already terminated",
    );
  }
  try {
    return await captureTargetNativeImage(session.target, session.width, session.height);
  } catch (error) {
    await markRecordingCaptureTargetLost(session, error);
    throw error;
  }
}

export function clampDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  const rounded = Math.round(numeric);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export function clampFps(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30;
  return Math.min(120, Math.max(1, Math.round(numeric)));
}

export function positiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function effectivePreviewFps(value: unknown): number {
  return Math.min(60, clampFps(value));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function recordingSettleDelayMs(command: ParsedCommand): number {
  switch (command.verb) {
    case "navigate":
      return 250;
    case "click":
    case "select":
    case "upload":
      return 120;
    case "type":
      return 180;
    case "scroll":
      return 160;
    case "hover":
      return 80;
    default:
      return 0;
  }
}

export function storyBrowserExecutionProfile(options?: {
  captureRecordingFrames?: boolean;
  captureSize?: CursorTimingSize;
  includeCursor?: boolean;
}): StoryBrowserExecutionProfile {
  return {
    typingMode: "incremental",
    captureRecordingFrames: options?.captureRecordingFrames ?? false,
    captureSize: options?.captureSize,
    cursorMotionPreset: HOST_CURSOR_DEFAULT_MOTION_PRESET,
    minCursorLeadMs: HOST_CURSOR_DEFAULT_MIN_LEAD_MS,
    injectCursorPath: options?.includeCursor ?? true,
    targetStabilityThresholdPx: HOST_CURSOR_TARGET_STABILITY_THRESHOLD_PX,
    settleDelayForCommand: recordingSettleDelayMs,
  };
}

export function ffmpegCropPlan(
  crop: FrameCropRect | null,
  frameWidth: number,
  frameHeight: number,
): {
  filter: string;
  width: number;
  height: number;
} | null {
  if (!crop || crop.w <= 0 || crop.h <= 0) return null;
  const basisW = crop.basis_w && crop.basis_w > 0 ? crop.basis_w : frameWidth;
  const basisH = crop.basis_h && crop.basis_h > 0 ? crop.basis_h : frameHeight;
  const scaleX = frameWidth / basisW;
  const scaleY = frameHeight / basisH;
  const x = Math.max(0, Math.round(crop.x * scaleX));
  const y = Math.max(0, Math.round(crop.y * scaleY));
  const width = Math.max(1, Math.round(crop.w * scaleX));
  const height = Math.max(1, Math.round(crop.h * scaleY));
  if (x >= frameWidth || y >= frameHeight) return null;
  const availableWidth = frameWidth - x;
  const availableHeight = frameHeight - y;
  if (availableWidth < 2 || availableHeight < 2) return null;
  const clampedWidth = Math.max(2, Math.floor(Math.min(width, availableWidth) / 2) * 2);
  const clampedHeight = Math.max(2, Math.floor(Math.min(height, availableHeight) / 2) * 2);
  if (clampedWidth <= 0 || clampedHeight <= 0) return null;
  return {
    filter: `crop=${clampedWidth}:${clampedHeight}:${x}:${y}`,
    width: clampedWidth,
    height: clampedHeight,
  };
}

export function emitEvent(event: string, payload: unknown): void {
  for (const listener of eventListeners.values()) {
    if (listener.event !== event || listener.sender.isDestroyed()) continue;
    sendCallback(listener.sender, listener.handlerId, {
      event,
      id: listener.eventId,
      payload,
    });
  }
}

export function navPayload(session: AuthorPreviewSession) {
  const contents = session.window.webContents;
  return {
    streamId: session.id,
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  };
}

export function emitAuthorNav(session: AuthorPreviewSession): void {
  emitEvent(session.navEvent, navPayload(session));
}

export function invalidateAuthorPreviewPaint(session: AuthorPreviewSession): void {
  session.latestPaintImage = null;
  session.latestPaintAt = null;
}

export function invalidateAuthorPreviewPaintForContents(contents: WebContents): void {
  for (const session of authorPreviewSessions.values()) {
    if (!session.window.isDestroyed() && session.window.webContents.id === contents.id) {
      invalidateAuthorPreviewPaint(session);
    }
  }
}

export function previewFramePayload(session: AuthorPreviewSession, image: NativeImage) {
  const { width: frameWidth, height: frameHeight } = image.getSize();
  return {
    data: image.toJPEG(75).toString("base64"),
    width: frameWidth,
    height: frameHeight,
    timestamp: Date.now(),
    streamId: session.id,
    format: "jpeg",
    mimeType: "image/jpeg",
    sharp: false,
  };
}

export function emitPreviewFrame(session: AuthorPreviewSession, image: NativeImage): void {
  const payload = previewFramePayload(session, image);
  emitEvent(session.frameEvent, payload);
  if (globalPreviewStreamSessionId === session.id) {
    emitEvent("preview://frame", payload);
  }
}

export function authorSession(streamId: string): AuthorPreviewSession {
  const session = authorPreviewSessions.get(streamId);
  if (!session || session.window.isDestroyed())
    throw new Error(`author preview ${streamId} not found`);
  return session;
}

export async function stopAuthorPreviewSession(streamId: string): Promise<void> {
  const session = authorPreviewSessions.get(streamId);
  if (!session) return;
  authorPreviewSessions.delete(streamId);
  if (globalPreviewStreamSessionId === streamId) globalPreviewStreamSessionId = null;
  void hostLog("info", "stop_author_preview", {
    stream_id: streamId,
    browser_window_id: session.window.id,
    was_destroyed: session.window.isDestroyed(),
  });
  if (!session.window.isDestroyed()) session.window.destroy();
}

export async function stopAuthorPreviewsByPurpose(
  purpose: AuthorPreviewSession["purpose"],
): Promise<void> {
  const ids = [...authorPreviewSessions.values()]
    .filter((session) => session.purpose === purpose)
    .map((session) => session.id);
  await Promise.all(ids.map((id) => stopAuthorPreviewSession(id)));
}

export async function startAuthorPreviewSession(
  args: Record<string, unknown>,
  sender: WebContents,
): Promise<string> {
  const id = `author-${randomUUID()}`;
  const width = clampDimension(args.viewportWidth, 1280);
  const height = clampDimension(args.viewportHeight, 800);
  const purpose = args.purpose === "recording" ? "recording" : "editor";
  const frameRate = purpose === "recording" ? effectivePreviewFps(args.fps) : 30;
  const rawPartition = typeof args.partition === "string" ? args.partition.trim() : "";
  if (rawPartition.startsWith("persist:")) {
    throw new Error("Author preview partition must be non-persistent");
  }
  const partition = rawPartition.length > 0 ? rawPartition : undefined;
  if (purpose === "recording" && !partition) {
    throw new Error("Recording author preview requires an isolated non-persistent partition");
  }
  if (purpose === "editor" && partition) {
    throw new Error("Editor author preview cannot use a recording partition");
  }
  const replaceExisting = purpose === "editor" ? args.replaceExisting !== false : false;
  if (replaceExisting) await stopAuthorPreviewsByPurpose("editor");
  const visible = purpose === "recording" ? args.visible !== false : args.visible === true;
  const previewX = args.previewX;
  const previewY = args.previewY;
  const previewBounds =
    visible &&
    typeof previewX === "number" &&
    typeof previewY === "number" &&
    Number.isFinite(previewX) &&
    Number.isFinite(previewY)
      ? { x: Math.round(previewX), y: Math.round(previewY) }
      : {};
  const offscreen = !visible;
  const preview = new BrowserWindow({
    show: visible,
    width,
    height,
    ...previewBounds,
    webPreferences: {
      ...(partition ? { partition } : {}),
      offscreen,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const session: AuthorPreviewSession = {
    id,
    window: preview,
    sender,
    frameEvent: `preview://frame/${id}`,
    navEvent: `preview://nav/${id}`,
    paused: false,
    latestPaintImage: null,
    latestPaintAt: null,
    frameRate,
    purpose,
  };
  authorPreviewSessions.set(id, session);

  preview.webContents.setFrameRate(frameRate);
  preview.webContents.on("paint", (_event, _dirty, image) => {
    if (session.paused || preview.isDestroyed()) return;
    session.latestPaintImage = image;
    session.latestPaintAt = Date.now();
    if (session.purpose !== "recording") {
      emitPreviewFrame(session, image);
    }
  });
  const emitNav = () => emitAuthorNav(session);
  preview.webContents.on("did-start-navigation", () => {
    invalidateAuthorPreviewPaint(session);
  });
  preview.webContents.on("did-navigate", emitNav);
  preview.webContents.on("did-navigate-in-page", emitNav);
  preview.webContents.on("did-finish-load", emitNav);
  preview.on("closed", () => {
    authorPreviewSessions.delete(id);
  });

  const initialUrl =
    typeof args.initialUrl === "string" && args.initialUrl.length > 0
      ? args.initialUrl
      : "about:blank";
  try {
    await loadAuthorPreviewUrl(preview, initialUrl, purpose === "recording" ? 8_000 : 30_000);
  } catch (error) {
    authorPreviewSessions.delete(id);
    if (!preview.isDestroyed()) preview.destroy();
    throw error;
  }
  emitAuthorNav(session);
  void hostLog("info", "start_author_preview", {
    stream_id: id,
    initial_url: initialUrl,
    viewport_width: width,
    viewport_height: height,
    show: preview.isVisible(),
    offscreen,
    requested_fps: purpose === "recording" ? positiveNumber(args.fps, frameRate) : null,
    effective_fps: frameRate,
    replace_existing: replaceExisting,
    purpose,
    partition: partition ?? null,
    preview_x: "x" in previewBounds ? previewBounds.x : null,
    preview_y: "y" in previewBounds ? previewBounds.y : null,
    browser_window_id: preview.id,
    media_source_id: preview.getMediaSourceId(),
  });
  return id;
}

export async function loadAuthorPreviewUrl(
  preview: BrowserWindow,
  initialUrl: string,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      preview.loadURL(initialUrl),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Timed out loading author preview URL"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startPreviewStream(): Promise<null> {
  const session = [...authorPreviewSessions.values()].find(
    (candidate) => candidate.purpose === "editor" && !candidate.window.isDestroyed(),
  );
  if (!session) {
    throw new Error("UnavailableOnBackend: no active Electron author preview session");
  }
  globalPreviewStreamSessionId = session.id;
  const image = await session.window.webContents.capturePage();
  if (!image.isEmpty()) {
    emitEvent("preview://frame", previewFramePayload(session, image));
  }
  return null;
}

export function stopPreviewStream(): null {
  globalPreviewStreamSessionId = null;
  return null;
}

export function authorMouseButton(button: unknown): "left" | "right" | "middle" {
  return button === "right" || button === "middle" ? button : "left";
}

export function dispatchAuthorInput(streamId: string, event: Record<string, unknown>): void {
  const session = authorSession(streamId);
  const contents = session.window.webContents;
  const x = Number(event.x ?? 0);
  const y = Number(event.y ?? 0);
  switch (event.type) {
    case "mousemove":
      contents.sendInputEvent({ type: "mouseMove", x, y });
      break;
    case "click": {
      const button = authorMouseButton(event.button);
      contents.sendInputEvent({
        type: "mouseDown",
        x,
        y,
        button,
        clickCount: 1,
      });
      contents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
      break;
    }
    case "wheel":
      contents.sendInputEvent({
        type: "mouseWheel",
        x,
        y,
        deltaX: Number(event.deltaX ?? 0),
        deltaY: Number(event.deltaY ?? 0),
      });
      break;
    case "keydown":
      contents.sendInputEvent({
        type: "keyDown",
        keyCode: String(event.key ?? ""),
      });
      break;
    case "keyup":
      contents.sendInputEvent({
        type: "keyUp",
        keyCode: String(event.key ?? ""),
      });
      break;
    case "text":
      contents.sendInputEvent({
        type: "char",
        keyCode: String(event.text ?? ""),
      });
      break;
  }
}

export function pickerScript(timeoutMs: number): string {
  return `
    new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('scroll', onViewportChange, true);
        window.removeEventListener('resize', onViewportChange);
        if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
        if (hovered) hovered.style.outline = previousOutline || '';
        delete window.__storycaptureCancelPicker;
      };
      let hovered = null;
      let previousOutline = '';
      let lastPointerX = null;
      let lastPointerY = null;
      let refreshFrame = null;
      const cssPath = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
          let part = node.localName;
          if (!part) break;
          const parent = node.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter((s) => s.localName === node.localName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.localName;
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.href) return 'link';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'img') return 'image';
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        return null;
      };
      const labelFor = (el) => {
        if (el.labels && el.labels[0]) return el.labels[0].innerText.trim();
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (label) return label.innerText.trim();
        }
        return null;
      };
      const unique = (candidate) => {
        try {
          if (candidate.kind === 'selector') return document.querySelectorAll(candidate.value).length === 1;
          if (candidate.kind === 'testid') return document.querySelectorAll('[data-testid="' + CSS.escape(candidate.value) + '"]').length === 1;
          if (candidate.kind === 'aria') return document.querySelectorAll('[aria-label="' + CSS.escape(candidate.value) + '"]').length === 1;
        } catch {}
        return false;
      };
      const scrollabilityFor = (el) => {
        let node = el;
        let own = false;
        let ancestor = false;
        while (node instanceof Element) {
          const style = getComputedStyle(node);
          const scrollable =
            (["auto", "scroll", "overlay"].includes(style.overflowX) && node.scrollWidth > node.clientWidth) ||
            (["auto", "scroll", "overlay"].includes(style.overflowY) && node.scrollHeight > node.clientHeight);
          if (scrollable) {
            if (node === el) own = true;
            else ancestor = true;
            break;
          }
          node = node.parentElement;
        }
        return { own, ancestor };
      };
      const candidatesFor = (el) => {
        const out = [];
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        const aria = el.getAttribute('aria-label');
        const label = labelFor(el);
        const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
        const role = roleOf(el);
        const selector = cssPath(el);
        if (testId) out.push({ kind: 'testid', value: testId, score: 100, unique: true });
        if (role && (aria || text)) out.push({ kind: 'role', value: { role, name: aria || text }, score: 90, unique: false });
        if (label) out.push({ kind: 'label', value: label, score: 80, unique: false });
        if (aria) out.push({ kind: 'aria', value: aria, score: 75, unique: unique({ kind: 'aria', value: aria }) });
        if (text) out.push({ kind: 'text_exact', value: text, score: 60, unique: false });
        if (selector) out.push({ kind: 'selector', value: selector, score: 40, unique: unique({ kind: 'selector', value: selector }) });
        return out;
      };
      const emittedLine = (locator) => {
        if (locator.kind === 'role' && locator.value) return 'click <' + locator.value.role + '> "' + locator.value.name.replaceAll('"', '\\\\"') + '"';
        if (typeof locator.value === 'string') return 'click ' + locator.kind + ' "' + locator.value.replaceAll('"', '\\\\"') + '"';
        return 'click';
      };
      const finish = (result) => {
        cleanup();
        resolve(result);
      };
      const setHovered = (el) => {
        if (hovered === el || !(el instanceof Element)) return;
        if (hovered) hovered.style.outline = previousOutline || '';
        hovered = el;
        previousOutline = hovered.style.outline;
        hovered.style.outline = '2px solid #39ff88';
      };
      const refreshHovered = () => {
        refreshFrame = null;
        if (lastPointerX === null || lastPointerY === null) return;
        setHovered(document.elementFromPoint(lastPointerX, lastPointerY));
      };
      const onViewportChange = () => {
        if (refreshFrame === null) refreshFrame = requestAnimationFrame(refreshHovered);
      };
      const onMove = (event) => {
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        setHovered(event.target);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish({ cancelled: true, reason: 'user-cancel' });
        }
      };
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const el = event.target;
        if (!(el instanceof Element)) {
          finish({ cancelled: true, reason: 'no-element' });
          return;
        }
        const candidates = candidatesFor(el);
        const scrollability = scrollabilityFor(el);
        const locator = candidates[0] || { kind: 'selector', value: cssPath(el) || 'body', score: 1, unique: false };
        finish({
          emitted: emittedLine(locator),
          locator: { kind: locator.kind, value: locator.value, nth: locator.nth },
          candidates,
          element: {
            tagName: el.tagName.toLowerCase(),
            role: roleOf(el),
            accessibleName: el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim().slice(0, 120),
            inputType: el.getAttribute('type') || undefined,
            isContentEditable: el.isContentEditable,
            isTextInput: ['input', 'textarea'].includes(el.localName),
            isSelect: el.localName === 'select',
            isFileInput: el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file',
            isScrollable: scrollability.own,
            hasScrollableAncestor: scrollability.ancestor,
            optionLabels: el.localName === 'select' ? [...el.options].map((o) => o.label || o.text) : undefined,
          },
        });
      };
      const timer = setTimeout(() => finish({ cancelled: true, reason: 'timeout' }), ${Math.max(1, timeoutMs)});
      window.__storycaptureCancelPicker = (reason = 'user-cancel') => finish({ cancelled: true, reason });
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
      window.addEventListener('resize', onViewportChange, { passive: true });
    })
  `;
}

export async function pickerStartAuthor(raw: Record<string, unknown>): Promise<{ json: string }> {
  const streamId = String(raw.streamId ?? "");
  const session = authorSession(streamId);
  const timeoutMs = Number(raw.timeoutMs ?? 60_000);
  activePickerStreams.add(streamId);
  try {
    const result = (await session.window.webContents.executeJavaScript(
      pickerScript(timeoutMs),
      true,
    )) as PickResult;
    return { json: JSON.stringify(result) };
  } finally {
    activePickerStreams.delete(streamId);
  }
}

export async function pickerCancel(): Promise<void> {
  await Promise.all(
    [...activePickerStreams].map(async (streamId) => {
      try {
        await authorSession(streamId).window.webContents.executeJavaScript(
          "window.__storycaptureCancelPicker?.('user-cancel')",
          true,
        );
      } catch {
        // Session may have ended between cancel request and script dispatch.
      }
    }),
  );
  activePickerStreams.clear();
}

export function targetsPathFor(storyPath: string): string {
  return `${storyPath}.targets.json`;
}

export function normalizedTargetRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  const target = record as { kind?: string; value?: unknown; nth?: unknown };
  const out: Record<string, unknown> = {
    kind: target.kind,
    value: target.value,
  };
  if (target.nth != null) out.nth = target.nth;
  return out;
}

export async function pickerStampStepId(raw: Record<string, unknown>) {
  const storyPath = String(raw.storyPath ?? "");
  const lineOffset = Number(raw.lineOffset ?? 0);
  if (!storyPath || storyPath.split(/[\\/]/).includes("..")) {
    throw new Error("path traversal rejected: storyPath");
  }
  if (!Number.isInteger(lineOffset) || lineOffset <= 0) {
    throw new Error("lineOffset must be a positive integer");
  }
  const source = await fs.readFile(storyPath, "utf8");
  const parsed = parseStorySource(source);
  const ast = parsed.ast as {
    scenes?: Array<{ commands?: ParsedCommand[] }>;
  } | null;
  const lineHasCommand = Boolean(
    ast?.scenes?.some((scene) =>
      scene.commands?.some((command) => command.span.line === lineOffset),
    ),
  );
  if (!lineHasCommand) throw new Error(`no command found at line ${lineOffset}`);

  const lines = source.split(/\r?\n/);
  const idx = lineOffset - 1;
  const line = lines[idx] ?? "";
  const existing = line.match(/#\s*@id=([0-9a-fA-F-]{36})/);
  const stepId = existing?.[1] ?? randomUUID();
  const wasFreshlyStamped = !existing;
  if (wasFreshlyStamped) {
    lines[idx] = `${line} # @id=${stepId}`;
    await fs.writeFile(storyPath, lines.join("\n"), "utf8");
  }

  const targetsPath = targetsPathFor(storyPath);
  const targets = await readJson<{
    version: number;
    steps: Record<string, unknown>;
  }>(targetsPath, {
    version: 1,
    steps: {},
  });
  targets.version = 1;
  targets.steps = targets.steps ?? {};
  targets.steps[stepId] = {
    primary: normalizedTargetRecord(raw.primary),
    fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks.map(normalizedTargetRecord) : [],
  };
  const tempPath = `${targetsPath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, JSON.stringify(targets, null, 2), "utf8");
  await fs.rename(tempPath, targetsPath);
  return { step_id: stepId, was_freshly_stamped: wasFreshlyStamped };
}

export async function startRecording(raw: unknown, onEvent: unknown, sender: WebContents) {
  const args = raw as {
    project_folder?: string;
    target?: CaptureTarget;
    width?: number;
    height?: number;
    fps?: number;
    audio_device_id?: string | null;
    audio_capture_id?: string | null;
    audio_unavailable_reason?: string | null;
    audio_tracks?: RecordingAudioTrackRequest[] | null;
    include_cursor?: boolean | null;
    frame_crop?: FrameCropRect | null;
    output_resolution?: RecordingOutputResolution | null;
    fit_mode?: RecordingFitMode | null;
    pad_color?: RecordingPadColor | null;
    quality_preset?: RecordingQualityPreset | null;
    scale_algo?: RecordingScaleAlgo | null;
  };
  if (!args.project_folder) throw new Error("project_folder required");
  const id = randomUUID();
  const eventChannelId = channelIdFrom(onEvent);
  const fps = clampFps(args.fps);
  const requestedFps = positiveNumber(args.fps, fps);
  const includeCursor = resolveRecordingIncludeCursor(args.include_cursor);
  const readinessMode = recordingReadinessMode();
  const target = args.target ?? defaultCaptureTarget();
  const audioRequests = recordingAudioRequests(args.audio_tracks, {
    sessionId: id,
    target,
    audioDeviceId: args.audio_device_id,
    audioCaptureId: args.audio_capture_id,
  });
  const microphoneRequest = audioRequests.find((request) => request.role === "microphone");
  const tabRequest = audioRequests.find((request) => request.role === "tab");
  const audioMode = recordingAudioMode();
  const compatibilityRequest =
    microphoneRequest ?? (audioMode === "multitrack_shadow" ? undefined : tabRequest);
  const compatibilityAudioRequested =
    Boolean(args.audio_device_id) ||
    Boolean(compatibilityRequest && audioMode !== "multitrack_shadow");
  const width = clampDimension(args.width, 1280);
  const height = clampDimension(args.height, 720);
  const output = resolveRecordingOutput(width, height, {
    outputResolution: args.output_resolution,
    fitMode: args.fit_mode,
    padColor: args.pad_color,
    qualityPreset: args.quality_preset,
    scaleAlgo: args.scale_algo,
  });
  const captureBackend = await electronCaptureProvenance({
    target,
    width,
    height,
    fps,
    includeCursor,
  });
  const captureBackendDelivery =
    target.kind !== "author_preview" && captureBackend.mode !== "legacy"
      ? new CaptureBackendDeliveryGuard(
          {
            backend_id: captureBackend.selected_backend_id,
            session_id: id,
            ownership_token: id,
          },
          { deliver: async () => "accepted" },
        )
      : null;
  const framesDir = path.join(os.tmpdir(), "storycapture-electron-recordings", id);
  await fs.mkdir(framesDir, { recursive: true });
  const exportsDir = path.join(args.project_folder, EXPORTS_DIRNAME);
  await fs.mkdir(exportsDir, {
    recursive: true,
  });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const bundleWriter =
    recordingBundleMode() === "off"
      ? null
      : await RecordingBundleWriter.allocate(id, args.project_folder);
  const outputPath =
    bundleWriter?.allocation.stagingVideoPath ?? path.join(exportsDir, `recording-${stamp}.mp4`);
  if (bundleWriter) {
    await recordingSessionJournal.createForBundle(bundleWriter.allocation, {
      target_kind: target.kind,
      width,
      height,
      output_width: output.outputWidth,
      output_height: output.outputHeight,
      requested_fps: requestedFps,
    });
  }
  let heartbeatSeq = 0;
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1;
    sendChannel(sender, eventChannelId, {
      type: "heartbeat",
      seq: heartbeatSeq,
    });
  }, 2000);
  heartbeat.unref?.();
  const session: RecordingSession & { includeCursor: boolean } = {
    id,
    projectFolder: args.project_folder,
    outputPath,
    target,
    width,
    height,
    outputWidth: output.outputWidth,
    outputHeight: output.outputHeight,
    fps,
    startedAt: Date.now(),
    paused: false,
    lifecycle: "recording",
    mediaClock: new RecordingMediaClock({ fpsNum: fps, fpsDen: 1 }),
    actionLandmarks: new RecordingActionLandmarkRecorder(),
    paintSequence: 0,
    pauseGate: new RecordingPauseGate(),
    eventTarget: sender,
    eventChannelId,
    heartbeat,
    captureTimer: null,
    framesDir,
    frameSeq: 0,
    framesDropped: 0,
    skippedTicks: 0,
    encoderBackpressureEvents: 0,
    sourceFramesReceived: 0,
    captureInFlight: null,
    audioPath: null,
    captureBackend,
    captureBackendDelivery,
    captureBackendDeliverySequence: 0,
    captureBackendFrameIndex: 0,
    captureBackendLastPtsUs: null,
    frameCrop: args.frame_crop ?? null,
    loggedAuthorPreviewFrame: false,
    requestedFps,
    effectiveFps: fps,
    lateFrames: 0,
    captureDurationMs: [],
    streaming: recordingUsesLiveVideoSink({
      mode: recordingAvMode(),
      targetKind: target.kind,
      audioRequested: compatibilityAudioRequested,
      readinessEnforced: readinessMode === "enforce",
    }),
    ffmpegProcess: null,
    ffmpegDone: null,
    encoderBackpressured: false,
    encoderError: null,
    latestAuthorPreviewImage: null,
    authorPaintHandler: null,
    fitMode: output.fitMode,
    padColor: output.padColor,
    qualityPreset: output.qualityPreset,
    scaleAlgo: output.scaleAlgo,
    includeCursor,
  };
  if (bundleWriter && recordingCheckpointMode() === "shadow") {
    registerRecordingCheckpoints({
      sessionId: id,
      segmentsDir: bundleWriter.allocation.segmentsDir,
      width,
      height,
      fps,
    });
  }
  const avRuntime = recordingAvSessions.register({
    sessionId: id,
    audioRequested: compatibilityAudioRequested,
    audioCaptureId: compatibilityRequest?.capture_token ?? args.audio_capture_id,
    videoOutputPath: outputPath,
    registeredMonotonicEpochMs: monotonicEpochMilliseconds(
      performance.timeOrigin,
      performance.now(),
    ),
  });
  if (recordingAudioMode() !== "legacy") {
    recordingAudioTracks.register({
      sessionId: id,
      targetKind: target.kind,
      originMonotonicEpochMs: avRuntime.registeredMonotonicEpochMs,
      requests: audioRequests,
    });
  }
  if (args.audio_unavailable_reason) {
    avRuntime.assertAudioCaptureId(microphoneRequest?.capture_token ?? `unavailable-${id}`);
    avRuntime.audio.abort({
      sequence: 0,
      monotonicEpochMs: avRuntime.registeredMonotonicEpochMs,
      reason: "audio_stream_aborted",
    });
    avRuntime.markAudioTerminal();
    if (microphoneRequest) {
      recordingAudioTracks.fail(
        {
          session_id: id,
          track_id: microphoneRequest.track_id,
          role: microphoneRequest.role,
          source_id: microphoneRequest.source_id,
          capture_token: microphoneRequest.capture_token,
        },
        { sequence: 0, reason: args.audio_unavailable_reason },
      );
    }
  }
  if (tabRequest && target.kind === "author_preview") {
    installAuthorPreviewTabAudioHandler(sender);
    const preview = authorSession(target.stream_id);
    authorPreviewTabGrants.arm({
      sessionId: id,
      trackId: tabRequest.track_id,
      captureToken: tabRequest.capture_token,
      requester: sender.mainFrame,
      source: preview.window.webContents.mainFrame,
    });
  }
  await recordingLifecycle.register(session);
  void recordEngineLog({
    event: "recording.backend.probed",
    context: {
      session_id: id,
      backend_id: captureBackend.attempted_backend_id ?? undefined,
      reason_code: captureBackend.fallback_reason ?? undefined,
      phase: "capture_setup",
    },
    details: {
      selected_backend_id: captureBackend.selected_backend_id,
      supported: captureBackend.fallback_reason === null,
      delivery_mode: captureBackend.delivery_mode,
      target_kind: target.kind,
    },
  });
  void recordEngineLog({
    event:
      captureBackend.fallback_reason === null
        ? "recording.backend.selected"
        : "recording.backend.fallback",
    context: {
      session_id: id,
      backend_id: captureBackend.selected_backend_id,
      reason_code: captureBackend.fallback_reason ?? undefined,
      phase: "capture_setup",
    },
    details: {
      attempted_backend_id: captureBackend.attempted_backend_id,
      selected_backend_id: captureBackend.selected_backend_id,
      delivery_mode: captureBackend.delivery_mode,
      mode: captureBackend.mode,
      target_kind: target.kind,
    },
  });
  if (engineHealthMode() !== "off") engineHealth.register(id);
  const health =
    recordingHealthMode() === "off"
      ? null
      : recordingHealth.register({
          sessionId: id,
          capturePath: session.streaming ? "raw_bgra" : "png",
          outputWidth: session.outputWidth,
          outputHeight: session.outputHeight,
          requestedFps: session.effectiveFps,
          startedAtMs: session.startedAt,
          onUpdate: (update) => {
            sendChannel(sender, eventChannelId, { type: "health-update", update });
            void publishEngineHealthBestEffort(session, update);
          },
        });
  session.actionLandmarks.onPresentation((observation) => {
    health?.recordActionPresentation(
      observation.input,
      observation.presentation.firstPostInputFrame,
    );
  });
  const readiness = recordingReadiness.register({
    sessionId: id,
    mode: readinessMode,
    sinkAcknowledgements: session.streaming,
    onObservation: (result) => {
      void recordEngineLog({
        level: result.status === "failed" ? "warn" : "info",
        event: "recording.readiness.completed",
        context: {
          session_id: id,
          request_id: result.request_id,
          phase: result.barrier,
          reason_code: result.reason ?? undefined,
          duration_ms: result.active_wait_ms,
        },
        details: {
          status: result.status,
          requested_media_us: result.requested_media_us,
          committed_pts_us: result.committed_landmark?.ptsUs ?? null,
          attempts: result.attempts,
        },
      });
      void hostLog("info", "recording_readiness_observation", { ...result });
      if (result.barrier === "first_frame_committed") {
        health?.recordFirstFrameBarrier(result.status);
      }
      if (
        bundleWriter &&
        result.barrier === "first_frame_committed" &&
        result.status === "committed"
      ) {
        void recordingSessionJournal.checkpoint(id, "first_encoded_frame").catch((error) => {
          void hostLog("warn", "recording_readiness_journal_checkpoint_failed", {
            session_id: id,
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        });
      }
    },
  });
  try {
    if (session.streaming) {
      await startAuthorPreviewRecordingStream(session);
      session.captureTimer = setInterval(
        () => {
          scheduleRecordingFrame(session);
        },
        Math.max(1000 / fps, 16),
      );
      session.captureTimer.unref?.();
    } else {
      session.captureTimer = setInterval(
        () => {
          scheduleRecordingFrame(session);
        },
        Math.max(1000 / fps, 16),
      );
      session.captureTimer.unref?.();
      await captureRecordingFrame(session);
    }
    await readiness.require({ barrier: "source_ready", budgetMs: 5_000 });
    const firstFrame = await readiness.require({
      barrier: "first_frame_committed",
      budgetMs: 5_000,
      requestedMediaUs: session.mediaClock.snapshot().nextPtsUs,
      queueFrame: () => queueRecordingFrame(session),
    });
    if (readiness.mode !== "observe") health?.recordFirstFrameBarrier(firstFrame.status);
    await recordingLifecycle.markRecording(id);
    if (bundleWriter) {
      await recordingSessionJournal.checkpoint(id, "capture_started");
      if (firstFrame.status === "committed") {
        await recordingSessionJournal.checkpoint(id, "first_encoded_frame");
      }
    }
  } catch (error) {
    if (session.captureTimer) clearInterval(session.captureTimer);
    clearInterval(heartbeat);
    session.ffmpegProcess?.kill("SIGKILL");
    await fs.rm(framesDir, { recursive: true, force: true });
    recordingReadiness.remove(id);
    recordingHealth.remove(id);
    engineHealth.remove(id);
    recordingAvSessions.remove(id);
    authorPreviewTabGrants.revoke(id);
    recordingAudioTracks.remove(id);
    await disposeRecordingCheckpoints(id);
    await recordingLifecycle.fail(id, "capture_start_failed");
    throw error;
  }
  sendChannel(sender, eventChannelId, {
    type: "capture-status",
    json: JSON.stringify({ type: "started", session_id: id }),
  });
  if (args.audio_unavailable_reason) {
    sendChannel(sender, eventChannelId, {
      type: "audio-unavailable",
      reason: args.audio_unavailable_reason,
    });
  }
  return { id };
}
