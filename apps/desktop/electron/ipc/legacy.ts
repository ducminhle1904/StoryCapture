import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  type FSWatcher,
  constants as fsConstants,
  type Stats,
  watch as watchFs,
} from "node:fs";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import slugify from "@sindresorhus/slugify";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Rectangle,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import electronUpdater, {
  type UpdateInfo as ElectronUpdateInfo,
} from "electron-updater";
import ffmpegPath from "ffmpeg-static";
import identity from "../identity.json";
import { screenCapturePermissionReport } from "../permissions/screen-capture";
import {
  DEV_RELAUNCH_EXIT_CODE,
  isDevRuntime,
  isPackagedRuntime,
} from "../runtime";
import {
  deleteGenericSecret,
  loadOptionalGenericSecret,
  storeGenericSecret,
} from "./generic-secret-store";
import { readJson, writeJson } from "./json-store";
import { logFromFrontend, type FrontendLogPayload } from "./log-store";
import { sameNavigationUrl } from "./navigation-url";
import { userDataPath } from "./paths";
import { recordingTailFrameDelaysMs } from "./recording-tail";
import { sessionId } from "./session";
import {
  setSimulatorTargetValueIncrementalScript,
  setSimulatorTargetValueScript,
  simulatorTargetCenterScript,
} from "./simulator-dom";
import {
  parseStorySource,
  parsedCommands,
  type ParsedCommand,
} from "./story-parser";
import type { InvokeArgs, InvokeEnvelope } from "./types";
import {
  checkElectronUpdate,
  getPendingUpdateInfo,
  installElectronUpdate,
  releaseNotesText,
} from "./update-store";

const { autoUpdater } = electronUpdater;

interface StoreRecord {
  path: string;
  data: Record<string, unknown>;
  dirty: boolean;
}

interface FsFileResource {
  kind: "file";
  append: boolean;
  handle: NodeFileHandle;
  path: string;
  position: number;
}

interface FsLineResource {
  kind: "lines";
  encoding: BufferEncoding;
  index: number;
  lines: string[];
}

interface FsWatcherResource {
  kind: "watcher";
  watchers: FSWatcher[];
}

type FsResource = FsFileResource | FsLineResource | FsWatcherResource;

interface ShellProcessResource {
  child: ChildProcessWithoutNullStreams;
}

interface ProjectRecord {
  id: string;
  name: string;
  folder_path: string;
  created_at: number;
  last_opened_at: number | null;
  thumbnail_path: string | null;
}

interface TimelineState {
  story_id: string;
  layout_json: string;
  last_modified: number;
}

interface EffectPreset {
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

interface CreateProjectArgs {
  name: string;
  parent: string;
  workflow_type?: string;
  starter_story_source?: string;
  workflow_state?: WorkflowState;
}

interface WorkflowState {
  version: number;
  type: string;
  steps: unknown[];
  createdAt: number;
  updatedAt: number;
}

interface ExportOutput {
  format: string;
  resolution: string;
  output_width?: number | null;
  output_height?: number | null;
  fps: number;
  quality: string;
}

interface ExportRunArgs {
  story_id: string;
  graph_json: string;
  outputs: ExportOutput[];
  output_folder: string;
  base_name: string;
}

interface NewRenderJob {
  story_id: string;
  preset_id?: string | null;
  format: string;
  resolution: string;
  fps: number;
  quality: string;
  priority: number;
  batch_id?: string | null;
}

interface RenderJob extends NewRenderJob {
  id: string;
  output_width: number | null;
  output_height: number | null;
  encoder_options_json: string | null;
  status: string;
  progress_pct: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  output_path: string | null;
  created_at: number;
}

interface RenderProgressListener {
  sender: WebContents;
  channelId: number | null;
}

interface RenderSession {
  job: RenderJob;
  timer: ReturnType<typeof setInterval>;
  frame: number;
}

type ProviderId = "anthropic" | "openai" | "elevenlabs" | "openai_tts";

interface SecretStore {
  version: number;
  keys: Record<string, string>;
}

interface AudioInputInfo {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rate_hz: number;
}

type DialogButtonSpec =
  | string
  | { OkCustom?: string }
  | { OkCancelCustom?: [string, string] }
  | { YesNoCancelCustom?: [string, string, string] };

interface DialogFilterSpec {
  name?: string;
  extensions?: string[];
}

interface OpenDialogSpec {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  canCreateDirectories?: boolean;
  filters?: DialogFilterSpec[];
}

interface SaveDialogSpec {
  title?: string;
  defaultPath?: string;
  canCreateDirectories?: boolean;
  filters?: DialogFilterSpec[];
}

interface VoiceInfoDto {
  id: string;
  name: string;
  locale: string | null;
  premium: boolean;
}

interface AuthorSnapshotEntry {
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

interface WebAccountInfo {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  connectedAt: string;
}

interface WebSyncQueueItem {
  id: string;
  desktopId: string;
  workspaceId: string;
  payload: unknown;
  createdAt: string;
}

interface WebSyncStateFile {
  version: number;
  lastSync: string | null;
}

interface UploadProgressEvent {
  phase: string;
  partNumber: number;
  totalParts: number;
  bytesUploaded: number;
  totalBytes: number;
}

interface UploadStatusDto {
  status: string;
  progress: UploadProgressEvent | null;
  videoSlug: string | null;
  error: string | null;
}

interface PendingOAuthFlow {
  port: number;
  server: Server;
  tokenPromise: Promise<string>;
  resolveToken: (token: string) => void;
  rejectToken: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SimulatorStepFrame {
  ordinal: number;
  screenshot_path: string | null;
  cursor_xy: [number, number];
  matched_selector: string | null;
  matched_bbox: { x: number; y: number; w: number; h: number } | null;
  match_kind: "primary" | "fuzzy" | "none";
  duration_ms: number;
}

interface LspDocument {
  uri: string;
  text: string;
  version: number;
}

interface LspPosition {
  line: number;
  character: number;
}

type CaptureTarget =
  | { kind: "display"; display_id: number | string }
  | { kind: "window"; window_id: number | string }
  | { kind: "window_by_pid"; pid: number; title_hint: string | null }
  | { kind: "author_preview"; stream_id: string }
  | {
      kind: "display_region";
      display_id: number | string;
      rect: { x: number; y: number; w: number; h: number };
    };

interface FrameCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  basis_w?: number | null;
  basis_h?: number | null;
  scale_hint?: number | null;
}

interface RecordingSession {
  id: string;
  projectFolder: string;
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  startedAt: number;
  paused: boolean;
  eventTarget: WebContents;
  eventChannelId: number | null;
  heartbeat: ReturnType<typeof setInterval>;
  captureTimer: ReturnType<typeof setInterval>;
  framesDir: string;
  frameSeq: number;
  framesDropped: number;
  captureInFlight: Promise<void> | null;
  audioPath: string | null;
  frameCrop: FrameCropRect | null;
  loggedAuthorPreviewFrame: boolean;
  requestedFps: number;
  effectiveFps: number;
  lateFrames: number;
  captureDurationMs: number[];
}

interface CaptureStreamSession {
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

interface SimulatorSession {
  id: string;
  sender: WebContents;
  channelId: number | null;
  storyPath: string;
  commands: ParsedCommand[];
  frames: Map<number, SimulatorStepFrame>;
  totalSteps: number;
  cancelled: boolean;
}

interface DryRunStep {
  id: string;
  verb: string;
  target: string | null;
  value: string | null;
}

interface DryRunSession {
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

interface EventListener {
  event: string;
  eventId: number;
  handlerId: number;
  sender: WebContents;
}

interface AuthorPreviewSession {
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

interface StoryBrowserRunHooks {
  onStepStarted?: (ordinal: number, command: ParsedCommand) => void;
  onStepSucceeded?: (
    ordinal: number,
    command: ParsedCommand,
    result: ParsedCommandResult,
    durationMs: number,
  ) => void;
  onFrameCaptured?: (ordinal: number, frame: SimulatorStepFrame) => void;
  onStepFailed?: (ordinal: number, error: unknown) => void;
}

interface StoryBrowserRunOptions {
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
  recordingMode?: boolean;
  shouldCancel?: () => boolean;
  hooks?: StoryBrowserRunHooks;
}

type StoryBrowserRunExitReason =
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";

interface ParsedCommandResult {
  screenshotPath?: string | null;
  cursor?: { x: number; y: number } | null;
}

type PickResult =
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

const stores = new Map<number, StoreRecord>();
const fsResources = new Map<number, FsResource>();
const shellProcesses = new Map<number, ShellProcessResource>();
const updaterResources = new Set<number>();
const recordingSessions = new Map<string, RecordingSession>();
const captureStreamSessions = new Map<string, CaptureStreamSession>();
const renderSessions = new Map<string, RenderSession>();
const renderProgressListeners = new Set<RenderProgressListener>();
const simulatorSessions = new Map<string, SimulatorSession>();
const dryRunSessions = new Map<string, DryRunSession>();
const eventListeners = new Map<number, EventListener>();
const authorPreviewSessions = new Map<string, AuthorPreviewSession>();
const lspDocuments = new Map<string, LspDocument>();
const activePickerStreams = new Set<string>();
const channelIndexes = new Map<number, number>();
let globalPreviewStreamSessionId: string | null = null;
let pendingOAuthFlow: PendingOAuthFlow | null = null;
let uploadCancelRequested = false;
let uploadStatus: UploadStatusDto = {
  status: "idle",
  progress: null,
  videoSlug: null,
  error: null,
};
let nextRid = 1;
let nextEventId = 1;

const STORY_FILENAME = "story.story";
const ASSETS_DIRNAME = "assets";
const EXPORTS_DIRNAME = "exports";
const META_DIRNAME = ".storycapture";
const VERSION_FILENAME = "version.txt";
const WORKFLOW_FILENAME = "workflow.json";
const FOLDER_FORMAT_VERSION = "1";
const WEB_SECRET_SERVICE = "com.storycapture.web";
const WEB_TOKEN_ACCOUNT = "web_api_token";
const WEB_INFO_ACCOUNT = "web_account_info";
const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;
const UPLOAD_MIN_MULTIPART_SIZE = 5 * 1024 * 1024;

function projectsRegistryPath(): string {
  return userDataPath("projects.json");
}

function captureTargetPath(): string {
  return userDataPath("capture-target.json");
}

function timelinePath(storyId: string): string {
  return userDataPath("timelines", `${encodeURIComponent(storyId)}.json`);
}

function presetStorePath(scope: string): string {
  return userDataPath("presets", `${scope}.json`);
}

function webSyncQueuePath(): string {
  return userDataPath("web-sync-queue.json");
}

function webSyncStatePath(): string {
  return userDataPath("web-sync-state.json");
}

function webBaseUrl(): string {
  return (
    process.env.STORYCAPTURE_WEB_URL ??
    (app.isPackaged ? "https://storycapture.app" : "http://localhost:3000")
  ).replace(/\/+$/, "");
}

function pluginLogLevel(level: unknown): FrontendLogPayload["level"] {
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

function shellArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function shellEnv(value: unknown): NodeJS.ProcessEnv | undefined {
  if (value === null) return {};
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return { ...process.env, ...Object.fromEntries(entries) };
}

function shellOptions(value: unknown): {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding: BufferEncoding;
} {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const encoding =
    typeof raw.encoding === "string"
      ? (raw.encoding as BufferEncoding)
      : "utf8";
  return {
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    env: shellEnv(raw.env),
    encoding,
  };
}

function shellSignal(signal: NodeJS.Signals | null): number | null {
  if (!signal) return null;
  const signalNumber =
    os.constants.signals[signal as keyof typeof os.constants.signals];
  return typeof signalNumber === "number" ? signalNumber : null;
}

function updaterMetadata(info: ElectronUpdateInfo) {
  const rid = nextRid++;
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

function windowStatePath(): string {
  return userDataPath("window-state.json");
}

async function saveElectronWindowState(): Promise<void> {
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

async function restoreElectronWindowState(): Promise<void> {
  const state = await readJson<{
    windows?: Array<{
      bounds?: Rectangle;
      maximized?: boolean;
      fullscreen?: boolean;
    }>;
  }>(windowStatePath(), {});
  const saved = state.windows?.[0];
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => !candidate.isDestroyed(),
  );
  if (!window || !saved?.bounds) return;
  window.setBounds(saved.bounds);
  if (saved.maximized) window.maximize();
  if (saved.fullscreen) window.setFullScreen(true);
}

async function listAudioInputs(sender: WebContents): Promise<AudioInputInfo[]> {
  const devices = await sender
    .executeJavaScript(
      `(() => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        return navigator.mediaDevices.enumerateDevices().then((devices) => {
          const seen = new Set();
          return devices
            .filter((device) => device.kind === "audioinput")
            .filter((device) => device.deviceId !== "default" && device.deviceId !== "communications")
            .filter((device) => {
              const id = device.deviceId || device.groupId || "";
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            })
            .map((device, index) => ({
              id: device.deviceId || device.groupId || ("audioinput-" + index),
              name: device.label || ("Microphone " + (index + 1)),
              is_default: index === 0,
              channels: 0,
              sample_rate_hz: 0,
            }));
        });
      })()`,
      true,
    )
    .catch(() => []);
  if (!Array.isArray(devices)) return [];
  return devices
    .filter((device): device is AudioInputInfo => {
      if (!device || typeof device !== "object") return false;
      const candidate = device as Partial<AudioInputInfo>;
      return (
        typeof candidate.id === "string" && typeof candidate.name === "string"
      );
    })
    .map((device, index) => ({
      id: device.id,
      name: device.name || `Microphone ${index + 1}`,
      is_default: Boolean(device.is_default),
      channels: Number.isFinite(device.channels) ? Number(device.channels) : 0,
      sample_rate_hz: Number.isFinite(device.sample_rate_hz)
        ? Number(device.sample_rate_hz)
        : 0,
    }));
}

function secretStorePath(): string {
  return userDataPath("secrets.v1.json");
}

async function getWebApiToken(): Promise<string | null> {
  return loadOptionalGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT);
}

async function getWebAccount(): Promise<WebAccountInfo | null> {
  const json = await loadOptionalGenericSecret(
    WEB_SECRET_SERVICE,
    WEB_INFO_ACCOUNT,
  );
  if (!json) return null;
  const parsed = JSON.parse(json) as Partial<WebAccountInfo>;
  if (typeof parsed.email !== "string") return null;
  return {
    email: parsed.email,
    name: parsed.name ?? null,
    avatarUrl: parsed.avatarUrl ?? null,
    connectedAt: parsed.connectedAt ?? new Date().toISOString(),
  };
}

function closePendingOAuthFlow(): void {
  if (!pendingOAuthFlow) return;
  clearTimeout(pendingOAuthFlow.timer);
  pendingOAuthFlow.server.close();
  pendingOAuthFlow = null;
}

async function startWebOauth(): Promise<number> {
  closePendingOAuthFlow();

  let resolveToken: (token: string) => void = () => {};
  let rejectToken: (error: Error) => void = () => {};
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const token = requestUrl.searchParams.get("token");
    if (token) {
      response.writeHead(200, {
        "content-type": "text/html",
        connection: "close",
      });
      response.end(
        "<html><body><h1>Authentication successful</h1><p>You can close this window and return to StoryCapture.</p></body></html>",
      );
      resolveToken(token);
    } else {
      response.writeHead(400, {
        "content-type": "text/html",
        connection: "close",
      });
      response.end(
        "<html><body><h1>Authentication failed</h1><p>No token received. Please try again.</p></body></html>",
      );
      rejectToken(new Error("OAuth callback did not include a token"));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind OAuth callback server"));
        return;
      }
      resolve(address.port);
    });
  });

  const timer = setTimeout(() => {
    rejectToken(new Error("OAuth flow timed out after 30 seconds"));
    closePendingOAuthFlow();
  }, 30_000);
  timer.unref?.();
  pendingOAuthFlow = {
    port,
    server,
    tokenPromise,
    resolveToken,
    rejectToken,
    timer,
  };

  try {
    await shell.openExternal(
      `${webBaseUrl()}/api/auth/signin/github?callbackUrl=http://localhost:${port}/callback`,
    );
  } catch (error) {
    closePendingOAuthFlow();
    throw error;
  }

