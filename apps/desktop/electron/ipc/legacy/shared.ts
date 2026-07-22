import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { FSWatcher } from "node:fs";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import type { ExportJobStatus } from "@storycapture/shared-types";
import {
  app,
  BrowserWindow,
  type NativeImage,
  type Rectangle,
  screen,
  type WebContents,
} from "electron";
import electronUpdater, { type UpdateInfo as ElectronUpdateInfo } from "electron-updater";
import type {
  FrameSyncOutcome,
  RecordedActionLandmarks,
  RecordingActionLandmarkRecorder,
} from "../action-landmarks";
import type {
  ActionCursorMotionPreset,
  ActionCursorTiming,
  ActionInputTiming,
  ActionPointer,
  ActionScrollTiming,
  ActionTarget,
} from "../action-timeline";
import type { CursorTimingSize } from "../cursor-timing";
import { readJson, writeJson } from "../json-store";
import { type FrontendLogPayload, logFromFrontend } from "../log-store";
import { userDataPath } from "../paths";
import type { RecordingMediaClock } from "../recording-media-clock";
import type { RecordingPauseGate } from "../recording-pause-gate";
import type {
  RecordingFitMode,
  RecordingPadColor,
  RecordingQualityPreset,
  RecordingScaleAlgo,
} from "../recording-pipeline";
import { simulatorTargetGeometryScript } from "../simulator-dom";
import { type ParsedCommand, parseStorySource } from "../story-parser";
import { releaseNotesText } from "../update-store";
import type { ExportOutputReservation } from "./export-output-lifecycle";

export const { autoUpdater } = electronUpdater;

export interface StoreRecord {
  path: string;
  data: Record<string, unknown>;
  dirty: boolean;
}

export interface FsFileResource {
  kind: "file";
  append: boolean;
  handle: NodeFileHandle;
  path: string;
  position: number;
}

export interface FsLineResource {
  kind: "lines";
  encoding: BufferEncoding;
  index: number;
  lines: string[];
}

export interface FsWatcherResource {
  kind: "watcher";
  watchers: FSWatcher[];
}

export type FsResource = FsFileResource | FsLineResource | FsWatcherResource;

export interface ShellProcessResource {
  child: ChildProcessWithoutNullStreams;
}

export interface ProjectRecord {
  id: string;
  name: string;
  folder_path: string;
  created_at: number;
  last_opened_at: number | null;
  thumbnail_path: string | null;
}

export interface TimelineState {
  story_id: string;
  layout_json: string;
  last_modified: number;
}

export interface EffectPreset {
  id: string;
  scope: string;
  name: string;
  description: string;
  ast_json: string;
  version: number;
  bundled: boolean;
  created_at: number;
  author: string | null;
  tags: string[];
}

export interface CreateProjectArgs {
  name: string;
  parent: string;
  workflow_type?: string;
  starter_story_source?: string;
  workflow_state?: WorkflowState;
}

export interface WorkflowState {
  version: number;
  type: string;
  steps: unknown[];
  createdAt: number;
  updatedAt: number;
}

export interface ExportOutput {
  format: string;
  resolution: string;
  output_width?: number | null;
  output_height?: number | null;
  fps: number;
  quality: string;
  encoder_options?: ExportEncoderOptions | null;
}

export interface ExportAudioOptions {
  codec?: "aac" | "opus" | null;
  bitrate_kbps?: number | null;
  channels?: number | null;
  sample_rate_hz?: number | null;
}

export interface ExportEncoderOptions {
  container?: "mp4" | "mov" | "webm" | null;
  codec?: "h264" | null;
  rate_control?: "auto" | "cbr" | "vbr" | "crf" | "cq" | null;
  hw_encoder?:
    | "video-toolbox-h264"
    | "video-toolbox-hevc"
    | "nvenc-h264"
    | "qsv-h264"
    | "amf-h264"
    | "libx264-software"
    | "openh-264-software"
    | null;
  quality_value?: number | null;
  encoder_preset?: string | null;
  resampling_quality?: "high" | "balanced" | "fast" | null;
  /** Backward-read alias for encoder_preset. */
  x264_preset?:
    | "ultrafast"
    | "superfast"
    | "veryfast"
    | "faster"
    | "fast"
    | "medium"
    | "slow"
    | "slower"
    | "veryslow"
    | null;
  keyframe_interval_sec?: number | null;
  /** Backward-read alias for resampling_quality. */
  downscale_algo?: "lanczos" | "bicubic" | "bilinear" | "area" | null;
  audio?: ExportAudioOptions | null;
}

