import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StartRecordingArgs } from "@storycapture/shared-types";
import type {
  RecordingPreflightV2Request,
  RecordingResultV2,
} from "@storycapture/shared-types/recording-v2";
import type { WebContents } from "electron";
import {
  type ActionCursorTiming,
  type ActionTimelineEvent,
  recordingActionsFromSession,
  writeActionsSidecarAtomic,
} from "./action-timeline";
import {
  BrowserCaptureBackendV2,
  type BrowserRecordingReadinessState,
} from "./browser-capture-backend-v2";
import { channelIdFrom, closeChannel, sendChannel } from "./legacy/shared";
import { findRecordingCertificationTier } from "./recording-certification-catalog";
import { recordEngineLog } from "./recording-observability";
import { RecordingPauseGate } from "./recording-pause-gate";

export interface StrictBrowserSession {
  id: string;
  backend: BrowserCaptureBackendV2;
  request: RecordingPreflightV2Request;
  sender: WebContents;
  eventChannelId: number | null;
  startedAt: number;
  heartbeat: ReturnType<typeof setInterval>;
  audioPath: string;
  actionsPath: string;
  actionEvents: ActionTimelineEvent[];
  cursorMotionPreset: ActionCursorTiming["motion_preset"] | undefined;
  pauseGate: RecordingPauseGate;
  stopPromise: Promise<RecordingResultV2> | null;
}

const sessions = new Map<string, StrictBrowserSession>();

function strictDimensions(args: StartRecordingArgs): RecordingPreflightV2Request["dimensions"] {
  return (
    args.capture_contract?.dimensions ?? {
      logical_width: 1920,
      logical_height: 1080,
      capture_dpr: 1,
      physical_width: 1920,
      physical_height: 1080,
      requested_output_width: 1920,
      requested_output_height: 1080,
    }
  );
}

function strictRequest(args: StartRecordingArgs): RecordingPreflightV2Request {
  return {
    version: 2,
    delivery_policy: "strict",
    target_class: "browser",
    requested_fps: { numerator: 60, denominator: 1 },
    dimensions: strictDimensions(args),
    audio_roles: args.audio_device_id ? ["microphone"] : [],
    desired_tier: args.certified_tier ?? null,
  };
}

function send(session: StrictBrowserSession, event: unknown): void {
  sendChannel(session.sender, session.eventChannelId, event);
}