  return port;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function completeWebOauth(): Promise<WebAccountInfo> {
  const flow = pendingOAuthFlow;
  if (!flow)
    throw new Error("no pending OAuth flow - call start_web_oauth first");

  let sessionToken: string;
  try {
    sessionToken = await flow.tokenPromise;
  } finally {
    closePendingOAuthFlow();
  }

  const response = await fetch(`${webBaseUrl()}/api/auth/desktop-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `failed to exchange token: server returned ${response.status}`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const token = stringOrNull(body.token);
  const email = stringOrNull(body.email);
  if (!token || !email)
    throw new Error("failed to exchange token: invalid server response");

  const account: WebAccountInfo = {
    email,
    name: stringOrNull(body.name),
    avatarUrl: stringOrNull(body.avatarUrl ?? body.avatar_url),
    connectedAt: new Date().toISOString(),
  };
  await storeGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT, token);
  await storeGenericSecret(
    WEB_SECRET_SERVICE,
    WEB_INFO_ACCOUNT,
    JSON.stringify(account),
  );
  return account;
}

async function disconnectWebAccount(): Promise<null> {
  closePendingOAuthFlow();
  await deleteGenericSecret(WEB_SECRET_SERVICE, WEB_TOKEN_ACCOUNT);
  await deleteGenericSecret(WEB_SECRET_SERVICE, WEB_INFO_ACCOUNT);
  return null;
}

async function readWebSyncQueue(): Promise<WebSyncQueueItem[]> {
  const queue = await readJson<WebSyncQueueItem[]>(webSyncQueuePath(), []);
  return Array.isArray(queue) ? queue : [];
}

async function writeWebSyncQueue(queue: WebSyncQueueItem[]): Promise<void> {
  await writeJson(webSyncQueuePath(), queue);
}

async function readWebSyncState(): Promise<WebSyncStateFile> {
  return readJson<WebSyncStateFile>(webSyncStatePath(), {
    version: 1,
    lastSync: null,
  });
}

async function writeWebSyncState(
  update: Partial<WebSyncStateFile>,
): Promise<void> {
  const current = await readWebSyncState();
  await writeJson(webSyncStatePath(), { ...current, ...update, version: 1 });
}

async function queueWebSyncItem(
  desktopId: string,
  workspaceId: string,
  payload: unknown,
): Promise<void> {
  const queue = await readWebSyncQueue();
  queue.push({
    id: randomUUID(),
    desktopId,
    workspaceId,
    payload,
    createdAt: new Date().toISOString(),
  });
  await writeWebSyncQueue(queue);
}

async function postTrpcMutation(
  token: string,
  procedure: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${webBaseUrl()}/api/trpc/${procedure}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: payload }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`${response.status}: ${body}`);
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function trpcLastSyncedAt(response: Record<string, unknown>): string {
  const result = response.result as
    | { data?: { json?: { lastSyncedAt?: unknown } } }
    | undefined;
  return (
    stringOrNull(result?.data?.json?.lastSyncedAt) ?? new Date().toISOString()
  );
}

function workflowStateFromJson(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return null;
  return JSON.parse(value);
}

function buildWebSyncPayload(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    desktopId: String(args.desktopId ?? ""),
    workspaceId: String(args.workspaceId ?? ""),
    projectName: String(args.projectName ?? ""),
    storySource: args.storySource ?? null,
    workflowType: args.workflowType ?? null,
    workflowState: workflowStateFromJson(args.workflowStateJson),
  };
}

async function syncProjectMetadata(args: Record<string, unknown>) {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");
  const desktopId = String(args.desktopId ?? "");
  const workspaceId = String(args.workspaceId ?? "");
  const payload = buildWebSyncPayload(args);
  try {
    const response = await postTrpcMutation(
      token,
      "sync.pushMetadata",
      payload,
    );
    const lastSyncedAt = trpcLastSyncedAt(response);
    await writeWebSyncState({ lastSync: lastSyncedAt });
    return { synced: true, lastSyncedAt };
  } catch (error) {
    await queueWebSyncItem(desktopId, workspaceId, payload);
    throw error;
  }
}

async function flushSyncQueue() {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");

  const queue = await readWebSyncQueue();
  let flushed = 0;
  let failed = 0;
  const remaining: WebSyncQueueItem[] = [];
  for (const item of queue) {
    try {
      await postTrpcMutation(token, "sync.pushMetadata", item.payload);
      flushed += 1;
    } catch {
      failed += 1;
      remaining.push(item);
    }
  }
  await writeWebSyncQueue(remaining);
  if (flushed > 0)
    await writeWebSyncState({ lastSync: new Date().toISOString() });
  return { flushed, failed, remaining: remaining.length };
}

async function getSyncStatus() {
  const [token, queue, state] = await Promise.all([
    getWebApiToken(),
    readWebSyncQueue(),
    readWebSyncState(),
  ]);
  return {
    connected: token != null,
    pendingCount: queue.length,
    lastSync: state.lastSync,
  };
}

async function updateRecordingStatus(
  args: Record<string, unknown>,
): Promise<null> {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");
  await postTrpcMutation(token, "sync.updateRecordingStatus", {
    desktopId: String(args.desktopId ?? ""),
    workspaceId: String(args.workspaceId ?? ""),
    status: String(args.status ?? ""),
  });
  return null;
}

function updateUploadStatus(
  progress: UploadProgressEvent | null,
  sender?: WebContents,
  channelId?: number | null,
): void {
  uploadStatus = { ...uploadStatus, progress };
  if (progress && sender) sendChannel(sender, channelId ?? null, progress);
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function uploadVideo(args: Record<string, unknown>, sender: WebContents) {
  const token = await getWebApiToken();
  if (!token) throw new Error("no web account connected");

  const videoPath = String(args.videoPath ?? "");
  const projectName = String(args.projectName ?? "Untitled project");
  const workspaceId = stringOrNull(args.workspaceId) ?? "personal";
  const onProgress = channelIdFrom(args.onProgress);
  const fileName = path.basename(videoPath);
  const stat = await fs.stat(videoPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`file not found: ${videoPath}`);
  if (stat.size <= 0) throw new Error("file is empty");

  uploadCancelRequested = false;
  uploadStatus = {
    status: "uploading",
    progress: null,
    videoSlug: null,
    error: null,
  };
  const totalBytes = stat.size;
  updateUploadStatus(
    {
      phase: "thumbnail",
      partNumber: 0,
      totalParts: 0,
      bytesUploaded: 0,
      totalBytes,
    },
    sender,
    onProgress,
  );

  const body: Record<string, unknown> = {
    fileName,
    fileSizeBytes: totalBytes,
    contentType: "video/mp4",
    workspaceId,
    projectName,
  };
  if (typeof args.storySource === "string") body.storySource = args.storySource;
  if (typeof args.sceneBoundaries === "string")
    body.sceneBoundaries = JSON.parse(args.sceneBoundaries);

  const initiate = await fetch(`${webBaseUrl()}/api/upload/initiate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!initiate.ok)
    throw new Error(
      `initiate failed: ${initiate.status} - ${await initiate.text()}`,
    );
  const init = await parseJsonResponse(initiate);
  const videoId = stringOrNull(init.videoId);
  const uploadId = stringOrNull(init.uploadId);
  const r2Key = stringOrNull(init.r2Key);
  const slug = stringOrNull(init.slug);
  if (!videoId || !uploadId || !r2Key || !slug)
    throw new Error("initiate failed: invalid server response");

  const totalParts =
    totalBytes < UPLOAD_MIN_MULTIPART_SIZE
      ? 1
      : Math.ceil(totalBytes / UPLOAD_CHUNK_SIZE);
  const parts: Array<{ PartNumber: number; ETag: string }> = [];
  let bytesUploaded = 0;
  const file = await fs.open(videoPath, "r");
  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (uploadCancelRequested) throw new Error("upload cancelled");
      const remaining = totalBytes - bytesUploaded;
      const chunkLength = Math.min(UPLOAD_CHUNK_SIZE, remaining);
      const chunk = Buffer.alloc(chunkLength);
      const { bytesRead } = await file.read(
        chunk,
        0,
        chunkLength,
        bytesUploaded,
      );
      const payload = chunk.subarray(0, bytesRead);

      const presign = await fetch(`${webBaseUrl()}/api/upload/presign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ r2Key, uploadId, partNumber }),
      });
      if (!presign.ok)
        throw new Error(
          `presign failed for part ${partNumber}: ${await presign.text()}`,
        );
      const presignBody = await parseJsonResponse(presign);
      const presignedUrl = stringOrNull(
        presignBody.presignedUrl ?? presignBody.presigned_url,
      );
      if (!presignedUrl)
        throw new Error(`presign failed for part ${partNumber}: missing URL`);

      const put = await fetch(presignedUrl, {
        method: "PUT",
        body: payload as unknown as BodyInit,
      });
      if (!put.ok)
        throw new Error(`PUT part ${partNumber} failed: ${await put.text()}`);
      parts.push({
        PartNumber: partNumber,
        ETag: put.headers.get("etag") ?? "",
      });
      bytesUploaded += bytesRead;
      updateUploadStatus(
        {
          phase: "uploading",
          partNumber,
          totalParts,
          bytesUploaded,
          totalBytes,
        },
        sender,
        onProgress,
      );
    }
  } finally {
    await file.close();
  }

  if (uploadCancelRequested) throw new Error("upload cancelled");
  updateUploadStatus(
    {
      phase: "completing",
      partNumber: totalParts,
      totalParts,
      bytesUploaded: totalBytes,
      totalBytes,
    },
    sender,
    onProgress,
  );

  const complete = await fetch(`${webBaseUrl()}/api/upload/complete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      videoId,
      r2Key,
      uploadId,
      parts,
      thumbnailR2Key: r2Key.replace(/\.[^.]+$/, "-thumb.jpg"),
    }),
  });
  if (!complete.ok)
    throw new Error(`complete failed: ${await complete.text()}`);
  const result = await parseJsonResponse(complete);
  const uploadResult = {
    videoId: stringOrNull(result.videoId) ?? videoId,
    slug: stringOrNull(result.slug) ?? slug,
    status: stringOrNull(result.status) ?? "ready",
  };
  uploadStatus = {
    status: "complete",
    progress: null,
    videoSlug: uploadResult.slug,
    error: null,
  };
  return uploadResult;
}

async function uploadVideoWithStatus(
  args: Record<string, unknown>,
  sender: WebContents,
) {
  try {
    return await uploadVideo(args, sender);
  } catch (error) {
    uploadStatus = {
      status: "error",
      progress: null,
      videoSlug: null,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

function cancelUpload(): null {
  uploadCancelRequested = true;
  return null;
}

function providerId(raw: unknown): ProviderId {
  const value = String(raw);
  if (
    value === "anthropic" ||
    value === "openai" ||
    value === "elevenlabs" ||
    value === "openai_tts"
  ) {
    return value;
  }
  throw new Error(`unknown provider: ${value}`);
}

function validateKeyFormat(key: string): void {
  if (!key || key.trim() !== key) {
    throw new Error("key format is invalid for the selected provider");
  }
}

function assertSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable on this host");
  }
}

async function readSecretStore(): Promise<SecretStore> {
  return readJson<SecretStore>(secretStorePath(), { version: 1, keys: {} });
}

async function writeSecretStore(store: SecretStore): Promise<void> {
  await writeJson(secretStorePath(), { version: 1, keys: store.keys ?? {} });
}

async function keySet(provider: ProviderId, key: string): Promise<void> {
  validateKeyFormat(key);
  assertSafeStorage();
  const store = await readSecretStore();
  store.keys[provider] = safeStorage.encryptString(key).toString("base64");
  await writeSecretStore(store);
}

async function keyGet(provider: ProviderId): Promise<string | null> {
  assertSafeStorage();
  const encrypted = (await readSecretStore()).keys[provider];
  if (!encrypted) return null;
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

async function keyGetPresence(provider: ProviderId): Promise<boolean> {
  return (await keyGet(provider)) != null;
}

async function keyDelete(provider: ProviderId): Promise<void> {
  const store = await readSecretStore();
  if (!store.keys[provider]) throw new Error("no key stored for this provider");
  delete store.keys[provider];
  await writeSecretStore(store);
}

function providerProbe(provider: ProviderId) {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        header: "x-api-key",
        value: (key: string) => key,
      };
    case "elevenlabs":
      return {
        url: "https://api.elevenlabs.io/v1/voices",
        header: "xi-api-key",
        value: (key: string) => key,
      };
    case "openai":
    case "openai_tts":
      return {
        url: "https://api.openai.com/v1/models",
        header: "Authorization",
        value: (key: string) => `Bearer ${key}`,
      };
  }
}