export interface ExportRunArgs {
  story_id: string;
  graph_json: string;
  outputs: ExportOutput[];
  output_folder: string;
  base_name: string;
  preset_id?: string | null;
  priority?: number;
  ai_disclosure?: {
    contains_ai_voiceover: boolean;
    embed_xmp: boolean;
  };
}

export interface SoundLibraryEntry {
  id: string;
  name: string;
  category: string;
  duration_ms: number;
  file_path: string;
  license: string;
  source_url?: string;
  author?: string;
  bundled: boolean;
}

export interface NewRenderJob {
  story_id: string;
  preset_id?: string | null;
  format: string;
  resolution: string;
  fps: number;
  quality: string;
  priority: number;
  batch_id?: string | null;
}

export interface RenderJob extends NewRenderJob {
  id: string;
  output_width: number | null;
  output_height: number | null;
  encoder_options_json: string | null;
  status: ExportJobStatus;
  progress_pct: number;
  phase_progress_pct: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  output_path: string | null;
  recording_mode: import("@storycapture/shared-types/recording-v3").RecordingV3Mode | null;
  created_at: number;
  queue_position?: number | null;
}

export interface RenderProgressListener {
  sender: WebContents;
  channelId: number | null;
}

export interface RenderSession {
  job: RenderJob;
  timer: ReturnType<typeof setInterval> | null;
  frame: number;
  ffmpegProcess: ChildProcess | null;
  cancelCompositedExport: (() => void) | null;
  cancelRequested: boolean;
  outputReservation: ExportOutputReservation | null;
}

export type ProviderId = "anthropic" | "openai" | "elevenlabs" | "openai_tts";

export interface SecretStore {
  version: number;
  keys: Record<string, string>;
}

export interface AudioInputInfo {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rate_hz: number;
}

export type DialogButtonSpec =
  | string
  | { OkCustom?: string }
  | { OkCancelCustom?: [string, string] }
  | { YesNoCancelCustom?: [string, string, string] };

export interface DialogFilterSpec {
  name?: string;
  extensions?: string[];
}

export interface OpenDialogSpec {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  canCreateDirectories?: boolean;
  filters?: DialogFilterSpec[];
}

export interface SaveDialogSpec {
  title?: string;
  defaultPath?: string;
  canCreateDirectories?: boolean;
  filters?: DialogFilterSpec[];
}

export interface VoiceInfoDto {
  id: string;
  name: string;
  locale: string | null;
  premium: boolean;
}

export interface AuthorSnapshotEntry {
  url: string;
  dom_hash: string;
  domHash: string;
  captured_at: string;
  capturedAt: string;
  screenshot_path: string;
  screenshotPath: string;
  html_path: string;
  htmlPath: string;
}

export interface WebAccountInfo {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  connectedAt: string;
}

export interface WebSyncQueueItem {
  id: string;
  desktopId: string;
  workspaceId: string;
  payload: unknown;
  createdAt: string;
}

export interface WebSyncStateFile {
  version: number;
  lastSync: string | null;
}

export interface UploadProgressEvent {
  phase: string;
  partNumber: number;
  totalParts: number;
  bytesUploaded: number;
  totalBytes: number;
}

export interface UploadStatusDto {
  status: string;
  progress: UploadProgressEvent | null;
  videoSlug: string | null;
  error: string | null;
}

