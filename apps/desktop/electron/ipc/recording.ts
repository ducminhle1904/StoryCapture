import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { desktopCapturer, systemPreferences } from "electron";
import ffmpegPath from "ffmpeg-static";
import { recordingAudioMode } from "./audio-tracks";
import { defaultCaptureTarget } from "./legacy/capture-preview";
import { screenPermissionReport } from "./legacy/platform";
import {
  cancelRecording,
  getRecordingStatus,
  pauseRecording,
  resumeRecording,
  stopRecording,
} from "./legacy/recording";
import { authorPreviewSessions, type CaptureTarget, recordingSessions } from "./legacy/shared";
import { legacyHandlers } from "./legacy-command";
import {
  acceptedRecordingPreflights,
  type RecordingPreflightMode,
  type RecordingPreflightReportV1,
  type RecordingPreflightRequestV1,
  type RecordingPreflightTargetSource,
  RecordingPreflightValidator,
} from "./recording-preflight";
import {
  invalidateRecordingRepair,
  type RecordingRepairAction,
  recordingRepairControllerForSession,
} from "./recording-repair";
import { recordingSessionJournal } from "./recording-session-journal";
import type { InvokeHandlers } from "./types";

function sessionArg(args: unknown): unknown {
  return (args as { session?: unknown } | undefined)?.session;
}

function sessionIdArg(args: unknown): string {
  const value = sessionArg(args);
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  throw new Error("recording session id required");
}

const REPAIR_ACTIONS = new Set<RecordingRepairAction>([
  "retry_step",
  "use_candidate_and_retry",
  "await_presentation",
  "retry_scene",
  "abort_keep_salvage",
]);

function resolveRecordingRepair(args: unknown) {
  const payload = args as Record<string, unknown> | undefined;
  const sessionId = sessionIdArg(args);
  const token = typeof payload?.repair_token === "string" ? payload.repair_token : "";
  const action = typeof payload?.action === "string" ? payload.action : "";
  if (!token) throw new Error("repair token required");
  if (!REPAIR_ACTIONS.has(action as RecordingRepairAction)) {
    throw new Error("recording repair action invalid");
  }
  if (!recordingSessions.has(sessionId)) throw new Error("recording repair session is not live");
  const controller = recordingRepairControllerForSession(sessionId);
  if (!controller) throw new Error("recording repair is not pending");
  return {
    version: 1,
    accepted: true,
    resolution: controller.resolve({
      session_id: sessionId,
      repair_token: token,
      action: action as RecordingRepairAction,
      candidate_key: typeof payload?.candidate_key === "string" ? payload.candidate_key : undefined,
    }),
  };
}

async function stopRecordingWithRepair(args: unknown) {
  const sessionId = sessionIdArg(args);
  invalidateRecordingRepair(sessionId);
  return stopRecording(sessionArg(args));
}

async function cancelRecordingWithRepair(args: unknown) {
  const sessionId = sessionIdArg(args);
  invalidateRecordingRepair(sessionId);
  return cancelRecording(args);
}

let recoveryGateHolders = 0;
const preflightValidators = new Map<RecordingPreflightMode, RecordingPreflightValidator>();

function preflightMode(): RecordingPreflightMode {
  return process.env.STORYCAPTURE_RECORDING_PREFLIGHT_MODE?.trim().toLowerCase() === "block"
    ? "block"
    : "warn";
}

function sourceWindowId(sourceId: string): string | null {
  const match = /^window:([^:]+):/.exec(sourceId);
  return match?.[1] ?? null;
}

function smokeEncoder(binaryPath: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"],
      signal,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code === 0));
  });
}

function createPreflightValidator(mode: RecordingPreflightMode): RecordingPreflightValidator {
  return new RecordingPreflightValidator(
    {
      now: Date.now,
      getScreenPermission: async () => {
        const report = await screenPermissionReport(false);
        return report.state === "granted"
          ? "granted"
          : report.state === "denied"
            ? "denied"
            : "undetermined";
      },
      listCaptureSources: async (kind): Promise<RecordingPreflightTargetSource[]> => {
        const sources = await desktopCapturer.getSources({
          types: [kind],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });
        return sources.map((source) => ({
          id: source.id,
          name: source.name,
          display_id: source.display_id || null,
          window_id: kind === "window" ? sourceWindowId(source.id) : null,
          pid: null,
          thumbnail_available: !source.thumbnail.isEmpty(),
        }));
      },
      inspectAuthorPreview: async (streamId) => {
        const preview = authorPreviewSessions.get(streamId);
        const live = Boolean(preview && !preview.window.isDestroyed());
        return { live, thumbnail_available: live };
      },
      inspectEncoder: async () => {
        if (!ffmpegPath) {
          return { path: null, exists: false, is_file: false, executable: false };
        }
        const stat = await fs.stat(ffmpegPath).catch(() => null);
        const executable =
          process.platform === "win32"
            ? Boolean(stat?.isFile())
            : await fs
                .access(ffmpegPath, fsConstants.X_OK)
                .then(() => true)
                .catch(() => false);
        return {
          path: ffmpegPath,
          exists: Boolean(stat),
          is_file: Boolean(stat?.isFile()),
          executable,
        };
      },
      smokeEncoder,
      inspectOutputDirectory: async (outputDirectory) => {
        const resolved = path.resolve(outputDirectory);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) {
          return {
            exists: false,
            is_directory: false,
            writable: false,
            free_bytes: null,
          };
        }
        const writable = await fs
          .access(resolved, fsConstants.W_OK)
          .then(() => true)
          .catch(() => false);
        const fileSystem = await fs.statfs(resolved).catch(() => null);
        return {
          exists: true,
          is_directory: stat.isDirectory(),
          writable,
          free_bytes: fileSystem ? Number(fileSystem.bavail) * Number(fileSystem.bsize) : null,
        };
      },
      listAudioInputIds: async () => [],
      getAudioRoleCapability: async (role) => {
        if (role === "tab") {
          return recordingAudioMode() === "legacy"
            ? { state: "unsupported", reason: "tab_not_enabled" }
            : { state: "available", reason: "author_preview_frame_available" };
        }
        if (role !== "microphone") return { state: "unsupported", reason: `${role}_not_enabled` };
        const status = systemPreferences.getMediaAccessStatus("microphone");
        return status === "denied" || status === "restricted"
          ? { state: "unavailable", reason: "microphone_permission_denied" }
          : { state: "available", reason: "microphone_available" };
      },
      getProfileCapability: async ({ width, height, fps }) => ({
        supported:
          Number.isFinite(width) &&
          width > 0 &&
          width <= 7_680 &&
          Number.isFinite(height) &&
          height > 0 &&
          height <= 4_320 &&
          Number.isFinite(fps) &&
          fps >= 1 &&
          fps <= 60,
        reason: "electron_capture_profile",
      }),
      getStartupGate: async () => ({
        active_session: recordingSessions.size > 0,
        recovery_holds_gate: recoveryGateHolders > 0,
      }),
    },
    { mode },
  );
}