async function keyTest(provider: ProviderId) {
  const key = await keyGet(provider);
  if (!key) throw new Error("no key stored for this provider");
  const probe = providerProbe(provider);
  const started = Date.now();
  try {
    const response = await fetch(probe.url, {
      method: "GET",
      headers: { [probe.header]: probe.value(key) },
      signal: AbortSignal.timeout(10_000),
    });
    const detail = `${response.status} ${response.statusText}`.trim();
    if (response.status === 401 || response.status === 403) {
      throw new Error("provider rejected the key");
    }
    return {
      ok: response.ok,
      latency_ms: Date.now() - started,
      detail,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "provider rejected the key")
      throw error;
    throw new Error(
      `network error contacting provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function providerDisplayName(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "elevenlabs":
      return "ElevenLabs";
    case "openai_tts":
      return "OpenAI TTS";
  }
}

async function assertProviderKey(provider: ProviderId): Promise<string> {
  const key = await keyGet(provider);
  if (!key) {
    throw new Error(
      `NoApiKey: no API key stored for ${providerDisplayName(provider)}`,
    );
  }
  return key;
}

async function nlProviderUnavailable(rawProvider: unknown): Promise<never> {
  const provider = providerId(rawProvider ?? "anthropic");
  await assertProviderKey(provider);
  throw new Error(
    `Provider: Electron ${providerDisplayName(provider)} chat is not implemented yet`,
  );
}

async function ttsProviderUnavailable(rawProvider: unknown): Promise<never> {
  const provider = providerId(rawProvider);
  await assertProviderKey(provider);
  throw new Error(
    `Provider: Electron ${providerDisplayName(provider)} speech synthesis is not implemented yet`,
  );
}

async function listTtsVoices(rawProvider: unknown): Promise<VoiceInfoDto[]> {
  const provider = providerId(rawProvider);
  if (provider === "openai_tts") {
    return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((id) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      locale: "en",
      premium: false,
    }));
  }
  if (provider !== "elevenlabs") {
    throw new Error(
      `Provider: ${providerDisplayName(provider)} is not a TTS provider`,
    );
  }
  await assertProviderKey(provider);
  throw new Error(
    "Provider: Electron ElevenLabs voice catalog is not implemented yet",
  );
}

function emptySessionRollup() {
  return {
    turn_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    avg_first_token_ms: null,
  };
}

function numericDuration(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
}

function ttsApplySyncWithoutCachedClips(rawTimings: unknown) {
  const stepTimings = Array.isArray(rawTimings) ? rawTimings : [];
  return {
    adjusted_steps: stepTimings.map((raw) => {
      const timing =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const duration = numericDuration(timing.original_duration_ms);
      return {
        step_id: String(timing.step_id ?? ""),
        new_duration_ms: duration,
        freeze_frame_extension_ms: 0,
        silence_padding_ms: 0,
        clip_start_ms: 0,
        drift_ms: 0,
      };
    }),
    duck_events: [],
  };
}

function defaultStarterStory(name: string): string {
  const safe = name.replaceAll('"', '\\"');
  return `story "${safe}" {\n  meta {\n    app: "https://example.com"\n    viewport: desktop\n    theme: dark\n    speed: 1.0\n  }\n\n  scene "${safe}" {\n    pause\n  }\n}\n`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readProjects(): Promise<ProjectRecord[]> {
  const projects = await readJson<ProjectRecord[]>(projectsRegistryPath(), []);
  return projects
    .filter((project) => project && typeof project.id === "string")
    .sort(
      (a, b) =>
        (b.last_opened_at ?? b.created_at) - (a.last_opened_at ?? a.created_at),
    );
}

async function writeProjects(projects: ProjectRecord[]): Promise<void> {
  await writeJson(projectsRegistryPath(), projects);
}

async function findProject(id: string): Promise<ProjectRecord> {
  const project = (await readProjects()).find(
    (candidate) => candidate.id === id,
  );
  if (!project) throw new Error(`project ${id} not found`);
  return project;
}

function projectPaths(folder: string) {
  const metaDir = path.join(folder, META_DIRNAME);
  return {
    assetsDir: path.join(folder, ASSETS_DIRNAME),
    exportsDir: path.join(folder, EXPORTS_DIRNAME),
    metaDir,
    storyPath: path.join(folder, STORY_FILENAME),
    versionPath: path.join(metaDir, VERSION_FILENAME),
    workflowPath: path.join(metaDir, WORKFLOW_FILENAME),
  };
}

async function assertProjectFolder(folder: string): Promise<void> {
  const { versionPath } = projectPaths(folder);
  const version = (await fs.readFile(versionPath, "utf8")).trim();
  if (version !== FOLDER_FORMAT_VERSION) {
    throw new Error(`unsupported folder format version ${version}`);
  }
}

async function createProject(raw: unknown): Promise<ProjectRecord> {
  const args = raw as CreateProjectArgs;
  const name = args.name?.trim();
  if (!name) throw new Error("project name required");
  if (!args.parent) throw new Error("project parent required");
  if (
    args.workflow_type &&
    args.workflow_state &&
    args.workflow_type !== args.workflow_state.type
  ) {
    throw new Error("workflow_type must match workflow_state.type");
  }

  const slug = slugify(name);
  if (!slug)
    throw new Error(`name ${JSON.stringify(name)} slugifies to empty string`);
  const folder = path.join(args.parent, slug);
  if (await pathExists(folder))
    throw new Error(`project folder already exists: ${folder}`);

  const paths = projectPaths(folder);
  await fs.mkdir(paths.assetsDir, { recursive: true });
  await fs.mkdir(paths.exportsDir, { recursive: true });
  await fs.mkdir(paths.metaDir, { recursive: true });
  await fs.writeFile(paths.versionPath, FOLDER_FORMAT_VERSION, "utf8");
  await fs.writeFile(
    paths.storyPath,
    args.starter_story_source ?? defaultStarterStory(name),
    "utf8",
  );
  if (args.workflow_state) {
    await writeJson(paths.workflowPath, args.workflow_state);
  }

  const now = Date.now();
  const project: ProjectRecord = {
    id: randomUUID(),
    name,
    folder_path: folder,
    created_at: now,
    last_opened_at: now,
    thumbnail_path: null,
  };
  const projects = await readProjects();
  projects.unshift(project);
  await writeProjects(projects);
  return project;
}

async function openProject(id: string) {
  const projects = await readProjects();
  const idx = projects.findIndex((candidate) => candidate.id === id);
  if (idx < 0) throw new Error(`project ${id} not found`);
  const project = { ...projects[idx], last_opened_at: Date.now() };
  projects[idx] = project;
  await assertProjectFolder(project.folder_path);
  await writeProjects(projects);
  const paths = projectPaths(project.folder_path);
  await fs.mkdir(paths.exportsDir, { recursive: true });
  return {
    id: project.id,
    name: project.name,
    folder_path: project.folder_path,
    story_path: paths.storyPath,
    exports_dir: paths.exportsDir,
    session_count: 0,
  };
}

async function removeProject(id: string): Promise<void> {
  const projects = await readProjects();
  await writeProjects(projects.filter((project) => project.id !== id));
}

async function getProjectWorkflow(id: string): Promise<WorkflowState | null> {
  const project = await findProject(id);
  return readJson<WorkflowState | null>(
    projectPaths(project.folder_path).workflowPath,
    null,
  );
}

async function updateProjectWorkflow(
  id: string,
  workflowState: WorkflowState,
): Promise<WorkflowState> {
  const project = await findProject(id);
  const next = { ...workflowState, updatedAt: Date.now() };
  await writeJson(projectPaths(project.folder_path).workflowPath, next);
  return next;
}

async function listProjectRecordings(id: string) {
  const project = await findProject(id);
  const { exportsDir } = projectPaths(project.folder_path);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings = await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"),
      )
      .map(async (entry) => {
        const file = path.join(exportsDir, entry.name);
        const stat = await fs.stat(file);
        return {
          path: file,
          captured_at: stat.mtimeMs,
          duration_ms: null,
          width: null,
          height: null,
        };
      }),
  );
  return recordings.sort((a, b) => b.captured_at - a.captured_at);
}

async function timelineLoad(storyId: string): Promise<TimelineState | null> {
  return readJson<TimelineState | null>(timelinePath(storyId), null);
}

async function timelineSave(
  storyId: string,
  layoutJson: string,
): Promise<void> {
  if (layoutJson.length > 1024 * 1024) {
    throw new Error(
      `layout_json is ${layoutJson.length} bytes; refusing > 1048576`,
    );
  }
  await writeJson(timelinePath(storyId), {
    story_id: storyId,
    layout_json: layoutJson,
    last_modified: Date.now(),
  });
}

function sidecarPath(
  recordingPath: string,
  suffix: "actions" | "trajectory" | "steps",
): string {
  const ext = suffix === "steps" ? ".steps.json" : `.${suffix}.json`;
  return recordingPath.replace(/\.[^/.]+$/, ext);
}

async function readRecordingSidecar(
  recordingPath: string,
  suffix: "actions" | "trajectory" | "steps",
) {
  const file = sidecarPath(recordingPath, suffix);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readPresets(scope: string): Promise<EffectPreset[]> {
  return readJson<EffectPreset[]>(presetStorePath(scope), []);
}

async function writePresets(
  scope: string,
  presets: EffectPreset[],
): Promise<void> {
  await writeJson(presetStorePath(scope), presets);
}

async function presetImport(file: string, scope: string): Promise<string> {
  const raw = JSON.parse(
    await fs.readFile(file, "utf8"),
  ) as Partial<EffectPreset>;
  const preset: EffectPreset = {
    id: raw.id ?? randomUUID(),
    scope,
    name: raw.name ?? path.basename(file, path.extname(file)),
    description: raw.description ?? "",
    ast_json: raw.ast_json ?? "{}",
    version: raw.version ?? 1,
    bundled: false,
    created_at: raw.created_at ?? Date.now(),
    author: raw.author ?? null,
    tags: raw.tags ?? [],
  };
  const presets = (await readPresets(scope)).filter(
    (candidate) => candidate.id !== preset.id,
  );
  presets.unshift(preset);
  await writePresets(scope, presets);
  return preset.id;
}

async function presetExport(id: string, out: string): Promise<void> {
  const presets = [
    ...(await readPresets("project")),
    ...(await readPresets("global")),
  ];
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`preset ${id} not found`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(preset, null, 2), "utf8");
}

function exportPresetsCatalogue() {
  return {
    formats: ["mp4", "webm", "gif"],
    resolutions: ["match-source", "720p", "1080p", "4k", "custom"],
    fps: [24, 30, 60],
    qualities: ["low", "med", "high"],
  };
}

function validateExportOutput(output: ExportOutput): void {
  if (!["mp4", "webm", "gif"].includes(output.format)) {
    throw new Error(`unknown format: ${output.format}`);
  }
  if (
    !["match-source", "720p", "1080p", "4k", "custom"].includes(
      output.resolution,
    )
  ) {
    throw new Error(`unknown resolution: ${output.resolution}`);
  }
  if (!exportPresetsCatalogue().fps.includes(output.fps)) {
    throw new Error(`unsupported fps: ${output.fps}`);
  }
  if (!["low", "med", "high"].includes(output.quality)) {
    throw new Error(`unknown quality: ${output.quality}`);
  }
  if (
    output.resolution === "custom" &&
    (!output.output_width || !output.output_height)
  ) {
    throw new Error(
      "custom resolution requires output_width and output_height",
    );
  }
}

function resolutionSize(
  output: ExportOutput,
): { width: number; height: number } | null {
  switch (output.resolution) {
    case "720p":
      return { width: 1280, height: 720 };
    case "1080p":
      return { width: 1920, height: 1080 };
    case "4k":
      return { width: 3840, height: 2160 };
    case "custom":
      return {
        width: clampDimension(output.output_width, 1920),
        height: clampDimension(output.output_height, 1080),
      };
    default:
      return null;
  }
}

function firstSourcePath(graphJson: string): string {
  const graph = JSON.parse(graphJson) as {
    video?: Array<{ type?: string; path?: string }>;
  };
  const source = graph.video?.find(
    (node) => node.type === "source" && node.path,
  );
  if (!source?.path) throw new Error("export graph has no source video");
  return source.path;
}

function exportOutputPath(
  args: ExportRunArgs,
  output: ExportOutput,
  index: number,
): string {
  const ext = output.format.toLowerCase();
  const base = slugify(args.base_name || args.story_id || "export") || "export";
  const suffix =
    args.outputs.length > 1 ? `-${index + 1}-${output.resolution}` : "";
  return path.join(args.output_folder, `${base}${suffix}.${ext}`);
}

async function exportRun(args: ExportRunArgs) {
  if (!args.outputs.length)
    throw new Error("export requires at least one output");
  args.outputs.forEach(validateExportOutput);
  await fs.mkdir(args.output_folder, { recursive: true });
  const batchId = randomUUID();
  const snapshotPath = path.join(
    args.output_folder,
    `${slugify(args.base_name || args.story_id || "export") || "export"}.graph.json`,
  );
  await fs.writeFile(snapshotPath, args.graph_json, "utf8");
  const input = firstSourcePath(args.graph_json);
  const jobIds: string[] = [];

  for (const [index, output] of args.outputs.entries()) {
    const out = exportOutputPath(args, output, index);
    const size = resolutionSize(output);
    const vf = [`fps=${output.fps}`];
    if (size) vf.push(`scale=${size.width}:${size.height}:flags=lanczos`);
    const ffmpegArgs = ["-y", "-i", input, "-vf", vf.join(",")];
    if (output.format === "mp4") {
      ffmpegArgs.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
      );
    } else if (output.format === "webm") {
      ffmpegArgs.push(
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        output.quality === "high"
          ? "4M"
          : output.quality === "med"
            ? "2M"
            : "1M",
        "-an",
      );
    }
    ffmpegArgs.push(out);
    await runFfmpeg(ffmpegArgs);
    jobIds.push(randomUUID());
  }

  return {
    batch_id: batchId,
    job_ids: jobIds,
    graph_snapshot_path: snapshotPath,
  };
}

function renderProgress(job: RenderJob, frame: number) {
  return {
    job_id: job.id,
    pct: job.progress_pct,
    frame,
    fps: job.fps,
    speed: 1,
    eta_ms: Math.max(0, Math.round((100 - job.progress_pct) * 100)),
  };
}

function broadcastRenderProgress(job: RenderJob, frame: number): void {
  const progress = renderProgress(job, frame);
  for (const listener of renderProgressListeners) {
    if (listener.sender.isDestroyed()) {
      renderProgressListeners.delete(listener);
      continue;
    }
    sendChannel(listener.sender, listener.channelId, progress);
  }
}

function renderEnqueue(rawJob: unknown): string {
  const job = rawJob as Partial<NewRenderJob>;
  const id = randomUUID();
  const now = Date.now();
  const renderJob: RenderJob = {
    id,
    story_id: String(job.story_id ?? ""),
    preset_id: job.preset_id ?? null,
    format: String(job.format ?? "mp4"),
    resolution: String(job.resolution ?? "1080p"),
    fps: clampFps(job.fps),
    quality: String(job.quality ?? "high"),
    priority: Number.isFinite(Number(job.priority)) ? Number(job.priority) : 0,
    batch_id: job.batch_id ?? null,
    output_width: null,
    output_height: null,
    encoder_options_json: null,
    status: "running",
    progress_pct: 0,
    started_at: now,
    completed_at: null,
    error: null,
    output_path: null,
    created_at: now,
  };
  const session: RenderSession = {
    job: renderJob,
    frame: 0,
    timer: setInterval(() => {
      session.frame += Math.max(1, Math.round(renderJob.fps / 2));
      renderJob.progress_pct = Math.min(100, renderJob.progress_pct + 10);
      broadcastRenderProgress(renderJob, session.frame);
      if (renderJob.progress_pct >= 100) {
        renderJob.status = "completed";
        renderJob.completed_at = Date.now();
        clearInterval(session.timer);
        setTimeout(() => renderSessions.delete(id), 5000).unref?.();
      }
    }, 500),
  };
  session.timer.unref?.();
  renderSessions.set(id, session);
  broadcastRenderProgress(renderJob, 0);
  return id;
}

function renderCancel(jobId: string): null {
  const session = renderSessions.get(jobId);
  if (session) {
    clearInterval(session.timer);
    session.job.status = "cancelled";
    session.job.completed_at = Date.now();
    broadcastRenderProgress(session.job, session.frame);
    renderSessions.delete(jobId);
  }
  return null;
}

function renderListActive(storyId: string): RenderJob[] {
  return [...renderSessions.values()]
    .map((session) => session.job)
    .filter(
      (job) =>
        job.story_id === storyId &&
        job.status !== "completed" &&
        job.status !== "cancelled",
    )
    .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
}

function streamRenderProgress(args: unknown, sender: WebContents): null {
  const listener: RenderProgressListener = {
    sender,
    channelId: channelIdFrom(
      (args as { channel?: unknown } | undefined)?.channel,
    ),
  };
  renderProgressListeners.add(listener);
  sender.once("destroyed", () => {
    renderProgressListeners.delete(listener);
  });
  for (const session of renderSessions.values()) {
    sendChannel(
      sender,
      listener.channelId,
      renderProgress(session.job, session.frame),
    );
  }
  return null;
}

function parseSourceNumericId(sourceId: string): number {
  const raw = sourceId.split(":")[1] ?? sourceId;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function displayInfo() {
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

function displayById(displayId: number | string) {
  return screen
    .getAllDisplays()
    .find((display) => display.id === Number(displayId));
}

function resizeToFit(
  image: NativeImage,
  maxWidth: number,
  maxHeight: number,
): NativeImage {
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

function cropDisplayRegionThumbnail(
  image: NativeImage,
  target: Extract<CaptureTarget, { kind: "display_region" }>,
): NativeImage {
  const display = displayById(target.display_id);
  const imageSize = image.getSize();
  if (!display || imageSize.width <= 0 || imageSize.height <= 0) return image;

  const displayWidthPx = Math.round(display.bounds.width * display.scaleFactor);
  const displayHeightPx = Math.round(
    display.bounds.height * display.scaleFactor,
  );
  const scaleX = imageSize.width / displayWidthPx;
  const scaleY = imageSize.height / displayHeightPx;
  const x = Math.max(
    0,
    Math.round(target.rect.x * display.scaleFactor * scaleX),
  );
  const y = Math.max(
    0,
    Math.round(target.rect.y * display.scaleFactor * scaleY),
  );
  const width = Math.max(
    1,
    Math.round(target.rect.w * display.scaleFactor * scaleX),
  );
  const height = Math.max(
    1,
    Math.round(target.rect.h * display.scaleFactor * scaleY),
  );
  const crop = {
    x: Math.min(x, Math.max(0, imageSize.width - 1)),
    y: Math.min(y, Math.max(0, imageSize.height - 1)),
    width: Math.min(width, Math.max(1, imageSize.width - x)),
    height: Math.min(height, Math.max(1, imageSize.height - y)),
  };
  return image.crop(crop);
}

async function windowInfo() {
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

async function captureTargetNativeImage(
  target: Exclude<CaptureTarget, { kind: "author_preview" }>,
  maxWidth: number,
  maxHeight: number,
): Promise<NativeImage> {
  const display =
    target.kind === "display_region" ? displayById(target.display_id) : null;
  const thumbnailSize = display
    ? {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      }
    : { width: maxWidth, height: maxHeight };
  const sourceTypes =
    target.kind === "window" || target.kind === "window_by_pid"
      ? ["window"]
      : ["screen"];
  const sources = await desktopCapturer.getSources({
    types: sourceTypes as Array<"window" | "screen">,
    thumbnailSize,
    fetchWindowIcons: true,
  });
  const source =
    sources.find((candidate) => {
      if (target.kind === "display" || target.kind === "display_region") {
        return candidate.display_id === String(target.display_id);
      }
      if (target.kind === "window") {
        return parseSourceNumericId(candidate.id) === Number(target.window_id);
      }
      return target.title_hint
        ? candidate.name.includes(target.title_hint)
        : false;
    }) ?? sources[0];
  if (!source) throw new Error("capture target unavailable");
  if (source.thumbnail.isEmpty())
    throw new Error("capture target thumbnail is empty");
  const image =
    target.kind === "display_region"
      ? resizeToFit(
          cropDisplayRegionThumbnail(source.thumbnail, target),
          maxWidth,
          maxHeight,
        )
      : source.thumbnail;
  return image;
}

async function captureTargetThumbnail(
  target: CaptureTarget,
  maxWidth: number,
  maxHeight: number,
) {
  if (target.kind === "author_preview") {
    const image = await captureAuthorPreviewNativeImage(
      target.stream_id,
      maxWidth,
      maxHeight,
    );
    return Array.from(image.toPNG());
  }
  const image = await captureTargetNativeImage(target, maxWidth, maxHeight);
  return Array.from(image.toPNG());
}

function snapshotDir(projectDir: string): string {
  const root = path.resolve(projectDir);
  if (!path.isAbsolute(root))
    throw new Error(`projectDir must be absolute: ${projectDir}`);
  if (root.split(path.sep).includes(".."))
    throw new Error("path traversal rejected in projectDir");
  return path.join(root, ".story.snapshots");
}

function snapshotKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function snapshotEntry(
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

async function authorSnapshotGet(
  projectDir: string,
  url: string,
): Promise<AuthorSnapshotEntry | null> {
  const manifest = path.join(
    snapshotDir(projectDir),
    `${snapshotKey(url)}.json`,
  );
  try {
    return JSON.parse(
      await fs.readFile(manifest, "utf8"),
    ) as AuthorSnapshotEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function authorSnapshotList(
  projectDir: string,
): Promise<AuthorSnapshotEntry[]> {
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
    return snapshots.filter(
      (entry): entry is AuthorSnapshotEntry => entry != null,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function authorSnapshotCapture(
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
    const entry = snapshotEntry(
      win.webContents.getURL() || url,
      html,
      htmlPath,
      screenshotPath,
    );
    await fs.writeFile(manifestPath, JSON.stringify(entry, null, 2), "utf8");
    return entry;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function authorSnapshotValidate(
  projectDir: string,
  url: string,
  target: unknown,
) {
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
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
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

function defaultCaptureTarget(): CaptureTarget {
  return { kind: "display", display_id: screen.getPrimaryDisplay().id };
}

function isAuthorPreviewTarget(
  target: CaptureTarget | null | undefined,
): target is Extract<CaptureTarget, { kind: "author_preview" }> {
  return target?.kind === "author_preview";
}

function displayForTarget(target: CaptureTarget) {
  const displays = displayInfo();
  if (target.kind === "display" || target.kind === "display_region") {
    return (
      displays.find(
        (display) => Number(display.id) === Number(target.display_id),
      ) ?? displays[0]
    );
  }
  return displays[0];
}

function dimensionsForTarget(
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

function captureEventJson(kind: string, payload: Record<string, unknown> = {}) {
  return { json: JSON.stringify({ kind, ...payload }) };
}

async function pumpCaptureStreamFrame(
  session: CaptureStreamSession,
): Promise<void> {
  const frameSequence = session.sequence + 1;
  try {
    const bytes = await captureTargetThumbnail(
      session.target,
      session.width,
      session.height,
    );
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

async function startCaptureStream(
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
        session.captureInFlight = pumpCaptureStreamFrame(session).finally(
          () => {
            session.captureInFlight = null;
          },
        );
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
    sendChannel(
      sender,
      session.eventChannelId,
      captureEventJson("started", { display }),
    );
  }
  await pumpCaptureStreamFrame(session);
  return { id };
}

async function stopCaptureStream(raw: unknown) {
  const id =
    typeof raw === "string"
      ? raw
      : String((raw as { id?: unknown } | undefined)?.id ?? "");
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
  sendChannel(
    session.sender,
    session.eventChannelId,
    captureEventJson("stopped", { stats }),
  );
  return stats;
}

function resolveActiveAuthorPreviewTarget(
  streamId?: string | null,
  ensureVisible = false,
) {
  const candidates =
    streamId && streamId.length > 0
      ? [authorPreviewSessions.get(streamId)].filter(
          (session): session is AuthorPreviewSession => Boolean(session),
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

function dialogMessageType(
  kind: unknown,
): "none" | "info" | "error" | "question" | "warning" {
  if (kind === "error" || kind === "warning" || kind === "info") return kind;
  return "info";
}

function dialogButtonPlan(spec: DialogButtonSpec | null | undefined): {
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
      result: (response) =>
        response === 0 ? "Yes" : response === 1 ? "No" : "Cancel",
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
      result: (response) =>
        response === 0 ? "Yes" : response === 1 ? "No" : "Cancel",
    };
  }
  if (
    spec &&
    typeof spec === "object" &&
    "OkCustom" in spec &&
    typeof spec.OkCustom === "string"
  ) {
    return { buttons: [spec.OkCustom], result: () => "Ok" };
  }
  return { buttons: ["OK"], result: () => "Ok" };
}

async function showDialogMessage(args: unknown): Promise<string> {
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

function electronDialogFilters(filters: DialogFilterSpec[] | undefined) {
  if (!Array.isArray(filters)) return undefined;
  return filters
    .map((filter) => ({
      name: filter.name || "Files",
      extensions: Array.isArray(filter.extensions)
        ? filter.extensions
            .map((extension) => extension.replace(/^\./, ""))
            .filter(Boolean)
        : [],
    }))
    .filter((filter) => filter.extensions.length > 0);
}

async function captureRecordingFrame(session: RecordingSession): Promise<void> {
  if (session.paused) return;
  const startedAt = Date.now();
  const frameIndex = session.frameSeq + 1;
  const framePath = path.join(
    session.framesDir,
    `frame-${String(frameIndex).padStart(6, "0")}.png`,
  );
  try {
    const image = await captureRecordingNativeImage(session);
    await fs.writeFile(framePath, image.toPNG());
    session.frameSeq = frameIndex;
  } catch {
    session.framesDropped += 1;
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "frames-dropped",
      total: session.framesDropped,
      delta: 1,
    });
  } finally {
    const durationMs = Date.now() - startedAt;
    session.captureDurationMs.push(durationMs);
    if (session.captureDurationMs.length > 300)
      session.captureDurationMs.shift();
    if (durationMs > 1000 / session.effectiveFps) session.lateFrames += 1;
  }
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function queueRecordingFrame(session: RecordingSession): Promise<void> {
  if (session.captureInFlight) return session.captureInFlight;
  const capture = captureRecordingFrame(session).finally(() => {
    if (session.captureInFlight === capture) session.captureInFlight = null;
  });
  session.captureInFlight = capture;
  return capture;
}

async function captureAutomationRecordingTail(
  session: RecordingSession,
): Promise<void> {
  for (const delayMs of recordingTailFrameDelaysMs()) {
    if (recordingSessions.get(session.id) !== session) return;
    if (session.captureInFlight) await session.captureInFlight;
    if (delayMs > 0) await waitMs(delayMs);
    if (recordingSessions.get(session.id) !== session) return;
    await queueRecordingFrame(session);
  }
}

async function captureAuthorPreviewNativeImage(
  streamId: string,
  width: number,
  height: number,
): Promise<NativeImage> {
  const preview = authorSession(streamId);
  const image =
    preview.latestPaintImage ??
    (await preview.window.webContents.capturePage());
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

async function captureRecordingNativeImage(
  session: RecordingSession,
): Promise<NativeImage> {
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
  return captureTargetNativeImage(
    session.target,
    session.width,
    session.height,
  );
}

function clampDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  const rounded = Math.round(numeric);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function clampFps(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30;
  return Math.min(120, Math.max(1, Math.round(numeric)));
}

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function effectivePreviewFps(value: unknown): number {
  return Math.min(60, clampFps(value));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function recordingSettleDelayMs(command: ParsedCommand): number {
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

function ffmpegCropPlan(
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
  const clampedWidth = Math.max(
    2,
    Math.floor(Math.min(width, availableWidth) / 2) * 2,
  );
  const clampedHeight = Math.max(
    2,
    Math.floor(Math.min(height, availableHeight) / 2) * 2,
  );
  if (clampedWidth <= 0 || clampedHeight <= 0) return null;
  return {
    filter: `crop=${clampedWidth}:${clampedHeight}:${x}:${y}`,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function channelIdFrom(value: unknown): number | null {
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

function sendCallback(
  webContents: WebContents,
  id: number,
  value: unknown,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send("tauri-callback", { id, value });
}

function sendChannel(
  webContents: WebContents,
  channelId: number | null,
  message: unknown,
): void {
  if (channelId == null || webContents.isDestroyed()) return;
  const index = channelIndexes.get(channelId) ?? 0;
  channelIndexes.set(channelId, index + 1);
  sendCallback(webContents, channelId, { index, message });
}

function emitEvent(event: string, payload: unknown): void {
  for (const listener of eventListeners.values()) {
    if (listener.event !== event || listener.sender.isDestroyed()) continue;
    sendCallback(listener.sender, listener.handlerId, {
      event,
      id: listener.eventId,
      payload,
    });
  }
}

function navPayload(session: AuthorPreviewSession) {
  const contents = session.window.webContents;
  return {
    streamId: session.id,
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  };
}

function emitAuthorNav(session: AuthorPreviewSession): void {
  emitEvent(session.navEvent, navPayload(session));
}

function invalidateAuthorPreviewPaint(session: AuthorPreviewSession): void {
  session.latestPaintImage = null;
  session.latestPaintAt = null;
}

function invalidateAuthorPreviewPaintForContents(contents: WebContents): void {
  for (const session of authorPreviewSessions.values()) {
    if (
      !session.window.isDestroyed() &&
      session.window.webContents.id === contents.id
    ) {
      invalidateAuthorPreviewPaint(session);
    }
  }
}

function previewFramePayload(
  session: AuthorPreviewSession,
  image: NativeImage,
) {
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

function emitPreviewFrame(
  session: AuthorPreviewSession,
  image: NativeImage,
): void {
  const payload = previewFramePayload(session, image);
  emitEvent(session.frameEvent, payload);
  if (globalPreviewStreamSessionId === session.id) {
    emitEvent("preview://frame", payload);
  }
}

function authorSession(streamId: string): AuthorPreviewSession {
  const session = authorPreviewSessions.get(streamId);
  if (!session || session.window.isDestroyed())
    throw new Error(`author preview ${streamId} not found`);
  return session;
}

async function stopAuthorPreviewSession(streamId: string): Promise<void> {
  const session = authorPreviewSessions.get(streamId);
  if (!session) return;
  authorPreviewSessions.delete(streamId);
  if (globalPreviewStreamSessionId === streamId)
    globalPreviewStreamSessionId = null;
  void hostLog("info", "stop_author_preview", {
    stream_id: streamId,
    browser_window_id: session.window.id,
    was_destroyed: session.window.isDestroyed(),
  });
  if (!session.window.isDestroyed()) session.window.destroy();
}

async function stopAuthorPreviewsByPurpose(
  purpose: AuthorPreviewSession["purpose"],
): Promise<void> {
  const ids = [...authorPreviewSessions.values()]
    .filter((session) => session.purpose === purpose)
    .map((session) => session.id);
  await Promise.all(ids.map((id) => stopAuthorPreviewSession(id)));
}

async function startAuthorPreviewSession(
  args: Record<string, unknown>,
  sender: WebContents,
): Promise<string> {
  const id = `author-${randomUUID()}`;
  const width = clampDimension(args.viewportWidth, 1280);
  const height = clampDimension(args.viewportHeight, 800);
  const purpose = args.purpose === "recording" ? "recording" : "editor";
  const frameRate =
    purpose === "recording" ? effectivePreviewFps(args.fps) : 30;
  const rawPartition =
    typeof args.partition === "string" ? args.partition.trim() : "";
  if (rawPartition.startsWith("persist:")) {
    throw new Error("Author preview partition must be non-persistent");
  }
  const partition = rawPartition.length > 0 ? rawPartition : undefined;
  if (purpose === "recording" && !partition) {
    throw new Error(
      "Recording author preview requires an isolated non-persistent partition",
    );
  }
  if (purpose === "editor" && partition) {
    throw new Error("Editor author preview cannot use a recording partition");
  }
  const replaceExisting =
    purpose === "editor" ? args.replaceExisting !== false : false;
  if (replaceExisting) await stopAuthorPreviewsByPurpose("editor");
  const preview = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      ...(partition ? { partition } : {}),
      offscreen: true,
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
    await loadAuthorPreviewUrl(
      preview,
      initialUrl,
      purpose === "recording" ? 8_000 : 30_000,
    );
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
    offscreen: true,
    requested_fps:
      purpose === "recording" ? positiveNumber(args.fps, frameRate) : null,
    effective_fps: frameRate,
    replace_existing: replaceExisting,
    purpose,
    partition: partition ?? null,
    browser_window_id: preview.id,
    media_source_id: preview.getMediaSourceId(),
  });
  return id;
}

async function loadAuthorPreviewUrl(
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

async function startPreviewStream(): Promise<null> {
  const session = [...authorPreviewSessions.values()].find(
    (candidate) =>
      candidate.purpose === "editor" && !candidate.window.isDestroyed(),
  );
  if (!session) {
    throw new Error(
      "UnavailableOnBackend: no active Electron author preview session",
    );
  }
  globalPreviewStreamSessionId = session.id;
  const image = await session.window.webContents.capturePage();
  if (!image.isEmpty()) {
    emitEvent("preview://frame", previewFramePayload(session, image));
  }
  return null;
}

function stopPreviewStream(): null {
  globalPreviewStreamSessionId = null;
  return null;
}

function authorMouseButton(button: unknown): "left" | "right" | "middle" {
  return button === "right" || button === "middle" ? button : "left";
}

function dispatchAuthorInput(
  streamId: string,
  event: Record<string, unknown>,
): void {
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

function pickerScript(timeoutMs: number): string {
  return `
    new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('mousemove', onMove, true);
        if (hovered) hovered.style.outline = previousOutline || '';
        delete window.__storycaptureCancelPicker;
      };
      let hovered = null;
      let previousOutline = '';
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
      const onMove = (event) => {
        const el = event.target;
        if (hovered === el || !(el instanceof Element)) return;
        if (hovered) hovered.style.outline = previousOutline || '';
        hovered = el;
        previousOutline = hovered.style.outline;
        hovered.style.outline = '2px solid #39ff88';
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
            optionLabels: el.localName === 'select' ? [...el.options].map((o) => o.label || o.text) : undefined,
          },
        });
      };
      const timer = setTimeout(() => finish({ cancelled: true, reason: 'timeout' }), ${Math.max(1, timeoutMs)});
      window.__storycaptureCancelPicker = (reason = 'user-cancel') => finish({ cancelled: true, reason });
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('mousemove', onMove, true);
    })
  `;
}

async function pickerStartAuthor(
  raw: Record<string, unknown>,
): Promise<{ json: string }> {
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

async function pickerCancel(): Promise<void> {
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

function targetsPathFor(storyPath: string): string {
  return `${storyPath}.targets.json`;
}

function normalizedTargetRecord(record: unknown): unknown {
  if (!record || typeof record !== "object") return record;
  const target = record as { kind?: string; value?: unknown; nth?: unknown };
  const out: Record<string, unknown> = {
    kind: target.kind,
    value: target.value,
  };
  if (target.nth != null) out.nth = target.nth;
  return out;
}

async function pickerStampStepId(raw: Record<string, unknown>) {
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
  if (!lineHasCommand)
    throw new Error(`no command found at line ${lineOffset}`);

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
    fallbacks: Array.isArray(raw.fallbacks)
      ? raw.fallbacks.map(normalizedTargetRecord)
      : [],
  };
  const tempPath = `${targetsPath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, JSON.stringify(targets, null, 2), "utf8");
  await fs.rename(tempPath, targetsPath);
  return { step_id: stepId, was_freshly_stamped: wasFreshlyStamped };
}