export async function startStrictBrowserRecording(
  args: StartRecordingArgs,
  onEvent: unknown,
  sender: WebContents,
  url: string,
): Promise<{ id: string }> {
  if (args.target.kind !== "author_preview") {
    throw new Error("Strict browser recording requires an authoritative author-preview target.");
  }
  if (!url || url === "about:blank") {
    throw new Error("Strict browser recording requires a committed source URL.");
  }
  const id = randomUUID();
  const eventChannelId = channelIdFrom(onEvent);
  const exportsDir = path.join(args.project_folder, "exports");
  const bundleName = `recording-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const backend = new BrowserCaptureBackendV2({
    exportsDir,
    bundleName,
    url,
    onReadiness: (state) => sendChannel(sender, eventChannelId, { type: "readiness", state }),
  });
  let request = strictRequest(args);
  let preflight = await backend.probe(request);
  if (!request.desired_tier) {
    const tier = findRecordingCertificationTier({
      platform: preflight.platform,
      arch: preflight.arch,
      hardwareFingerprint: preflight.hardware_fingerprint,
      targetClass: "browser",
      capabilities: backend.capabilities,
      outputWidth: request.dimensions.requested_output_width,
      outputHeight: request.dimensions.requested_output_height,
    });
    if (tier) {
      request = { ...request, desired_tier: tier };
      preflight = await backend.probe(request);
    }
  }
  sendChannel(sender, eventChannelId, { type: "preflight", result: preflight });
  void recordEngineLog({
    level: preflight.strict_eligible ? "info" : "warn",
    event: "recording.preflight.completed",
    context: { session_id: id, backend_id: preflight.backend_id, phase: "preflight" },
    details: {
      strict_eligible: preflight.strict_eligible,
      certification_id: preflight.certification?.id ?? null,
      failure_codes: preflight.failure_codes,
      encode_throughput_ratio: preflight.encode_throughput_ratio,
    },
  });
  if (!preflight.strict_eligible) {
    closeChannel(sender, eventChannelId);
    throw new Error(`Strict preflight blocked: ${preflight.failure_codes.join(", ")}`);
  }
  const audioDir = path.join(os.tmpdir(), "storycapture-strict-audio");
  await fs.mkdir(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `${id}.webm`);
  const actionsPath = path.join(audioDir, `${id}.actions.json`);
  try {
    await backend.start({ session_id: id, request });
  } catch (error) {
    closeChannel(sender, eventChannelId);
    await Promise.all([
      fs.rm(audioPath, { force: true }).catch(() => undefined),
      fs.rm(actionsPath, { force: true }).catch(() => undefined),
    ]);
    throw error;
  }
  let heartbeatSeq = 0;
  const heartbeat = setInterval(() => {
    heartbeatSeq += 1;
    sendChannel(sender, eventChannelId, { type: "heartbeat", seq: heartbeatSeq });
    sendChannel(sender, eventChannelId, {
      type: "live-evidence",
      evidence: backend.cadenceEvidence(),
    });
  }, 1_000);
  heartbeat.unref?.();
  sessions.set(id, {
    id,
    backend,
    request,
    sender,
    eventChannelId,
    startedAt: Date.now(),
    heartbeat,
    audioPath,
    actionsPath,
    actionEvents: [],
    cursorMotionPreset: undefined,
    pauseGate: new RecordingPauseGate(),
    stopPromise: null,
  });
  sendChannel(sender, eventChannelId, {
    type: "capture-status",
    json: JSON.stringify({
      type: "started",
      session_id: id,
      backend_id: backend.capabilities.backend_id,
    }),
  });
  return { id };
}

export function strictBrowserRecordingSession(id: string): StrictBrowserSession | null {
  return sessions.get(id) ?? null;
}

export function strictBrowserRecordingContents(id: string): WebContents | null {
  return sessions.get(id)?.backend.recordingContents() ?? null;
}

export function strictBrowserRecordingClockMs(id: string): number | null {
  const session = sessions.get(id);
  return session ? session.backend.recordingClockMs() : null;
}

export async function requireStrictBrowserRecordingReadiness(
  id: string,
  state: BrowserRecordingReadinessState,
): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`strict recording session ${id} not found`);
  await session.backend.waitForReadiness(state);
}

export async function setStrictBrowserRecordingAudio(raw: unknown): Promise<boolean> {
  const payload = raw as { session?: { id?: unknown }; id?: unknown; bytes?: unknown } | undefined;
  const id = String(payload?.session?.id ?? payload?.id ?? "");
  const session = sessions.get(id);
  if (!session) return false;
  const bytes = payload?.bytes;
  const buffer =
    bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : null;
  if (buffer?.byteLength) await fs.writeFile(session.audioPath, buffer);
  return true;
}

export async function pauseStrictBrowserRecording(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  await session.backend.pause();
  session.pauseGate.pause();
  return true;
}

export async function resumeStrictBrowserRecording(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  await session.backend.resume();
  session.pauseGate.resume();
  return true;
}

export function setStrictBrowserRecordingActions(
  id: string,
  events: readonly ActionTimelineEvent[],
  cursorMotionPreset?: ActionCursorTiming["motion_preset"],
): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.actionEvents = [...events];
  session.cursorMotionPreset = cursorMotionPreset;
  return true;
}

export async function stopStrictBrowserRecording(id: string): Promise<RecordingResultV2 | null> {
  const session = sessions.get(id);
  if (!session) return null;
  if (!session.stopPromise) session.stopPromise = stopSession(session);
  return session.stopPromise;
}

async function stopSession(session: StrictBrowserSession): Promise<RecordingResultV2> {
  clearInterval(session.heartbeat);
  session.pauseGate.cancel();
  try {
    await session.backend.stop();
    if (
      await fs
        .stat(session.audioPath)
        .then((stat) => stat.size > 0)
        .catch(() => false)
    ) {
      await session.backend.writeAudioFileSidecar("microphone", session.audioPath);
    }
    const cadenceEvidence = session.backend.cadenceEvidence();
    if (session.actionEvents.length > 0) {
      const { requested_output_width: width, requested_output_height: height } =
        session.request.dimensions;
      await writeActionsSidecarAtomic(
        session.actionsPath,
        recordingActionsFromSession(
          {
            outputPath: "master/video.mkv",
            width,
            height,
            outputWidth: width,
            outputHeight: height,
            fps: 60,
            frameSeq: cadenceEvidence.expected_slots,
            target: { kind: "author_preview" },
            frameCrop: null,
          },
          session.actionEvents,
          { cursorMotionPreset: session.cursorMotionPreset, version: 2 },
        ),
      );
    }
    send(session, { type: "live-evidence", evidence: cadenceEvidence });
    send(session, { type: "verifying", progress: 0 });
    const result = await session.backend.finalize({
      cadenceEvidence,
      actionsPath: session.actionEvents.length > 0 ? session.actionsPath : null,
    });
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
        backend_id: session.backend.capabilities.backend_id,
        phase: "verification",
      },
      details: {
        outcome: result.status,
        bundle_path: result.bundle_path,
        cadence_failure_codes: result.cadence_evidence.failure_codes,
        quality_failure_codes: result.quality_evidence.failure_codes,
      },
    });
    return result;
  } catch (error) {
    await session.backend
      .masterSink()
      .abort?.()
      .catch(() => undefined);
    send(session, {
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    sessions.delete(session.id);
    await Promise.all([
      fs.rm(session.audioPath, { force: true }).catch(() => undefined),
      fs.rm(session.actionsPath, { force: true }).catch(() => undefined),
    ]);
    closeChannel(session.sender, session.eventChannelId);
  }
}