export interface PendingOAuthFlow {
  port: number;
  server: Server;
  tokenPromise: Promise<string>;
  resolveToken: (token: string) => void;
  rejectToken: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SimulatorStepFrame {
  ordinal: number;
  screenshot_path: string | null;
  cursor_xy: [number, number];
  matched_selector: string | null;
  matched_bbox: { x: number; y: number; w: number; h: number } | null;
  match_kind: "primary" | "fuzzy" | "none";
  duration_ms: number;
}

export interface LspDocument {
  uri: string;
  text: string;
  version: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export type CaptureTarget =
  | { kind: "display"; display_id: number | string }
  | { kind: "window"; window_id: number | string }
  | { kind: "window_by_pid"; pid: number; title_hint: string | null }
  | { kind: "author_preview"; stream_id: string }
  | {
      kind: "display_region";
      display_id: number | string;
      rect: { x: number; y: number; w: number; h: number };
    };

export interface FrameCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  basis_w?: number | null;
  basis_h?: number | null;
  scale_hint?: number | null;
}

export interface RecordingSession {
  id: string;
  projectFolder: string;
  outputPath: string;
  target: CaptureTarget;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  startedAt: number;
  paused: boolean;
  lifecycle: "recording" | "paused" | "stopping" | "verifying" | "finalized";
  mediaClock: RecordingMediaClock;
  actionLandmarks: RecordingActionLandmarkRecorder;
  paintSequence: number;
  pauseGate: RecordingPauseGate;
  eventTarget: WebContents;
  eventChannelId: number | null;
  heartbeat: ReturnType<typeof setInterval>;
  captureTimer: ReturnType<typeof setInterval> | null;
  framesDir: string;
  frameSeq: number;
  framesDropped: number;
  skippedTicks: number;
  encoderBackpressureEvents: number;
  sourceFramesReceived: number;
  captureInFlight: Promise<void> | null;
  audioPath: string | null;
  frameCrop: FrameCropRect | null;
  requestedFps: number;
  effectiveFps: number;
  lateFrames: number;
  captureDurationMs: number[];
  streaming: boolean;
  ffmpegProcess: ChildProcess | null;
  ffmpegDone: Promise<void> | null;
  encoderBackpressured: boolean;
  encoderError: Error | null;
  latestAuthorPreviewImage: NativeImage | null;
  authorPaintHandler: ((event: unknown, dirty: Rectangle, image: NativeImage) => void) | null;
  fitMode: RecordingFitMode;
  padColor: RecordingPadColor;
  qualityPreset: RecordingQualityPreset;
  scaleAlgo: RecordingScaleAlgo;
}

export interface CaptureStreamSession {
  id: string;
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  startedAt: number;
  sender: WebContents;
  eventChannelId: number | null;
  frameChannelId: number | null;
  timer: ReturnType<typeof setInterval>;
  sequence: number;
  framesDropped: number;
  bytesPeak: number;
  captureInFlight: Promise<void> | null;
}

export interface SimulatorSession {
  id: string;
  sender: WebContents;
  channelId: number | null;
  storyPath: string;
  commands: ParsedCommand[];
  frames: Map<number, SimulatorStepFrame>;
  totalSteps: number;
  cancelled: boolean;
}

export interface DryRunStep {
  id: string;
  verb: string;
  target: string | null;
  value: string | null;
}

export interface DryRunSession {
  id: string;
  sender: WebContents;
  channelId: number | null;
  steps: DryRunStep[];
  index: number;
  passed: number;
  failed: number;
  totalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

export interface EventListener {
  event: string;
  eventId: number;
  handlerId: number;
  sender: WebContents;
}

export interface AuthorPreviewSession {
  id: string;
  window: BrowserWindow;
  sender: WebContents;
  frameEvent: string;
  navEvent: string;
  paused: boolean;
  latestPaintImage: NativeImage | null;
  latestPaintAt: number | null;
  frameRate: number;
  purpose: "editor" | "recording";
}

export interface StoryBrowserRunHooks {
  onStepStarted?: (ordinal: number, command: ParsedCommand) => void;
  onStepSucceeded?: (step: {
    ordinal: number;
    command: ParsedCommand;
    result: ParsedCommandResult;
    durationMs: number;
    actionDurationMs: number;
    timing?: {
      stepStartedAtMs: number;
      actionAtMs: number;
      stepEndedAtMs: number;
      scrollTiming?: ActionScrollTiming | null;
      cursorTiming?: ActionCursorTiming | null;
      inputTiming?: ActionInputTiming | null;
      landmarks?: RecordedActionLandmarks | null;
    };
  }) => void;
  onFrameCaptured?: (ordinal: number, frame: SimulatorStepFrame) => void;
  onStepFailed?: (ordinal: number, error: unknown, screenshotPath?: string | null) => void;
}

export interface StoryBrowserRunOptions {
  contents: WebContents;
  commands: ParsedCommand[];
  projectFolder: string;
  storySource: string;
  targets: {
    version: number;
    steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
  };
  stopAfter?: number;
  frameDir?: string | null;
  failureFrameDir?: string | null;
  executionProfile?: StoryBrowserExecutionProfile;
  recordingSessionId?: string | null;
  recordingClockMs?: () => number;
  actionLandmarks?: RecordingActionLandmarkRecorder;
  requestFrameCommit?: () => Promise<FrameSyncOutcome>;
  requireRecordingReadiness?: (
    state: "source_ready" | "first_frame_committed" | "pre_input_frame_committed",
  ) => Promise<void>;
  frameSyncTimeoutMs?: number;
  captureStateSnapshot?: () => Record<string, unknown>;
  pauseGate?: RecordingPauseGate;
  shouldCancel?: () => boolean;
  hooks?: StoryBrowserRunHooks;
}

export type StoryBrowserTypingMode = "incremental" | "instant";

export interface StoryBrowserExecutionProfile {
  typingMode: StoryBrowserTypingMode;
  captureRecordingFrames: boolean;
  captureSize?: CursorTimingSize;
  cursorMotionPreset?: ActionCursorMotionPreset;
  minCursorLeadMs?: number;
  injectCursorPath?: boolean;
  targetStabilityThresholdPx?: number;
  settleDelayForCommand: (command: ParsedCommand) => number;
}

export type StoryBrowserRunExitReason = "completed" | "paused" | "cancelled" | "failed";

export interface ParsedCommandResult {
  screenshotPath?: string | null;
  cursor?: { x: number; y: number } | null;
  target?: ActionTarget | null;
  pointer?: ActionPointer | null;
}

export type PickResult =
  | {
      emitted: string;
      locator: { kind: string; value: unknown; nth?: number };
      candidates: Array<{
        kind: string;
        value: unknown;
        score: number;
        unique: boolean;
        nth?: number;
      }>;
      element?: Record<string, unknown>;
    }
  | { cancelled: true; reason: string };

export const stores = new Map<number, StoreRecord>();

export const fsResources = new Map<number, FsResource>();

export const shellProcesses = new Map<number, ShellProcessResource>();

export const updaterResources = new Set<number>();

export const recordingSessions = new Map<string, RecordingSession>();

export const captureStreamSessions = new Map<string, CaptureStreamSession>();

export const renderSessions = new Map<string, RenderSession>();

export const renderProgressListeners = new Set<RenderProgressListener>();

export const simulatorSessions = new Map<string, SimulatorSession>();

export const dryRunSessions = new Map<string, DryRunSession>();

export const eventListeners = new Map<number, EventListener>();

export const authorPreviewSessions = new Map<string, AuthorPreviewSession>();

export const lspDocuments = new Map<string, LspDocument>();

export const activePickerStreams = new Set<string>();

export let nextRid = 1;

export let nextEventId = 1;

export const STORY_FILENAME = "story.story";

export const ASSETS_DIRNAME = "assets";

export const EXPORTS_DIRNAME = "exports";

export const META_DIRNAME = ".storycapture";

export const VERSION_FILENAME = "version.txt";

export const WORKFLOW_FILENAME = "workflow.json";

export const FOLDER_FORMAT_VERSION = "1";

export const WEB_SECRET_SERVICE = "com.storycapture.web";

export const WEB_TOKEN_ACCOUNT = "web_api_token";

export const WEB_INFO_ACCOUNT = "web_account_info";

export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

export const UPLOAD_MIN_MULTIPART_SIZE = 5 * 1024 * 1024;

export function projectsRegistryPath(): string {
  return userDataPath("projects.json");
}

export function captureTargetPath(): string {
  return userDataPath("capture-target.json");
}

export function timelinePath(storyId: string): string {
  return userDataPath("timelines", `${encodeURIComponent(storyId)}.json`);
}

export function presetStorePath(scope: string): string {
  return userDataPath("presets", `${scope}.json`);
}

export function webSyncQueuePath(): string {
  return userDataPath("web-sync-queue.json");
}

export function webSyncStatePath(): string {
  return userDataPath("web-sync-state.json");
}

export function webBaseUrl(): string {
  return (
    process.env.STORYCAPTURE_WEB_URL ??
    (app.isPackaged ? "https://storycapture.app" : "http://localhost:3000")
  ).replace(/\/+$/, "");
}

export function pluginLogLevel(level: unknown): FrontendLogPayload["level"] {
  switch (level) {
    case 1:
    case "trace":
    case "Trace":
      return "trace";
    case 2:
    case "debug":
    case "Debug":
      return "debug";
    case 4:
    case "warn":
    case "Warn":
      return "warn";
    case 5:
    case "error":
    case "Error":
      return "error";
    default:
      return "info";
  }
}

export function shellArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

export function shellEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (value === null) return {};
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return { ...process.env, ...Object.fromEntries(entries) };
}

export function shellOptions(value: unknown): {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding: BufferEncoding;
} {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const encoding = typeof raw.encoding === "string" ? (raw.encoding as BufferEncoding) : "utf8";
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    env: shellEnv(raw.env),
    encoding,
  };
}