async function startRecording(
  raw: unknown,
  onEvent: unknown,
  sender: WebContents,
) {
  const args = raw as {
    project_folder?: string;
    target?: CaptureTarget;
    width?: number;
    height?: number;
    fps?: number;
    audio_device_id?: string | null;
    frame_crop?: FrameCropRect | null;
  };
  if (!args.project_folder) throw new Error("project_folder required");
  const id = randomUUID();
  const eventChannelId = channelIdFrom(onEvent);
  const fps = clampFps(args.fps);
  const requestedFps = positiveNumber(args.fps, fps);
  const framesDir = path.join(
    os.tmpdir(),
    "storycapture-electron-recordings",
    id,
  );
  await fs.mkdir(framesDir, { recursive: true });
  let heartbeatSeq = 0;
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1;
    sendChannel(sender, eventChannelId, {
      type: "heartbeat",
      seq: heartbeatSeq,
    });
  }, 2000);
  heartbeat.unref?.();
  const session: RecordingSession = {
    id,
    projectFolder: args.project_folder,
    target: args.target ?? defaultCaptureTarget(),
    width: clampDimension(args.width, 1280),
    height: clampDimension(args.height, 720),
    fps,
    startedAt: Date.now(),
    paused: false,
    eventTarget: sender,
    eventChannelId,
    heartbeat,
    captureTimer: setInterval(
      () => {
        void queueRecordingFrame(session);
      },
      Math.max(1000 / fps, 16),
    ),
    framesDir,
    frameSeq: 0,
    framesDropped: 0,
    captureInFlight: null,
    audioPath: null,
    frameCrop: args.frame_crop ?? null,
    loggedAuthorPreviewFrame: false,
    requestedFps,
    effectiveFps: fps,
    lateFrames: 0,
    captureDurationMs: [],
  };
  session.captureTimer.unref?.();
  recordingSessions.set(id, session);
  await fs.mkdir(path.join(args.project_folder, EXPORTS_DIRNAME), {
    recursive: true,
  });
  await captureRecordingFrame(session);
  sendChannel(sender, eventChannelId, {
    type: "capture-status",
    json: JSON.stringify({ type: "started", session_id: id }),
  });
  return { id };
}

async function setRecordingAudio(raw: unknown): Promise<null> {
  const payload = raw as
    | { session?: { id?: unknown }; id?: unknown; bytes?: unknown }
    | undefined;
  const id = String(payload?.session?.id ?? payload?.id ?? "");
  const session = recordingSessions.get(id);
  if (!session) return null;
  const bytes = payload?.bytes;
  const buffer =
    bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : null;
  if (!buffer || buffer.byteLength === 0) return null;
  const audioPath = path.join(session.framesDir, "microphone.webm");
  await fs.writeFile(audioPath, buffer);
  session.audioPath = audioPath;
  return null;
}