function preflightValidator(): RecordingPreflightValidator {
  const mode = preflightMode();
  const existing = preflightValidators.get(mode);
  if (existing) return existing;
  const validator = createPreflightValidator(mode);
  preflightValidators.set(mode, validator);
  return validator;
}

function numericStartField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function startPayload(raw: unknown): Record<string, unknown> {
  const envelope = raw as { args?: unknown } | undefined;
  const payload = envelope?.args ?? raw;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

export function recordingPreflightRequestFromStart(raw: unknown): RecordingPreflightRequestV1 {
  const payload = startPayload(raw);
  const projectFolder = typeof payload.project_folder === "string" ? payload.project_folder : "";
  if (!projectFolder) throw new Error("project_folder required");
  const audioDeviceId =
    typeof payload.audio_device_id === "string" && payload.audio_device_id.length > 0
      ? payload.audio_device_id
      : null;
  return {
    version: 1,
    target: (payload.target as CaptureTarget | undefined) ?? defaultCaptureTarget(),
    output_directory: projectFolder,
    width: numericStartField(payload.width, 1_280),
    height: numericStartField(payload.height, 720),
    fps: numericStartField(payload.fps, 30),
    audio_roles: audioDeviceId
      ? [{ role: "microphone", policy: "optional", device_id: audioDeviceId }]
      : [],
    available_audio_input_ids: audioDeviceId ? [audioDeviceId] : [],
  };
}

export async function runRecordingPreflight(
  raw: unknown,
  options: { force?: boolean } = {},
): Promise<RecordingPreflightReportV1> {
  const request = (raw as { request?: RecordingPreflightRequestV1 } | undefined)?.request ?? raw;
  return preflightValidator().run(request as RecordingPreflightRequestV1, options);
}

async function startRecordingWithPreflight(
  raw: unknown,
  invokeLegacy: () => unknown | Promise<unknown>,
) {
  const report = await preflightValidator().run(recordingPreflightRequestFromStart(raw), {
    force: true,
  });
  if (preflightMode() === "block" && report.verdict === "block") {
    const reasons = report.checks
      .filter((check) => check.status === "block")
      .map((check) => `${check.id}:${check.reason}`)
      .join(",");
    throw new Error(`recording preflight blocked start: ${reasons}`);
  }
  const result = await invokeLegacy();
  const sessionId = String((result as { id?: unknown } | null)?.id ?? "");
  if (sessionId) acceptedRecordingPreflights.accept(sessionId, report);
  return result;
}

async function withRecoveryGate<T>(operation: () => Promise<T>): Promise<T> {
  recoveryGateHolders += 1;
  try {
    return await operation();
  } finally {
    recoveryGateHolders -= 1;
  }
}

export const recordingHandlers = {
  ...legacyHandlers(["electron_recording_set_audio"]),
  recording_preflight: (args) => runRecordingPreflight(args),
  start_recording: (args, context) =>
    startRecordingWithPreflight(args, () => context.invokeLegacy("start_recording")),
  stop_recording: (args) => stopRecordingWithRepair(args),
  pause_recording: async (args) => ({
    status: (await pauseRecording(sessionArg(args))).state,
  }),
  resume_recording: async (args) => ({
    status: (await resumeRecording(sessionArg(args))).state,
  }),
  cancel_recording: (args) => cancelRecordingWithRepair(args),
  resolve_recording_repair: (args) => resolveRecordingRepair(args),
  get_recording_status: (args) => getRecordingStatus(args),
  list_interrupted_recordings: (args) => recordingSessionJournal.list(args),
  recover_interrupted_recording: (args) =>
    withRecoveryGate(() => recordingSessionJournal.recover(args)),
  discard_interrupted_recording: (args) =>
    withRecoveryGate(() => recordingSessionJournal.discard(args)),
} satisfies InvokeHandlers;