export function shellSignal(signal: NodeJS.Signals | null): number | null {
  if (!signal) return null;
  const signalNumber = os.constants.signals[signal as keyof typeof os.constants.signals];
  return typeof signalNumber === "number" ? signalNumber : null;
}

export function updaterMetadata(info: ElectronUpdateInfo) {
  const rid = takeNextResourceId();
  updaterResources.add(rid);
  return {
    rid,
    currentVersion: app.getVersion(),
    version: info.version,
    date: info.releaseDate ?? null,
    body: releaseNotesText(info.releaseNotes),
    rawJson: info,
  };
}

export function windowStatePath(): string {
  return userDataPath("window-state.json");
}

export async function saveElectronWindowState(): Promise<void> {
  const windows = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window, index) => ({
      label: index === 0 ? "main" : `window-${index}`,
      bounds: window.getBounds(),
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      visible: window.isVisible(),
    }));
  await writeJson(windowStatePath(), {
    version: 1,
    windows,
    saved_at: Date.now(),
  });
}

export async function restoreElectronWindowState(): Promise<void> {
  const state = await readJson<{
    windows?: Array<{
      bounds?: Rectangle;
      maximized?: boolean;
      fullscreen?: boolean;
    }>;
  }>(windowStatePath(), {});
  const saved = state.windows?.[0];
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window || !saved?.bounds) return;
  window.setBounds(saved.bounds);
  if (saved.maximized) window.maximize();
  if (saved.fullscreen) window.setFullScreen(true);
}