function runFfmpeg(ffmpegArgs: string[]): Promise<void> {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ffmpegArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`),
      );
    });
  });
}

async function stopRecording(raw: unknown) {
  const id =
    typeof raw === "string"
      ? raw
      : String((raw as { id?: string } | undefined)?.id ?? "");
  const session = recordingSessions.get(id);
  if (!session) throw new Error(`recording session ${id} not found`);
  recordingSessions.delete(id);
  clearInterval(session.heartbeat);
  clearInterval(session.captureTimer);
  if (session.captureInFlight) await session.captureInFlight;
  if (session.frameSeq === 0) await captureRecordingFrame(session);
  if (session.frameSeq === 0) {
    await fs.rm(session.framesDir, { recursive: true, force: true });
    throw new Error("recording stopped before any capture frames were written");
  }

  const exportsDir = path.join(session.projectFolder, EXPORTS_DIRNAME);
  await fs.mkdir(exportsDir, { recursive: true });
  const durationSec = Math.max(1, (Date.now() - session.startedAt) / 1000);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputPath = path.join(exportsDir, `recording-${stamp}.mp4`);
  const inputFramerate = Math.max(0.2, session.frameSeq / durationSec).toFixed(
    3,
  );
  const ffmpegArgs = [
    "-y",
    "-framerate",
    inputFramerate,
    "-i",
    path.join(session.framesDir, "frame-%06d.png"),
  ];
  if (session.audioPath) {
    ffmpegArgs.push("-i", session.audioPath);
  }
  const cropPlan = ffmpegCropPlan(
    session.frameCrop,
    session.width,
    session.height,
  );
  const outputWidth = cropPlan?.width ?? session.width;
  const outputHeight = cropPlan?.height ?? session.height;
  const filters = [
    cropPlan?.filter,
    `scale=${outputWidth}:${outputHeight}:flags=lanczos`,
    "format=yuv420p",
  ].filter((filter): filter is string => Boolean(filter));
  ffmpegArgs.push("-r", String(session.fps), "-vf", filters.join(","));
  if (session.audioPath) {
    ffmpegArgs.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-shortest",
    );
  } else {
    ffmpegArgs.push("-an");
  }
  ffmpegArgs.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    outputPath,
  );
  await runFfmpeg(ffmpegArgs);
  await fs.rm(session.framesDir, { recursive: true, force: true });
  const stat = await fs.stat(outputPath);
  const actualCaptureFps = session.frameSeq / durationSec;
  if (actualCaptureFps < session.effectiveFps * 0.8) {
    void hostLog("warn", "recording_capture_cadence_below_target", {
      session_id: session.id,
      target_kind: session.target.kind,
      requested_fps: session.requestedFps,
      effective_fps: session.effectiveFps,
      actual_capture_fps: actualCaptureFps.toFixed(2),
      frames_written: session.frameSeq,
      frames_dropped: session.framesDropped,
      late_frames: session.lateFrames,
    });
  }
  const result = {
    output_path: outputPath,
    duration_ms: Math.round(durationSec * 1000),
    bytes: stat.size,
    frames_written: session.frameSeq,
    frames_dropped: session.framesDropped,
    requested_fps: session.requestedFps,
    effective_fps: session.effectiveFps,
    actual_capture_fps: Number(actualCaptureFps.toFixed(2)),
    late_frames: session.lateFrames,
    capture_duration_ms_p50: percentile(session.captureDurationMs, 50),
    capture_duration_ms_p95: percentile(session.captureDurationMs, 95),
  };
  sendChannel(session.eventTarget, session.eventChannelId, {
    type: "completed",
    result,
  });
  return result;
}

let screenSourceProbe: Promise<number> | null = null;

function enumerateScreenSourcesForPermission(): Promise<number> {
  screenSourceProbe ??= desktopCapturer
    .getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    })
    .then((sources) => sources.length)
    .finally(() => {
      screenSourceProbe = null;
    });
  return screenSourceProbe;
}

function screenPermissionReport(probe: boolean) {
  return screenCapturePermissionReport(
    {
      platform: process.platform,
      isPackaged: isPackagedRuntime(app),
      executablePath: process.execPath,
      fallbackAppName: app.getName(),
      debugBypassAllowed: process.env[identity.debugTccBypassEnv] === "1",
      getMediaAccessStatus: () =>
        systemPreferences.getMediaAccessStatus("screen"),
      enumerateScreenSources: enumerateScreenSourcesForPermission,
    },
    { probe },
  );
}

function getStore(rid: unknown): StoreRecord {
  if (typeof rid !== "number")
    throw new Error(`Invalid store rid: ${String(rid)}`);
  const store = stores.get(rid);
  if (!store) throw new Error(`Unknown store rid: ${rid}`);
  return store;
}

async function loadStore(storePath: string): Promise<number> {
  const existing = [...stores.entries()].find(
    ([, store]) => store.path === storePath,
  );
  if (existing) return existing[0];
  const rid = nextRid++;
  stores.set(rid, {
    path: storePath,
    data: await readJson(userDataPath("stores", storePath), {}),
    dirty: false,
  });
  return rid;
}

function normalizeFsPath(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  return decoded.startsWith("file:") ? fileURLToPath(decoded) : decoded;
}

function pathFromFsArgs(
  args: InvokeArgs,
  options?: { headers?: Record<string, string> },
): string {
  if (args && typeof args === "object" && "path" in args)
    return normalizeFsPath(String(args.path));
  const headerPath = options?.headers?.path;
  if (headerPath) return normalizeFsPath(headerPath);
  throw new Error("Missing file path");
}

function fsPathField(args: InvokeArgs, field: string): string {
  if (
    args &&
    typeof args === "object" &&
    !(args instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(args) &&
    field in args
  ) {
    return normalizeFsPath(String(args[field]));
  }
  throw new Error(`Missing file path field: ${field}`);
}

function fsInvokeOptions(
  args: InvokeArgs,
  options?: { headers?: Record<string, string> },
): Record<string, unknown> {
  if (
    args &&
    typeof args === "object" &&
    !(args instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(args) &&
    "options" in args
  ) {
    const rawOptions = args.options;
    return rawOptions && typeof rawOptions === "object"
      ? (rawOptions as Record<string, unknown>)
      : {};
  }
  const rawHeaderOptions = options?.headers?.options;
  if (!rawHeaderOptions) return {};
  try {
    const parsed = JSON.parse(rawHeaderOptions);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function nullableStatNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fileInfoFromStats(stats: Stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    size: stats.size,
    mtime: nullableStatNumber(stats.mtimeMs),
    atime: nullableStatNumber(stats.atimeMs),
    birthtime: nullableStatNumber(stats.birthtimeMs),
    readonly: (stats.mode & 0o222) === 0,
    fileAttributes: null,
    dev: nullableStatNumber(stats.dev),
    ino: nullableStatNumber(stats.ino),
    mode: nullableStatNumber(stats.mode),
    nlink: nullableStatNumber(stats.nlink),
    uid: nullableStatNumber(stats.uid),
    gid: nullableStatNumber(stats.gid),
    rdev: nullableStatNumber(stats.rdev),
    blksize: nullableStatNumber(stats.blksize),
    blocks: nullableStatNumber(stats.blocks),
  };
}

async function fsEntrySize(file: string): Promise<number> {
  const stats = await fs.stat(file);
  if (!stats.isDirectory()) return stats.size;
  const entries = await fs.readdir(file, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await fsEntrySize(path.join(file, entry.name));
  }
  return total;
}

function bufferFromUnknown(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  throw new Error("Expected byte buffer");
}

function fsResource(rid: unknown): FsResource {
  if (typeof rid !== "number")
    throw new Error(`Invalid filesystem rid: ${String(rid)}`);
  const resource = fsResources.get(rid);
  if (!resource) throw new Error(`Unknown filesystem rid: ${rid}`);
  return resource;
}

function fsFileResource(rid: unknown): FsFileResource {
  const resource = fsResource(rid);
  if (resource.kind !== "file")
    throw new Error(`Filesystem rid is not a file handle: ${String(rid)}`);
  return resource;
}

function fsOpenFlags(options: Record<string, unknown>): {
  append: boolean;
  flags: number;
  mode?: number;
} {
  const append = options.append === true;
  const write = options.write === true || append;
  const read = options.read !== false && !write ? true : options.read === true;
  const createNew = options.createNew === true;
  const create = options.create === true || createNew || append;
  const truncate = options.truncate === true;

  let flags =
    read && write
      ? fsConstants.O_RDWR
      : write
        ? fsConstants.O_WRONLY
        : fsConstants.O_RDONLY;
  if (append) flags |= fsConstants.O_APPEND;
  if (create) flags |= fsConstants.O_CREAT;
  if (createNew) flags |= fsConstants.O_EXCL;
  if (truncate) flags |= fsConstants.O_TRUNC;

  const mode = typeof options.mode === "number" ? options.mode : undefined;
  return { append, flags, mode };
}

async function openFsFile(
  file: string,
  options: Record<string, unknown>,
): Promise<number> {
  const { append, flags, mode } = fsOpenFlags(options);
  if ((flags & fsConstants.O_CREAT) === fsConstants.O_CREAT) {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  const handle = await fs.open(file, flags, mode);
  const rid = nextRid++;
  fsResources.set(rid, {
    kind: "file",
    append,
    handle,
    path: file,
    position: append ? (await handle.stat()).size : 0,
  });
  return rid;
}

function bytesWithReadCount(bytes: Buffer, bytesRead: number): number[] {
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64BE(BigInt(bytesRead), 0);
  return Array.from(Buffer.concat([bytes.subarray(0, bytesRead), trailer]));
}

function fsLineEncoding(args: InvokeArgs): BufferEncoding {
  const options = fsInvokeOptions(args);
  const encoding =
    typeof options.encoding === "string" ? options.encoding : "utf-8";
  return encoding.toLowerCase() as BufferEncoding;
}

async function closeFsResource(rid: unknown): Promise<boolean> {
  if (typeof rid !== "number")
    throw new Error(`Invalid resource rid: ${String(rid)}`);
  const resource = fsResources.get(rid);
  if (!resource) return false;
  fsResources.delete(rid);
  if (resource.kind === "file") {
    await resource.handle.close();
  } else if (resource.kind === "watcher") {
    for (const watcher of resource.watchers) watcher.close();
  }
  return true;
}

function closeShellResource(rid: unknown): boolean {
  if (typeof rid !== "number")
    throw new Error(`Invalid resource rid: ${String(rid)}`);
  const resource = shellProcesses.get(rid);
  if (!resource) return false;
  shellProcesses.delete(rid);
  if (!resource.child.killed) resource.child.kill();
  return true;
}

const LSP_COMMAND_DOCS: Record<string, string> = {
  navigate: "Open a URL in the recording browser.",
  click:
    "Click an element matched by text, role, selector, testid, aria, or label.",
  type: "Type text into a matched input.",
  hover: "Move the cursor over a matched element.",
  assert: "Assert that a matched element is present.",
  select: "Select an option in a matched control.",
  upload: "Upload a local file through a matched file input.",
  scroll: "Scroll the page in a direction.",
  wait: "Wait for a duration, such as 500ms or 2s.",
  "wait-for": "Wait until an element appears.",
  screenshot: "Capture a named screenshot checkpoint.",
  pause: "Pause the story for author review.",
};

function lspResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function lspError(id: unknown, code: number, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function lspTextDocumentUri(params: unknown): string | null {
  const textDocument = (params as { textDocument?: { uri?: unknown } } | null)
    ?.textDocument;
  return typeof textDocument?.uri === "string" ? textDocument.uri : null;
}

function lspLineText(text: string, line: number): string {
  return text.split(/\r?\n/)[Math.max(0, line)] ?? "";
}

function lspWordAt(text: string, position: LspPosition): string {
  const line = lspLineText(text, position.line);
  const at = Math.min(Math.max(0, position.character), line.length);
  const left = line.slice(0, at).match(/[a-zA-Z_-]+$/)?.[0] ?? "";
  const right = line.slice(at).match(/^[a-zA-Z_-]+/)?.[0] ?? "";
  return `${left}${right}`;
}

function lspPosition(params: unknown): LspPosition {
  const position =
    (params as { position?: Partial<LspPosition> } | null)?.position ?? {};
  return {
    line: Number.isFinite(position.line) ? Number(position.line) : 0,
    character: Number.isFinite(position.character)
      ? Number(position.character)
      : 0,
  };
}

function lspDiagnosticsFor(text: string) {
  const parsed = parseStorySource(text) as {
    diagnostics?: Array<{
      severity?: string;
      message?: string;
      span?: { line?: number; col?: number; start?: number; end?: number };
    }>;
  };
  return (parsed.diagnostics ?? []).map((diagnostic) => {
    const line = Math.max(0, Number(diagnostic.span?.line ?? 1) - 1);
    const character = Math.max(0, Number(diagnostic.span?.col ?? 1) - 1);
    const sourceLine = lspLineText(text, line);
    const endCharacter = Math.max(character + 1, sourceLine.length);
    return {
      range: {
        start: { line, character },
        end: { line, character: endCharacter },
      },
      severity: diagnostic.severity === "error" ? 1 : 2,
      source: "storycapture-electron",
      message: diagnostic.message ?? "Story syntax issue",
    };
  });
}

function publishLspDiagnostics(
  sender: WebContents,
  channelId: number | null,
  uri: string,
  text: string,
): void {
  sendChannel(sender, channelId, {
    method: "textDocument/publishDiagnostics",
    params_json: JSON.stringify({ uri, diagnostics: lspDiagnosticsFor(text) }),
  });
}

function lspCompletionItems() {
  return Object.entries(LSP_COMMAND_DOCS).map(([label, detail]) => ({
    label,
    kind: 14,
    detail,
    insertText: label,
  }));
}

function lspHoverFor(text: string, position: LspPosition) {
  const word = lspWordAt(text, position);
  const detail = LSP_COMMAND_DOCS[word];
  if (!detail) return null;
  return {
    contents: {
      kind: "markdown",
      value: `**${word}**\n\n${detail}`,
    },
  };
}

function lspInitializeResult() {
  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
      completionProvider: { triggerCharacters: [" ", "<", '"', "'"] },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    serverInfo: {
      name: "StoryCapture Electron LSP",
      version: app.getVersion(),
    },
  };
}

function lspDidOpen(
  params: unknown,
  sender: WebContents,
  channelId: number | null,
): void {
  const textDocument = (
    params as {
      textDocument?: { uri?: unknown; text?: unknown; version?: unknown };
    } | null
  )?.textDocument;
  if (typeof textDocument?.uri !== "string") return;
  const doc: LspDocument = {
    uri: textDocument.uri,
    text: typeof textDocument.text === "string" ? textDocument.text : "",
    version: Number.isFinite(textDocument.version)
      ? Number(textDocument.version)
      : 1,
  };
  lspDocuments.set(doc.uri, doc);
  publishLspDiagnostics(sender, channelId, doc.uri, doc.text);
}

function lspDidChange(
  params: unknown,
  sender: WebContents,
  channelId: number | null,
): void {
  const uri = lspTextDocumentUri(params);
  if (!uri) return;
  const changes =
    (params as { contentChanges?: Array<{ text?: unknown }> } | null)
      ?.contentChanges ?? [];
  const text =
    typeof changes.at(-1)?.text === "string"
      ? String(changes.at(-1)?.text)
      : (lspDocuments.get(uri)?.text ?? "");
  const version = Number(
    (params as { textDocument?: { version?: unknown } } | null)?.textDocument
      ?.version ??
      lspDocuments.get(uri)?.version ??
      1,
  );
  const doc = { uri, text, version };
  lspDocuments.set(uri, doc);
  publishLspDiagnostics(sender, channelId, uri, text);
}

function handleLspRequest(
  args: Record<string, unknown>,
  sender: WebContents,
): string {
  let envelope: { id?: unknown; method?: unknown; params?: unknown };
  try {
    envelope = JSON.parse(
      String(args.jsonrpcRequestJson ?? "null"),
    ) as typeof envelope;
  } catch (error) {
    return lspError(
      null,
      -32700,
      `invalid JSON-RPC envelope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const id = envelope?.id;
  const method = typeof envelope?.method === "string" ? envelope.method : "";
  const params = envelope?.params;
  const channelId = channelIdFrom(args.onNotification);

  try {
    switch (method) {
      case "initialize":
        return lspResponse(id, lspInitializeResult());
      case "initialized":
        return "null";
      case "shutdown":
        return lspResponse(id, null);
      case "textDocument/didOpen":
        lspDidOpen(params, sender, channelId);
        return "null";
      case "textDocument/didChange":
        lspDidChange(params, sender, channelId);
        return "null";
      case "textDocument/didClose": {
        const uri = lspTextDocumentUri(params);
        if (uri) lspDocuments.delete(uri);
        return "null";
      }
      case "textDocument/completion":
        return lspResponse(id, {
          isIncomplete: false,
          items: lspCompletionItems(),
        });
      case "textDocument/hover": {
        const uri = lspTextDocumentUri(params);
        const doc = uri ? lspDocuments.get(uri) : null;
        return lspResponse(
          id,
          doc ? lspHoverFor(doc.text, lspPosition(params)) : null,
        );
      }
      default:
        return id == null
          ? "null"
          : lspError(id, -32601, `method not found: ${method || "unknown"}`);
    }
  } catch (error) {
    return id == null
      ? "null"
      : lspError(
          id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
  }
}

function storyHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function storyAppUrl(source: string): string | null {
  const parsed = parseStorySource(source);
  return parsed.ast?.meta?.app ?? null;
}

function cssAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function targetSelector(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const { kind, value } = target as { kind?: string; value?: unknown };
  if (typeof value !== "string") return null;
  if (kind === "selector") return value;
  if (kind === "test_id") return `[data-testid="${cssAttributeValue(value)}"]`;
  if (kind === "aria") return `[aria-label="${cssAttributeValue(value)}"]`;
  return null;
}

async function elementCenter(
  contents: WebContents,
  target: unknown,
  targetNth?: number,
): Promise<{ x: number; y: number } | null> {
  const selector = targetSelector(target);
  return contents.executeJavaScript(
    simulatorTargetCenterScript(target, targetNth, selector),
  ) as Promise<{
    x: number;
    y: number;
  } | null>;
}

async function executeParsedCommand(
  contents: WebContents,
  command: ParsedCommand,
  projectFolder: string,
  options: { recordingMode?: boolean } = {},
): Promise<ParsedCommandResult> {
  if (command.verb === "navigate" && command.url) {
    if (sameNavigationUrl(contents.getURL(), command.url)) return {};
    await contents.loadURL(command.url);
    return {};
  }
  if (command.verb === "wait") {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(command.duration_ms ?? 0, 30_000)),
    );
    return {};
  }
  if (command.verb === "pause") return {};
  if (command.verb === "scroll") {
    const direction = command.direction ?? "down";
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error(`unsupported scroll direction: ${direction}`);
    }
    const amount = Number(command.amount ?? 1);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`invalid scroll amount: ${command.amount ?? 1}`);
    }
    const sign = direction === "up" || direction === "left" ? -1 : 1;
    contents.sendInputEvent({
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaX:
        direction === "left" || direction === "right" ? sign * 500 * amount : 0,
      deltaY:
        direction === "up" || direction === "down" ? sign * 500 * amount : 0,
    });
    return {};
  }

  const center = command.target
    ? await elementCenter(contents, command.target, command.target_nth)
    : null;
  if (
    (command.verb === "wait-for" || command.verb === "assert") &&
    command.target
  ) {
    const deadline =
      Date.now() + Math.min(Number(command.timeout_ms ?? 5_000), 30_000);
    let found = center;
    while (!found && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      found = await elementCenter(contents, command.target, command.target_nth);
    }
    if (!found)
      throw new Error(
        `target not found for ${command.verb}: ${selectorSummary(command.target)}`,
      );
    return { cursor: found };
  }
  if (
    ["click", "hover", "type", "select", "upload"].includes(command.verb) &&
    !center
  ) {
    throw new Error(
      `target not found for ${command.verb}: ${selectorSummary(command.target)}`,
    );
  }
  if ((command.verb === "click" || command.verb === "hover") && center) {
    contents.sendInputEvent({ type: "mouseMove", x: center.x, y: center.y });
    if (command.verb === "click") {
      contents.sendInputEvent({
        type: "mouseDown",
        x: center.x,
        y: center.y,
        button: "left",
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: "mouseUp",
        x: center.x,
        y: center.y,
        button: "left",
        clickCount: 1,
      });
    }
    return { cursor: center };
  }
  if ((command.verb === "type" || command.verb === "select") && center) {
    contents.sendInputEvent({
      type: "mouseDown",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    contents.sendInputEvent({
      type: "mouseUp",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    });
    const value =
      command.verb === "type" ? (command.text ?? "") : (command.value ?? "");
    const valueScript =
      command.verb === "type" && options.recordingMode
        ? setSimulatorTargetValueIncrementalScript(
            command.target,
            value,
            command.target_nth,
            targetSelector(command.target),
            35,
          )
        : setSimulatorTargetValueScript(
            command.target,
            value,
            command.target_nth,
            targetSelector(command.target),
          );
    const didWrite = await contents.executeJavaScript(valueScript);
    if (!didWrite) {
      throw new Error(
        `target is not editable for ${command.verb}: ${selectorSummary(command.target)}`,
      );
    }
    return { cursor: center };
  }
  if (command.verb === "upload") {
    throw new Error(
      "upload command is not supported by the Electron browser runner yet",
    );
  }
  if (command.verb === "screenshot") {
    const image = await contents.capturePage();
    const exportsDir = path.join(projectFolder, EXPORTS_DIRNAME);
    await fs.mkdir(exportsDir, { recursive: true });
    const safeName =
      slugify(command.name ?? `screenshot-${Date.now()}`) ||
      `screenshot-${Date.now()}`;
    const screenshotPath = path.join(exportsDir, `${safeName}.png`);
    await fs.writeFile(screenshotPath, image.toPNG());
    return { screenshotPath };
  }
  return { cursor: center };
}

async function hostLog(
  level: "info" | "warn",
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  try {
    await logFromFrontend({
      level,
      source: "electron-host",
      message,
      fields: Object.entries(fields).map(([key, value]) => [
        key,
        String(value),
      ]),
    });
  } catch {
    // Host diagnostics must never fail the browser run they describe.
  }
}

async function ensureStoryInitialUrl(
  contents: WebContents,
  storySource: string,
): Promise<void> {
  const appUrl = storyAppUrl(storySource);
  if (!appUrl || !/^https?:\/\//i.test(appUrl)) return;
  const currentUrl = contents.getURL();
  const shouldNavigate = (() => {
    if (!currentUrl || currentUrl === "about:blank") return true;
    try {
      return new URL(currentUrl).origin !== new URL(appUrl).origin;
    } catch {
      return true;
    }
  })();
  if (shouldNavigate) {
    await contents.loadURL(appUrl);
  }
}

async function writePngAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, filePath);
}

async function captureStoryFrame(
  contents: WebContents,
  frameDir: string,
  ordinal: number,
  existingPath?: string | null,
): Promise<string> {
  if (existingPath) return existingPath;
  const framePath = path.join(
    frameDir,
    `step-${String(ordinal).padStart(4, "0")}.png`,
  );
  const image = await contents.capturePage();
  if (image.isEmpty())
    throw new Error(`captured empty browser frame for step ${ordinal}`);
  await writePngAtomic(framePath, image.toPNG());
  return framePath;
}

function simulatorFrameFromResult(
  ordinal: number,
  command: ParsedCommand | undefined,
  targets: {
    version: number;
    steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
  },
  result: ParsedCommandResult,
  screenshotPath: string | null,
  durationMs: number,
): SimulatorStepFrame {
  const stepTargets = command?.step_id ? targets.steps[command.step_id] : null;
  const fallback = Array.isArray(stepTargets?.fallbacks)
    ? stepTargets.fallbacks[0]
    : null;
  const primary = stepTargets?.primary ?? command?.target ?? null;
  const matchKind = commandSupportsFallback(command)
    ? fallback
      ? "fuzzy"
      : result.cursor || primary
        ? "primary"
        : "none"
    : "none";
  return {
    ordinal,
    screenshot_path: screenshotPath,
    cursor_xy: [result.cursor?.x ?? 0, result.cursor?.y ?? 0],
    matched_selector:
      matchKind === "fuzzy"
        ? selectorSummary(fallback)
        : selectorSummary(primary),
    matched_bbox: null,
    match_kind: matchKind,
    duration_ms: durationMs,
  };
}

async function runStoryCommandsInBrowser(
  options: StoryBrowserRunOptions,
): Promise<{
  succeeded: number;
  failed: number;
  pausedOrdinal: number | null;
  exitReason: StoryBrowserRunExitReason;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const limit =
    options.stopAfter && options.stopAfter > 0
      ? Math.min(options.stopAfter, options.commands.length)
      : options.commands.length;
  let succeeded = 0;
  let failed = 0;
  let lastOrdinal = 0;
  let exitReason: StoryBrowserRunExitReason = "completed";
  await ensureStoryInitialUrl(options.contents, options.storySource);

  for (let index = 0; index < limit; index += 1) {
    const ordinal = index + 1;
    if (options.shouldCancel?.()) {
      exitReason = "cancelled";
      break;
    }
    const command = options.commands[index];
    lastOrdinal = ordinal;
    options.hooks?.onStepStarted?.(ordinal, command);
    const stepStartedAt = Date.now();
    try {
      if (options.recordingMode) {
        invalidateAuthorPreviewPaintForContents(options.contents);
      }
      const result = await executeParsedCommand(
        options.contents,
        command,
        options.projectFolder,
        {
          recordingMode: options.recordingMode,
        },
      );
      if (options.recordingMode) {
        const settleDelayMs = recordingSettleDelayMs(command);
        if (settleDelayMs > 0) await waitMs(settleDelayMs);
      }
      const durationMs = Date.now() - stepStartedAt;
      succeeded += 1;
      options.hooks?.onStepSucceeded?.(ordinal, command, result, durationMs);
      if (options.frameDir) {
        const screenshotPath = await captureStoryFrame(
          options.contents,
          options.frameDir,
          ordinal,
          result.screenshotPath,
        );
        const frame = simulatorFrameFromResult(
          ordinal,
          command,
          options.targets,
          result,
          screenshotPath,
          durationMs,
        );
        options.hooks?.onFrameCaptured?.(ordinal, frame);
      }
    } catch (error) {
      failed += 1;
      exitReason = "failed";
      options.hooks?.onStepFailed?.(ordinal, error);
      break;
    }
  }
  if (exitReason === "completed" && limit < options.commands.length) {
    exitReason = "paused";
  }

  return {
    succeeded,
    failed,
    pausedOrdinal: exitReason === "paused" ? lastOrdinal || limit : null,
    exitReason,
    durationMs: Date.now() - startedAt,
  };
}

async function launchAutomationCommand(
  args: Record<string, unknown>,
  sender: WebContents,
) {
  const onEvent = channelIdFrom(args.onEvent);
  const source = String(args.storySource ?? "");
  const projectFolder = String(args.projectFolder ?? app.getPath("userData"));
  const commands = parsedCommands(source);
  const streamId = typeof args.streamId === "string" ? args.streamId : null;
  const recordingSessionId =
    typeof args.recordingSessionId === "string"
      ? args.recordingSessionId
      : null;
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "story_started",
      story_hash: storyHash(source),
    }),
  });
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "scene_entered",
      name: "Electron preview",
      ordinal: 1,
    }),
  });
  const ownedWindow =
    streamId == null
      ? new BrowserWindow({
          show: false,
          width: 1280,
          height: 800,
          webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
          },
        })
      : null;
  const contents = streamId
    ? authorSession(streamId).window.webContents
    : ownedWindow?.webContents;
  if (!contents) throw new Error("browser session unavailable for automation");
  const targets = { version: 1, steps: {} };
  let result: Awaited<ReturnType<typeof runStoryCommandsInBrowser>>;
  try {
    result = await runStoryCommandsInBrowser({
      contents,
      commands,
      projectFolder,
      storySource: source,
      targets,
      recordingMode: Boolean(recordingSessionId),
      hooks: {
        onStepStarted: (ordinal, command) => {
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_started",
              ordinal,
              command,
              driver_used: "electron",
            }),
          });
        },
        onStepSucceeded: (ordinal, command, stepResult, durationMs) => {
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_succeeded",
              ordinal,
              step_id: command.step_id ?? null,
              duration_ms: durationMs,
              cursor_x: stepResult.cursor?.x ?? 0,
              cursor_y: stepResult.cursor?.y ?? 0,
              matched_selector: targetSelector(command.target),
              matched_bbox: null,
              match_kind: stepResult.cursor ? "primary" : "none",
            }),
          });
          if (stepResult.screenshotPath) {
            const frame = simulatorFrameFromResult(
              ordinal,
              command,
              targets,
              stepResult,
              stepResult.screenshotPath,
              durationMs,
            );
            sendChannel(sender, onEvent, {
              json: JSON.stringify({
                type: "step_frame_captured",
                ordinal,
                frame,
              }),
            });
          }
        },
        onStepFailed: (ordinal, error) => {
          sendChannel(sender, onEvent, {
            json: JSON.stringify({
              type: "step_failed",
              ordinal,
              attempts: [],
              error_message:
                error instanceof Error ? error.message : String(error),
            }),
          });
        },
      },
    });
  } finally {
    if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy();
  }
  sendChannel(sender, onEvent, {
    json: JSON.stringify({
      type: "story_ended",
      status: {
        total_steps: commands.length,
        succeeded: result.succeeded,
        failed: result.failed,
        duration_ms: result.durationMs,
      },
    }),
  });
  const recordingSession = recordingSessionId
    ? recordingSessions.get(recordingSessionId)
    : null;
  if (recordingSession) {
    clearInterval(recordingSession.captureTimer);
    await captureAutomationRecordingTail(recordingSession);
  }
  if (recordingSessionId && recordingSessions.has(recordingSessionId)) {
    await stopRecording({ id: recordingSessionId });
  }
  return null;
}

function commandSupportsFallback(command: ParsedCommand | undefined): boolean {
  return Boolean(
    command &&
    ["click", "type", "hover", "select", "upload"].includes(command.verb),
  );
}

function selectorSummary(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const target = record as { kind?: unknown; value?: unknown };
  const kind = typeof target.kind === "string" ? target.kind : "target";
  if (typeof target.value === "string") return `${kind}:${target.value}`;
  if (target.value && typeof target.value === "object") {
    const value = target.value as { role?: unknown; name?: unknown };
    if (typeof value.role === "string" && typeof value.name === "string") {
      return `${kind}:${value.role} "${value.name}"`;
    }
  }
  return kind;
}

async function readTargetsForStory(storyPath: string): Promise<{
  version: number;
  steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
}> {
  const targets = await readJson<{
    version: number;
    steps: Record<string, { primary?: unknown; fallbacks?: unknown[] }>;
  }>(targetsPathFor(storyPath), { version: 1, steps: {} });
  return { version: 1, steps: targets.steps ?? {} };
}

async function writeTargetsForStory(
  storyPath: string,
  targets: { version: number; steps: Record<string, unknown> },
): Promise<void> {
  const targetsPath = targetsPathFor(storyPath);
  const tempPath = `${targetsPath}.tmp.${process.pid}`;
  await fs.writeFile(
    tempPath,
    JSON.stringify({ ...targets, version: 1 }, null, 2),
    "utf8",
  );
  await fs.rename(tempPath, targetsPath);
}