export function parseSourceNumericId(sourceId: string): number {
  const raw = sourceId.split(":")[1] ?? sourceId;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function displayInfo() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    name: display.label || `Display ${display.id}`,
    x: display.bounds.x,
    y: display.bounds.y,
    width_px: Math.round(display.bounds.width * display.scaleFactor),
    height_px: Math.round(display.bounds.height * display.scaleFactor),
    scale_factor: display.scaleFactor,
    is_primary: display.id === primaryId,
  }));
}

export function displayById(displayId: number | string) {
  return screen.getAllDisplays().find((display) => display.id === Number(displayId));
}

export function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function channelIdFrom(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isFinite(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = Number((value as { id?: unknown }).id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

export function sendCallback(webContents: WebContents, id: number, value: unknown): void {
  if (webContents.isDestroyed()) return;
  webContents.send("tauri-callback", { id, value });
}

export function sendChannel(
  webContents: WebContents,
  channelId: number | null,
  message: unknown,
): void {
  if (channelId == null || webContents.isDestroyed()) return;
  webContents.send("tauri-channel", { id: channelId, message });
}

export function closeChannel(webContents: WebContents, channelId: number | null): void {
  if (channelId == null || webContents.isDestroyed()) return;
  webContents.send("tauri-channel", { id: channelId, end: true });
}

export function storyHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function storyAppUrl(source: string): string | null {
  const parsed = parseStorySource(source);
  return parsed.ast?.meta?.app ?? null;
}

export function cssAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function targetSelector(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const { kind, value } = target as { kind?: string; value?: unknown };
  if (typeof value !== "string") return null;
  if (kind === "selector") return value;
  if (kind === "test_id") return `[data-testid="${cssAttributeValue(value)}"]`;
  if (kind === "aria") return `[aria-label="${cssAttributeValue(value)}"]`;
  return null;
}

export function targetLabel(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const target = record as { kind?: unknown; value?: unknown };
  if (target.value && typeof target.value === "object") {
    const value = target.value as { name?: unknown };
    if (typeof value.name === "string" && value.name.length > 0) {
      return value.name;
    }
  }
  return typeof target.value === "string" && target.value.length > 0 ? target.value : null;
}

export async function resolveElementTarget(
  contents: WebContents,
  target: unknown,
  targetNth?: number,
): Promise<ActionTarget | null> {
  const selector = targetSelector(target);
  const resolved = (await contents.executeJavaScript(
    simulatorTargetGeometryScript(target, targetNth, selector),
  )) as ActionTarget | null;
  const label = targetLabel(target) ?? resolved?.label ?? null;
  return resolved ? { ...resolved, label } : null;
}

export async function hostLog(
  level: "info" | "warn",
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  try {
    await logFromFrontend({
      level,
      source: "electron-host",
      message,
      fields: Object.entries(fields).map(([key, value]) => [key, String(value)]),
    });
  } catch {
    // Host diagnostics must never fail the browser run they describe.
  }
}

export function takeNextResourceId(): number {
  return nextRid++;
}

export function takeNextEventListenerId(): number {
  return nextEventId++;
}