async function simulatorStartCommand(
  args: Record<string, unknown>,
  sender: WebContents,
): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  const channelId = channelIdFrom(args.channel);
  const storyPath = String(args.storyPath ?? "");
  const storySource = String(args.storySource ?? "");
  const streamId = String(args.streamId ?? "");
  const commands = parsedCommands(storySource);
  const totalSteps = commands.length;
  const frames = new Map<number, SimulatorStepFrame>();
  simulatorSessions.set(id, {
    id,
    sender,
    channelId,
    storyPath,
    commands,
    frames,
    totalSteps,
    cancelled: false,
  });
  sendChannel(sender, channelId, {
    type: "started",
    session_id: id,
    run_id: runId,
    total_steps: totalSteps,
  });
  const stopAfter = Number(args.stopAfterOrdinal ?? 0);
  const targets = storyPath
    ? await readTargetsForStory(storyPath)
    : { version: 1, steps: {} };
  const session = simulatorSessions.get(id);
  const preview = streamId ? authorPreviewSessions.get(streamId) : null;
  if (!session || !preview || preview.window.isDestroyed()) {
    const message = streamId
      ? `author preview ${streamId} not found for simulator run`
      : "author preview stream id is required for simulator run";
    void hostLog("warn", "simulator_start failed", {
      stream_id: streamId || "missing",
      story_path: storyPath,
      command_count: totalSteps,
      reason: message,
    });
    sendChannel(sender, channelId, {
      type: "failed",
      ordinal: 1,
      error_message: message,
    });
    return id;
  }

  const frameDir = path.join(userDataPath("simulator-runs"), runId, "frames");
  await fs.mkdir(frameDir, { recursive: true });
  void hostLog("info", "simulator_start", {
    stream_id: streamId,
    story_path: storyPath,
    command_count: totalSteps,
    app_url: storyAppUrl(storySource) ?? "",
    browser_window_id: preview.window.id,
    frame_dir: frameDir,
  });
  const result = await runStoryCommandsInBrowser({
    contents: preview.window.webContents,
    commands,
    projectFolder: String(args.projectFolder ?? app.getPath("userData")),
    storySource,
    targets,
    stopAfter,
    frameDir,
    shouldCancel: () =>
      !simulatorSessions.has(id) ||
      Boolean(simulatorSessions.get(id)?.cancelled),
    hooks: {
      onStepStarted: (ordinal) => {
        sendChannel(sender, channelId, { type: "step_started", ordinal });
      },
      onFrameCaptured: (ordinal, frame) => {
        const current = simulatorSessions.get(id);
        if (current) current.frames.set(ordinal, frame);
        sendChannel(sender, channelId, {
          type: "frame_captured",
          ordinal,
          frame,
        });
        void hostLog("info", "frame_captured", {
          run_id: runId,
          ordinal,
          screenshot_path: frame.screenshot_path ?? "",
        });
      },
      onStepFailed: (ordinal, error) => {
        sendChannel(sender, channelId, {
          type: "failed",
          ordinal,
          error_message: error instanceof Error ? error.message : String(error),
        });
      },
    },
  });
  if (result.exitReason === "cancelled") {
    return id;
  }
  if (result.pausedOrdinal != null && result.failed === 0) {
    sendChannel(sender, channelId, {
      type: "paused",
      ordinal: result.pausedOrdinal,
    });
  } else if (result.failed === 0) {
    sendChannel(sender, channelId, {
      type: "completed",
      succeeded: result.succeeded,
      failed: result.failed,
    });
  } else {
    void hostLog("warn", "simulator_start failed during command execution", {
      stream_id: streamId,
      story_path: storyPath,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  }
  return id;
}

async function simulatorPromoteFallback(
  sessionId: string,
  ordinal: number,
): Promise<null> {
  const session = simulatorSessions.get(sessionId);
  if (!session) throw new Error(`simulator session ${sessionId} not found`);
  const frame = session.frames.get(ordinal);
  if (!frame) throw new Error(`no captured frame for ordinal ${ordinal}`);
  if (frame.match_kind !== "fuzzy") {
    throw new Error("promote-to-fallback is only valid on fuzzy matches");
  }

  const command = session.commands[ordinal - 1];
  if (!commandSupportsFallback(command)) {
    throw new Error("command has no selector target - cannot promote");
  }
  if (!command.step_id) {
    throw new Error("command has no step_id - cannot promote");
  }
  if (!session.storyPath) {
    throw new Error("storyPath is required to promote fallback");
  }

  const targets = await readTargetsForStory(session.storyPath);
  const stepTargets = targets.steps[command.step_id];
  const [promoted, ...remainingFallbacks] = Array.isArray(
    stepTargets?.fallbacks,
  )
    ? stepTargets.fallbacks
    : [];
  if (!stepTargets?.primary || !promoted) {
    throw new Error(`no fallback target recorded for step ${command.step_id}`);
  }

  targets.steps[command.step_id] = {
    primary: normalizedTargetRecord(promoted),
    fallbacks: [
      normalizedTargetRecord(stepTargets.primary),
      ...remainingFallbacks.map(normalizedTargetRecord),
    ],
  };
  await writeTargetsForStory(session.storyPath, targets);
  session.frames.set(ordinal, {
    ...frame,
    match_kind: "primary",
    matched_selector: selectorSummary(promoted),
  });
  return null;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

function dryRunStep(raw: unknown, index: number): DryRunStep {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const stepArgs =
    record.args && typeof record.args === "object"
      ? (record.args as Record<string, unknown>)
      : {};
  return {
    id: String(record.id ?? `step-${index + 1}`),
    verb: String(record.verb ?? "step"),
    target: nullableString(
      record.target ?? stepArgs.target ?? stepArgs.selector ?? stepArgs.url,
    ),
    value: nullableString(record.value ?? stepArgs.value ?? stepArgs.text),
  };
}

function dryRunChannelId(args: Record<string, unknown>): number | null {
  return channelIdFrom(args.channel) ?? channelIdFrom(args.onEvent);
}

function sendDryRunSummary(session: DryRunSession): void {
  sendChannel(session.sender, session.channelId, {
    kind: "Summary",
    summary: {
      total: session.steps.length,
      passed: session.passed,
      failed: session.failed,
      totalMs: session.totalMs,
    },
  });
}

function scheduleDryRunStep(session: DryRunSession): void {
  if (session.cancelled || session.sender.isDestroyed()) {
    dryRunSessions.delete(session.id);
    return;
  }
  if (session.index >= session.steps.length) {
    sendDryRunSummary(session);
    dryRunSessions.delete(session.id);
    return;
  }

  const step = session.steps[session.index];
  const started = Date.now();
  sendChannel(session.sender, session.channelId, {
    kind: "Running",
    step_id: step.id,
  });
  session.timer = setTimeout(() => {
    const current = dryRunSessions.get(session.id);
    if (!current || current.cancelled) return;
    const durationMs = Math.max(1, Date.now() - started);
    current.totalMs += durationMs;
    current.passed += 1;
    sendChannel(current.sender, current.channelId, {
      kind: "Pass",
      step_id: step.id,
      duration_ms: durationMs,
      fallback_chain: [],
    });
    current.index += 1;
    scheduleDryRunStep(current);
  }, 25);
  session.timer.unref?.();
}

function dryRunStart(
  args: Record<string, unknown>,
  sender: WebContents,
): string {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (rawSteps.length === 0) {
    throw new Error("dry-run requires at least one step");
  }

  const id = randomUUID();
  const steps = rawSteps.map(dryRunStep);
  const session: DryRunSession = {
    id,
    sender,
    channelId: dryRunChannelId(args),
    steps,
    index: 0,
    passed: 0,
    failed: 0,
    totalMs: 0,
    timer: null,
    cancelled: false,
  };
  dryRunSessions.set(id, session);
  for (const step of steps) {
    sendChannel(sender, session.channelId, {
      kind: "Queued",
      step_id: step.id,
    });
  }
  scheduleDryRunStep(session);
  return id;
}

function dryRunCancel(taskId: string): null {
  const session = dryRunSessions.get(taskId);
  if (!session) return null;
  session.cancelled = true;
  if (session.timer) clearTimeout(session.timer);
  for (let index = session.index; index < session.steps.length; index += 1) {
    sendChannel(session.sender, session.channelId, {
      kind: "Skipped",
      step_id: session.steps[index].id,
    });
  }
  sendDryRunSummary(session);
  dryRunSessions.delete(taskId);
  return null;
}

export async function handleLegacyInvoke(
  event: IpcMainInvokeEvent,
  { cmd, args, options }: InvokeEnvelope,
): Promise<unknown> {
  switch (cmd) {
    case "list_audio_inputs":
      return listAudioInputs(event.sender);
    case "probe_hw_encoders":
    case "refresh_hw_encoders":
      return {
        available: ["software"],
        preferred: "software",
        encoders: [
          { encoder: "software", available: true, fallback_reason: null },
        ],
      };
    case "start_recording":
      return startRecording(
        (args as { args?: unknown } | undefined)?.args,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        event.sender,
      );
    case "electron_recording_set_audio":
      return setRecordingAudio(args);
    case "stop_recording":
      return stopRecording(
        (args as { session?: { id?: string } | undefined } | undefined)
          ?.session,
      );
    case "pause_recording": {
      const id = String(
        (args as { session?: { id?: string } } | undefined)?.session?.id ?? "",
      );
      const session = recordingSessions.get(id);
      if (session) session.paused = true;
      return null;
    }
    case "resume_recording": {
      const id = String(
        (args as { session?: { id?: string } } | undefined)?.session?.id ?? "",
      );
      const session = recordingSessions.get(id);
      if (session) session.paused = false;
      return null;
    }
    case "launch_automation":
      return launchAutomationCommand(
        (args ?? {}) as Record<string, unknown>,
        event.sender,
      );
    case "start_preview_stream":
      return startPreviewStream();
    case "stop_preview_stream":
      return stopPreviewStream();
    case "start_author_preview":
      return startAuthorPreviewSession(
        (args ?? {}) as Record<string, unknown>,
        event.sender,
      );
    case "stop_author_preview":
      return stopAuthorPreviewSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      );
    case "pause_author_preview":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).paused = true;
      return null;
    case "resume_author_preview":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).paused = false;
      return null;
    case "set_author_preview_viewport": {
      const payload = args as
        | { streamId?: string; args?: { width?: number; height?: number } }
        | undefined;
      const session = authorSession(String(payload?.streamId ?? ""));
      session.window.setContentSize(
        clampDimension(payload?.args?.width, 1280),
        clampDimension(payload?.args?.height, 800),
      );
      return null;
    }
    case "set_author_preview_url": {
      const payload = args as { streamId?: string; url?: string } | undefined;
      const url = String(payload?.url ?? "about:blank");
      await authorSession(String(payload?.streamId ?? "")).window.loadURL(url);
      return null;
    }
    case "author_preview_back":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.navigationHistory.goBack();
      return null;
    case "author_preview_forward":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.navigationHistory.goForward();
      return null;
    case "author_preview_reload":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.reload();
      return null;
    case "attach_author_driver":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      );
      return null;
    case "author_dispatch_input":
      dispatchAuthorInput(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
        ((args as { event?: Record<string, unknown> } | undefined)?.event ??
          {}) as Record<string, unknown>,
      );
      return null;
    case "picker_start_author":
      return pickerStartAuthor((args ?? {}) as Record<string, unknown>);
    case "picker_start": {
      const first = authorPreviewSessions.keys().next().value as
        | string
        | undefined;
      if (!first)
        return {
          json: JSON.stringify({
            cancelled: true,
            reason: "no-author-preview",
          }),
        };
      return pickerStartAuthor({
        ...(args as Record<string, unknown> | undefined),
        streamId: first,
      });
    }
    case "picker_cancel":
      return pickerCancel();
    case "picker_is_active":
      return activePickerStreams.size > 0;
    case "picker_stamp_step_id":
      return pickerStampStepId((args ?? {}) as Record<string, unknown>);
    case "simulator_start":
      return simulatorStartCommand(
        (args ?? {}) as Record<string, unknown>,
        event.sender,
      );
    case "simulator_step_to":
      return null;
    case "simulator_cancel": {
      const id = String(
        (args as { sessionId?: string } | undefined)?.sessionId ?? "",
      );
      const session = simulatorSessions.get(id);
      if (session) {
        session.cancelled = true;
        sendChannel(session.sender, session.channelId, { type: "cancelled" });
        simulatorSessions.delete(id);
      }
      return null;
    }
    case "simulator_promote_fallback":
      return simulatorPromoteFallback(
        String((args as { sessionId?: unknown } | undefined)?.sessionId ?? ""),
        Number((args as { ordinal?: unknown } | undefined)?.ordinal ?? 0),
      );
    case "render_enqueue":
      return renderEnqueue((args as { job?: unknown } | undefined)?.job);
    case "render_cancel":
      return renderCancel(
        String((args as { jobId?: unknown } | undefined)?.jobId ?? ""),
      );
    case "render_list_active":
      return renderListActive(
        String((args as { storyId?: unknown } | undefined)?.storyId ?? ""),
      );
    case "stream_render_progress":
      return streamRenderProgress(args, event.sender);
    case "key_get_presence":
      return keyGetPresence(
        providerId((args as { provider?: unknown } | undefined)?.provider),
      );
    case "key_set":
      return keySet(
        providerId((args as { provider?: unknown } | undefined)?.provider),
        String((args as { key?: unknown } | undefined)?.key ?? ""),
      );
    case "key_delete":
      return keyDelete(
        providerId((args as { provider?: unknown } | undefined)?.provider),
      );
    case "key_test":
      return keyTest(
        providerId((args as { provider?: unknown } | undefined)?.provider),
      );
    case "get_web_account":
      return getWebAccount();
    case "get_web_api_token":
      return getWebApiToken();
    case "get_sync_status":
      return getSyncStatus();
    case "get_upload_status":
      return uploadStatus;
    case "start_web_oauth":
      return startWebOauth();
    case "complete_web_oauth":
      return completeWebOauth();
    case "disconnect_web_account":
      return disconnectWebAccount();
    case "sync_project_metadata":
      return syncProjectMetadata((args ?? {}) as Record<string, unknown>);
    case "flush_sync_queue":
      return flushSyncQueue();
    case "upload_video":
      return uploadVideoWithStatus(
        (args ?? {}) as Record<string, unknown>,
        event.sender,
      );
    case "cancel_upload":
      return cancelUpload();
    case "update_recording_status":
      return updateRecordingStatus((args ?? {}) as Record<string, unknown>);
    case "author_snapshot_list":
      return authorSnapshotList(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)
            ?.projectDir ??
            (
              args as
                | { projectDir?: unknown; project_dir?: unknown }
                | undefined
            )?.project_dir ??
            "",
        ),
      );
    case "author_snapshot_get":
      return authorSnapshotGet(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)
            ?.projectDir ??
            (
              args as
                | { projectDir?: unknown; project_dir?: unknown }
                | undefined
            )?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
      );
    case "author_snapshot_capture":
      return authorSnapshotCapture(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)
            ?.projectDir ??
            (
              args as
                | { projectDir?: unknown; project_dir?: unknown }
                | undefined
            )?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
      );
    case "author_snapshot_validate":
      return authorSnapshotValidate(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)
            ?.projectDir ??
            (
              args as
                | { projectDir?: unknown; project_dir?: unknown }
                | undefined
            )?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
        (args as { target?: unknown } | undefined)?.target,
      );
    case "dryrun_start":
      return dryRunStart((args ?? {}) as Record<string, unknown>, event.sender);
    case "dryrun_cancel":
      return dryRunCancel(
        String((args as { taskId?: unknown } | undefined)?.taskId ?? ""),
      );
    case "lsp_request":
      return handleLspRequest(
        (args ?? {}) as Record<string, unknown>,
        event.sender,
      );
    case "nl_get_session_id":
      return sessionId;
    case "nl_load_history":
      return [];
    case "nl_chat_send":
      return nlProviderUnavailable(
        (args as { providerOverride?: unknown } | undefined)?.providerOverride,
      );
    case "nl_cancel":
    case "nl_diff_apply":
    case "nl_diff_reject":
      return null;
    case "nl_regen_step":
      return nlProviderUnavailable("anthropic");
    case "session_get_rollup":
      return emptySessionRollup();
    case "tts_voice_list":
      return listTtsVoices(
        (args as { provider?: unknown } | undefined)?.provider,
      );
    case "tts_generate":
    case "tts_regenerate_clip":
      return ttsProviderUnavailable(
        (args as { provider?: unknown } | undefined)?.provider,
      );
    case "tts_apply_sync":
      return ttsApplySyncWithoutCachedClips(
        (args as { stepTimings?: unknown } | undefined)?.stepTimings,
      );
    case "tts_gc_cache":
      return 0;
    case "list_projects":
      return readProjects();
    case "create_project":
      return createProject((args as { args?: unknown } | undefined)?.args);
    case "open_project":
      return openProject(
        String(
          (args as { args?: { id?: string } } | undefined)?.args?.id ?? "",
        ),
      );
    case "remove_project":
      return removeProject(
        String(
          (args as { args?: { id?: string } } | undefined)?.args?.id ?? "",
        ),
      );
    case "get_project_workflow":
      return getProjectWorkflow(
        String(
          (args as { args?: { id?: string } } | undefined)?.args?.id ?? "",
        ),
      );
    case "update_project_workflow": {
      const payload = (
        args as
          | { args?: { id?: string; workflow_state?: WorkflowState } }
          | undefined
      )?.args;
      if (!payload?.workflow_state) throw new Error("workflow_state required");
      return updateProjectWorkflow(
        String(payload.id ?? ""),
        payload.workflow_state,
      );
    }
    case "list_project_recordings":
      return listProjectRecordings(
        String(
          (args as { args?: { id?: string } } | undefined)?.args?.id ?? "",
        ),
      );
    case "timeline_load":
      return timelineLoad(
        String((args as { storyId?: string } | undefined)?.storyId ?? ""),
      );
    case "timeline_save": {
      const payload = args as
        | { storyId?: string; layoutJson?: string }
        | undefined;
      await timelineSave(
        String(payload?.storyId ?? ""),
        String(payload?.layoutJson ?? ""),
      );
      return null;
    }
    case "get_recording_actions":
      return readRecordingSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args
            ?.recording_path ?? "",
        ),
        "actions",
      );
    case "get_recording_trajectory":
      return readRecordingSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args
            ?.recording_path ?? "",
        ),
        "trajectory",
      );
    case "get_recording_step_timing":
      return readRecordingSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args
            ?.recording_path ?? "",
        ),
        "steps",
      );
    case "preset_list":
      return readPresets(
        String((args as { scope?: string } | undefined)?.scope ?? "project"),
      );
    case "preset_import":
      return presetImport(
        String((args as { path?: string } | undefined)?.path ?? ""),
        String((args as { scope?: string } | undefined)?.scope ?? "project"),
      );
    case "preset_export":
      return presetExport(
        String((args as { id?: string } | undefined)?.id ?? ""),
        String((args as { out?: string } | undefined)?.out ?? ""),
      );
    case "sound_library_list":
      return [];
    case "export_get_presets":
      return exportPresetsCatalogue();
    case "export_validate_config":
      validateExportOutput(
        (args as { cfg?: ExportOutput } | undefined)?.cfg ??
          ({} as ExportOutput),
      );
      return null;
    case "export_run":
      return exportRun(
        (args as { args?: ExportRunArgs } | undefined)?.args ??
          ({} as ExportRunArgs),
      );
    case "list_displays":
      return displayInfo();
    case "list_windows":
      return windowInfo();
    case "list_capture_targets":
      return {
        displays: displayInfo(),
        windows: await windowInfo(),
        playwright_auto_available: false,
      };
    case "get_capture_target":
      return readJson<CaptureTarget | null>(captureTargetPath(), null);
    case "set_capture_target":
      if (
        isAuthorPreviewTarget(
          (args as { target?: CaptureTarget } | undefined)?.target,
        )
      ) {
        throw new Error(
          "author_preview cannot be persisted as a capture target",
        );
      }
      await writeJson(
        captureTargetPath(),
        (args as { target?: CaptureTarget } | undefined)?.target ?? null,
      );
      return null;
    case "capture_target_thumbnail": {
      const payload = args as
        | { target?: CaptureTarget; maxWidth?: number; maxHeight?: number }
        | undefined;
      if (!payload?.target) throw new Error("target required");
      return captureTargetThumbnail(
        payload.target,
        payload.maxWidth ?? 320,
        payload.maxHeight ?? 180,
      );
    }
    case "check_screen_capture_permission":
      return screenPermissionReport(false);
    case "request_screen_capture_access":
      return screenPermissionReport(true);
    case "open_screen_capture_prefs":
      if (process.platform === "darwin") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
      }
      return null;
    case "relaunch_app":
      if (isDevRuntime(app)) {
        app.exit(DEV_RELAUNCH_EXIT_CODE);
      } else {
        app.relaunch();
        app.exit(0);
      }
      return null;
    case "resolve_playwright_target":
      return resolveActiveAuthorPreviewTarget(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
        Boolean(
          (args as { ensureVisible?: boolean } | undefined)?.ensureVisible,
        ),
      );
    case "is_stage_manager_enabled":
      return false;
    case "start_capture":
      return startCaptureStream(
        (args as { cfg?: unknown } | undefined)?.cfg,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        (args as { onFrame?: unknown } | undefined)?.onFrame,
        event.sender,
      );
    case "start_capture_target":
      return startCaptureStream(
        (args as { args?: unknown } | undefined)?.args,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        (args as { onFrame?: unknown } | undefined)?.onFrame,
        event.sender,
      );
    case "stop_capture":
      return stopCaptureStream(
        (args as { session?: unknown } | undefined)?.session,
      );
    case "plugin:dialog|open": {
      const openOptions = (args as { options?: OpenDialogSpec }).options;
      const result = await dialog.showOpenDialog({
        title: openOptions?.title,
        defaultPath: openOptions?.defaultPath,
        filters: electronDialogFilters(openOptions?.filters),
        properties: [
          openOptions?.directory ? "openDirectory" : "openFile",
          openOptions?.multiple ? "multiSelections" : undefined,
          openOptions?.canCreateDirectories ? "createDirectory" : undefined,
        ].filter(
          (
            property,
          ): property is
            | "openDirectory"
            | "openFile"
            | "multiSelections"
            | "createDirectory" =>
            property === "openDirectory" ||
            property === "openFile" ||
            property === "multiSelections" ||
            property === "createDirectory",
        ),
      });
      if (result.canceled) return null;
      return openOptions?.multiple
        ? result.filePaths
        : (result.filePaths[0] ?? null);
    }
    case "plugin:dialog|save": {
      const saveOptions = (args as { options?: SaveDialogSpec }).options;
      const result = await dialog.showSaveDialog({
        title: saveOptions?.title,
        defaultPath: saveOptions?.defaultPath,
        filters: electronDialogFilters(saveOptions?.filters),
        properties: [
          saveOptions?.canCreateDirectories ? "createDirectory" : undefined,
        ].filter(
          (property): property is "createDirectory" =>
            property === "createDirectory",
        ),
      });
      return result.canceled ? null : (result.filePath ?? null);
    }
    case "plugin:dialog|message":
      return showDialogMessage(args);
    case "plugin:event|listen": {
      const payload = args as { event?: string; handler?: number } | undefined;
      const eventId = nextEventId++;
      const handlerId = Number(payload?.handler);
      if (!payload?.event || !Number.isFinite(handlerId)) {
        throw new Error("event listener requires event and handler");
      }
      eventListeners.set(eventId, {
        event: payload.event,
        eventId,
        handlerId,
        sender: event.sender,
      });
      return eventId;
    }
    case "plugin:event|unlisten":
      eventListeners.delete(
        Number((args as { eventId?: unknown } | undefined)?.eventId),
      );
      return null;
    case "plugin:event|emit":
      emitEvent(
        String((args as { event?: string } | undefined)?.event ?? ""),
        (args as { payload?: unknown } | undefined)?.payload,
      );
      return null;
    case "plugin:event|emit_to":
      emitEvent(
        String((args as { event?: string } | undefined)?.event ?? ""),
        (args as { payload?: unknown } | undefined)?.payload,
      );
      return null;
    case "plugin:resources|close": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      if (await closeFsResource(rid)) return null;
      if (closeShellResource(rid)) return null;
      if (typeof rid === "number" && updaterResources.delete(rid)) return null;
      if (typeof rid === "number" && stores.has(rid)) {
        stores.delete(rid);
        return null;
      }
      return null;
    }
    case "plugin:log|log": {
      const payload = args as
        | {
            level?: unknown;
            message?: unknown;
            location?: unknown;
            file?: unknown;
            line?: unknown;
            keyValues?: unknown;
          }
        | undefined;
      return logFromFrontend({
        level: pluginLogLevel(payload?.level),
        message: String(payload?.message ?? ""),
        source: typeof payload?.file === "string" ? payload.file : "plugin-log",
        fields: [
          ["location", String(payload?.location ?? "")],
          ["line", String(payload?.line ?? "")],
          ["keyValues", JSON.stringify(payload?.keyValues ?? null)],
        ],
      });
    }
    case "plugin:os|locale":
      return (
        app.getLocale() ||
        Intl.DateTimeFormat().resolvedOptions().locale ||
        null
      );
    case "plugin:os|hostname":
      return os.hostname();
    case "plugin:process|restart":
      app.relaunch();
      app.exit(0);
      return null;
    case "plugin:process|exit":
      app.exit(Number((args as { code?: unknown } | undefined)?.code ?? 0));
      return null;
    case "plugin:updater|check": {
      const update = await checkElectronUpdate();
      const pendingUpdateInfo = getPendingUpdateInfo();
      return pendingUpdateInfo && update
        ? updaterMetadata(pendingUpdateInfo)
        : null;
    }
    case "plugin:updater|download": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      if (typeof rid !== "number" || !updaterResources.has(rid))
        throw new Error("unknown update resource");
      const bytesRid = nextRid++;
      updaterResources.add(bytesRid);
      if (app.isPackaged || process.env.STORYCAPTURE_DEBUG_UPDATER) {
        const channelId = channelIdFrom(
          (args as { onEvent?: unknown } | undefined)?.onEvent,
        );
        sendChannel(event.sender, channelId, { event: "Started" });
        await autoUpdater.downloadUpdate();
        sendChannel(event.sender, channelId, { event: "Finished" });
      }
      return bytesRid;
    }
    case "plugin:updater|install":
      return installElectronUpdate();
    case "plugin:updater|download_and_install": {
      const channelId = channelIdFrom(
        (args as { onEvent?: unknown } | undefined)?.onEvent,
      );
      sendChannel(event.sender, channelId, { event: "Started" });
      await installElectronUpdate();
      sendChannel(event.sender, channelId, { event: "Finished" });
      return null;
    }
    case "plugin:window-state|filename":
      return windowStatePath();
    case "plugin:window-state|save_window_state":
      await saveElectronWindowState();
      return null;
    case "plugin:window-state|restore_state":
      await restoreElectronWindowState();
      return null;
    case "plugin:shell|open": {
      const target = String(
        (args as { path?: unknown } | undefined)?.path ?? "",
      );
      if (!target) throw new Error("shell.open requires a path");
      const result = /^[a-z][a-z0-9+.-]*:/i.test(target)
        ? await shell.openExternal(target)
        : await shell.openPath(target);
      if (result) throw new Error(result);
      return null;
    }
    case "plugin:shell|execute": {
      const payload = args as
        | { program?: unknown; args?: unknown; options?: unknown }
        | undefined;
      const program = String(payload?.program ?? "");
      if (!program) throw new Error("shell.execute requires a program");
      const options = shellOptions(payload?.options);
      return new Promise((resolve, reject) => {
        const child = spawn(program, shellArgs(payload?.args), {
          cwd: options.cwd,
          env: options.env,
          shell: false,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolve({
            code,
            signal: shellSignal(signal),
            stdout: Buffer.concat(stdout).toString(options.encoding),
            stderr: Buffer.concat(stderr).toString(options.encoding),
          });
        });
      });
    }
    case "plugin:shell|spawn": {
      const payload = args as
        | {
            program?: unknown;
            args?: unknown;
            options?: unknown;
            onEvent?: unknown;
          }
        | undefined;
      const program = String(payload?.program ?? "");
      if (!program) throw new Error("shell.spawn requires a program");
      const options = shellOptions(payload?.options);
      const child = spawn(program, shellArgs(payload?.args), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
      });
      const pid = child.pid ?? nextRid++;
      shellProcesses.set(pid, { child });
      const channelId = channelIdFrom(payload?.onEvent);
      child.stdout.on("data", (chunk: Buffer) => {
        sendChannel(event.sender, channelId, {
          event: "Stdout",
          payload: chunk.toString(options.encoding),
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        sendChannel(event.sender, channelId, {
          event: "Stderr",
          payload: chunk.toString(options.encoding),
        });
      });
      child.on("error", (error) => {
        sendChannel(event.sender, channelId, {
          event: "Error",
          payload: error.message,
        });
      });
      child.on("close", (code, signal) => {
        shellProcesses.delete(pid);
        sendChannel(event.sender, channelId, {
          event: "Terminated",
          payload: { code, signal: shellSignal(signal) },
        });
      });
      return pid;
    }
    case "plugin:shell|stdin_write": {
      const payload = args as { pid?: unknown; buffer?: unknown } | undefined;
      const child = shellProcesses.get(Number(payload?.pid))?.child;
      if (!child) throw new Error("unknown shell process");
      child.stdin.write(bufferFromUnknown(payload?.buffer));
      return null;
    }
    case "plugin:shell|kill": {
      const child = shellProcesses.get(
        Number((args as { pid?: unknown } | undefined)?.pid),
      )?.child;
      if (!child) throw new Error("unknown shell process");
      child.kill();
      return null;
    }
    case "plugin:store|load": {
      const storePath = (args as { path?: string } | undefined)?.path;
      if (!storePath) throw new Error("Missing store path");
      return loadStore(storePath);
    }
    case "plugin:store|get_store": {
      const storePath = (args as { path?: string } | undefined)?.path;
      if (!storePath) return null;
      const existing = [...stores.entries()].find(
        ([, store]) => store.path === storePath,
      );
      return existing?.[0] ?? null;
    }
    case "plugin:store|get": {
      const store = getStore((args as { rid?: unknown }).rid);
      const key = String((args as { key?: unknown }).key);
      if (!Object.hasOwn(store.data, key)) return [null, false];
      return [store.data[key], true];
    }
    case "plugin:store|set": {
      const store = getStore((args as { rid?: unknown }).rid);
      store.data[String((args as { key?: unknown }).key)] = (
        args as { value?: unknown }
      ).value;
      store.dirty = true;
      return null;
    }
    case "plugin:store|save": {
      const store = getStore((args as { rid?: unknown }).rid);
      if (store.dirty)
        await writeJson(userDataPath("stores", store.path), store.data);
      store.dirty = false;
      return null;
    }
    case "plugin:store|has": {
      const store = getStore((args as { rid?: unknown }).rid);
      return Object.hasOwn(store.data, String((args as { key?: unknown }).key));
    }
    case "plugin:store|delete": {
      const store = getStore((args as { rid?: unknown }).rid);
      delete store.data[String((args as { key?: unknown }).key)];
      store.dirty = true;
      return null;
    }
    case "plugin:store|clear":
    case "plugin:store|reset": {
      const store = getStore((args as { rid?: unknown }).rid);
      store.data = {};
      store.dirty = true;
      return null;
    }
    case "plugin:store|keys":
      return Object.keys(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|values":
      return Object.values(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|entries":
      return Object.entries(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|length":
      return Object.keys(getStore((args as { rid?: unknown }).rid).data).length;
    case "plugin:store|reload":
      return null;
    case "plugin:fs|create": {
      const file = pathFromFsArgs(args, options);
      return openFsFile(file, { write: true, create: true, truncate: true });
    }
    case "plugin:fs|open": {
      const file = pathFromFsArgs(args, options);
      return openFsFile(file, fsInvokeOptions(args, options));
    }
    case "plugin:fs|mkdir": {
      const file = pathFromFsArgs(args, options);
      const invokeOptions = fsInvokeOptions(args, options);
      await fs.mkdir(file, { recursive: invokeOptions.recursive !== false });
      return null;
    }
    case "plugin:fs|copy_file": {
      const fromPath = fsPathField(args, "fromPath");
      const toPath = fsPathField(args, "toPath");
      await fs.mkdir(path.dirname(toPath), { recursive: true });
      await fs.copyFile(fromPath, toPath);
      return null;
    }
    case "plugin:fs|read_dir": {
      const entries = await fs.readdir(pathFromFsArgs(args, options), {
        withFileTypes: true,
      });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
      }));
    }
    case "plugin:fs|read_text_file":
      return Array.from(await fs.readFile(pathFromFsArgs(args, options)));
    case "plugin:fs|read_file":
      return Array.from(await fs.readFile(pathFromFsArgs(args, options)));
    case "plugin:fs|read_text_file_lines": {
      const file = pathFromFsArgs(args, options);
      const encoding = fsLineEncoding(args);
      const contents = await fs.readFile(file, { encoding });
      const lines = contents.split(/\r\n|\n|\r/);
      if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/.test(contents)) lines.pop();
      const rid = nextRid++;
      fsResources.set(rid, { kind: "lines", encoding, index: 0, lines });
      return rid;
    }
    case "plugin:fs|read_text_file_lines_next": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      const resource = fsResource(rid);
      if (resource.kind !== "lines") {
        throw new Error(
          `Filesystem rid is not a line iterator: ${String(rid)}`,
        );
      }
      if (resource.index >= resource.lines.length) {
        if (typeof rid === "number") fsResources.delete(rid);
        return [1];
      }
      const encoded = Buffer.from(
        resource.lines[resource.index++],
        resource.encoding,
      );
      return [...encoded, 0];
    }
    case "plugin:fs|read": {
      const resource = fsFileResource(
        (args as { rid?: unknown } | undefined)?.rid,
      );
      const len = Math.max(
        0,
        Number((args as { len?: unknown } | undefined)?.len ?? 0),
      );
      const buffer = Buffer.alloc(len);
      const { bytesRead } = await resource.handle.read(
        buffer,
        0,
        len,
        resource.position,
      );
      resource.position += bytesRead;
      return bytesWithReadCount(buffer, bytesRead);
    }
    case "plugin:fs|remove": {
      const invokeOptions = fsInvokeOptions(args, options);
      await fs.rm(pathFromFsArgs(args, options), {
        recursive: invokeOptions.recursive === true,
        force: false,
      });
      return null;
    }
    case "plugin:fs|rename": {
      await fs.rename(
        fsPathField(args, "oldPath"),
        fsPathField(args, "newPath"),
      );
      return null;
    }
    case "plugin:fs|stat":
      return fileInfoFromStats(await fs.stat(pathFromFsArgs(args, options)));
    case "plugin:fs|lstat":
      return fileInfoFromStats(await fs.lstat(pathFromFsArgs(args, options)));
    case "plugin:fs|fstat": {
      const resource = fsFileResource(
        (args as { rid?: unknown } | undefined)?.rid,
      );
      return fileInfoFromStats(await resource.handle.stat());
    }
    case "plugin:fs|truncate": {
      const len = Number(
        args && typeof args === "object" && "len" in args ? args.len : 0,
      );
      await fs.truncate(
        pathFromFsArgs(args, options),
        Number.isFinite(len) ? len : 0,
      );
      return null;
    }
    case "plugin:fs|ftruncate": {
      const resource = fsFileResource(
        (args as { rid?: unknown } | undefined)?.rid,
      );
      const len = Number((args as { len?: unknown } | undefined)?.len ?? 0);
      await resource.handle.truncate(Number.isFinite(len) ? len : 0);
      return null;
    }
    case "plugin:fs|seek": {
      const resource = fsFileResource(
        (args as { rid?: unknown } | undefined)?.rid,
      );
      const offset = Number(
        (args as { offset?: unknown } | undefined)?.offset ?? 0,
      );
      const whence = Number(
        (args as { whence?: unknown } | undefined)?.whence ?? 0,
      );
      const base =
        whence === 1
          ? resource.position
          : whence === 2
            ? (await resource.handle.stat()).size
            : 0;
      const nextPosition = base + offset;
      if (!Number.isFinite(nextPosition) || nextPosition < 0) {
        throw new Error("Invalid seek offset");
      }
      resource.position = nextPosition;
      return resource.position;
    }
    case "plugin:fs|write_text_file": {
      const file = pathFromFsArgs(args, options);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const bytes =
        args instanceof ArrayBuffer
          ? Buffer.from(args)
          : Buffer.from(args as Uint8Array);
      await fs.writeFile(file, bytes);
      return null;
    }
    case "plugin:fs|write_file": {
      const file = pathFromFsArgs(args, options);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const bytes =
        args instanceof ArrayBuffer
          ? Buffer.from(args)
          : Buffer.from(args as Uint8Array);
      await fs.writeFile(file, bytes);
      return null;
    }
    case "plugin:fs|write": {
      const resource = fsFileResource(
        (args as { rid?: unknown } | undefined)?.rid,
      );
      const data = bufferFromUnknown(
        (args as { data?: unknown } | undefined)?.data,
      );
      const { bytesWritten } = await resource.handle.write(
        data,
        0,
        data.length,
        resource.append ? null : resource.position,
      );
      resource.position = resource.append
        ? (await resource.handle.stat()).size
        : resource.position + bytesWritten;
      return bytesWritten;
    }
    case "plugin:fs|exists":
      return pathExists(pathFromFsArgs(args, options));
    case "plugin:fs|watch": {
      const payload = args as
        | {
            paths?: unknown;
            onEvent?: unknown;
            options?: { recursive?: boolean };
          }
        | undefined;
      const watchPaths = (
        Array.isArray(payload?.paths) ? payload.paths : [payload?.paths]
      )
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeFsPath);
      const channelId = channelIdFrom(payload?.onEvent);
      const watchers = watchPaths.map((watchPath) => {
        const sendWatchEvent = (changedPath?: string | Buffer | null) => {
          const fullPath = changedPath
            ? path.join(watchPath, String(changedPath))
            : watchPath;
          sendChannel(event.sender, channelId, {
            type: "any",
            paths: [fullPath],
            attrs: null,
          });
        };
        try {
          return watchFs(
            watchPath,
            { recursive: payload?.options?.recursive === true },
            (_type, changedPath) => {
              sendWatchEvent(changedPath);
            },
          );
        } catch {
          return watchFs(watchPath, (_type, changedPath) => {
            sendWatchEvent(changedPath);
          });
        }
      });
      const rid = nextRid++;
      fsResources.set(rid, { kind: "watcher", watchers });
      return rid;
    }
    case "plugin:fs|size":
      return fsEntrySize(pathFromFsArgs(args, options));
    case "plugin:fs|start_accessing_security_scoped_resource":
    case "plugin:fs|stop_accessing_security_scoped_resource":
      return null;
    default:
      throw new Error(`Electron host command is not implemented yet: ${cmd}`);
  }
}
