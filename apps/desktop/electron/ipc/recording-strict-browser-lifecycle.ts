import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StartRecordingArgs } from "@storycapture/shared-types";
import type { RecordingDimensionsV2 } from "@storycapture/shared-types/recording-v2";
import type {
  RecordingResultV3,
  RecordingV3FailureCode,
} from "@storycapture/shared-types/recording-v3";
import type { WebContents } from "electron";

import {
  type ActionCursorTiming,
  type ActionTimelineEvent,
  recordingActionsFromSession,
  scaleActionTimelineEvents,
  writeActionsSidecarAtomic,
} from "./action-timeline";
import type { BrowserRecordingReadinessState } from "./browser-capture-backend-v2";
import { channelIdFrom, closeChannel, sendChannel } from "./legacy/shared";
import { probeRecording } from "./media-probe";
import { RecordingBundleWorkspace } from "./recording-bundle";
import { probePtsAnomalies, rationalsEqual } from "./recording-cadence-verifier";
import { transcodeAudioFileToPcmWav } from "./recording-master";
import { SequentialMasterDecoder } from "./recording-master-decoder";
import { RecordingMediaClock } from "./recording-media-clock";
import {
  RecordingNativeBrowserSurface,
  type RecordingQualityReferenceSample,
} from "./recording-native-browser-surface";
import {
  finalizeRecordingNativeMaster,
  type RecordingNativeMasterEvidence,
} from "./recording-native-master-bundle";
import {
  createRecordingNativePlatformSession,
  type RecordingNativePlatformSession,
} from "./recording-native-platform-session";
import { recordingNativeGlobalPreflight } from "./recording-native-preflight";
import { recordEngineLog } from "./recording-observability";
import { RecordingPauseGate } from "./recording-pause-gate";
import {
  sampledFrameAlignmentError,
  verifyGenericRecordingQualityV3,
} from "./recording-quality-verifier";

const STRICT_FPS = 60;
const MAX_REFERENCE_SAMPLES = 12;
const REFERENCE_ALIGNMENT_RADIUS_FRAMES = 6;

class ActiveRecordingClock {
  private readonly startedNs = process.hrtime.bigint();
  private pausedAtNs: bigint | null = null;
  private pausedNs = 0n;

  pause(): void {
    this.pausedAtNs ??= process.hrtime.bigint();
  }

  resume(): void {
    if (this.pausedAtNs === null) return;
    this.pausedNs += process.hrtime.bigint() - this.pausedAtNs;
    this.pausedAtNs = null;
  }

  milliseconds(): number {
    const now = this.pausedAtNs ?? process.hrtime.bigint();
    return Number(now - this.startedNs - this.pausedNs) / 1_000_000;
  }
}

export interface StrictBrowserSession {
  id: string;
  platformSession: RecordingNativePlatformSession;
  surface: RecordingNativeBrowserSurface;
  workspace: RecordingBundleWorkspace;
  dimensions: RecordingDimensionsV2;
  request: { dimensions: RecordingDimensionsV2 };
  startedAt: number;
  sender: WebContents;
  eventChannelId: number | null;
  heartbeat: ReturnType<typeof setInterval>;
  audioPath: string;
  wavPath: string;
  actionsPath: string;
  actionEvents: ActionTimelineEvent[];
  cursorMotionPreset: ActionCursorTiming["motion_preset"] | undefined;
  referenceSamples: RecordingQualityReferenceSample[];
  clock: ActiveRecordingClock;
  pauseGate: RecordingPauseGate;
  stopPromise: Promise<RecordingResultV3> | null;
}

const sessions = new Map<string, StrictBrowserSession>();

function strictDimensions(args: StartRecordingArgs): RecordingDimensionsV2 {
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

function strictContentViewport(width: number, height: number): { width: number; height: number } {
  const aspectUnit = Math.max(1, Math.floor(Math.min(width / 16, height / 9)));
  return { width: aspectUnit * 16, height: aspectUnit * 9 };
}

function send(session: StrictBrowserSession, event: unknown): void {
  sendChannel(session.sender, session.eventChannelId, event);
}

async function removeTemporaryFiles(session: StrictBrowserSession): Promise<void> {
  await Promise.all([
    fs.rm(session.audioPath, { force: true }).catch(() => undefined),
    fs.rm(session.wavPath, { force: true }).catch(() => undefined),
    fs.rm(session.actionsPath, { force: true }).catch(() => undefined),
  ]);
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
  const dimensions = strictDimensions(args);
  const exportsDir = path.join(args.project_folder, "exports");
  const bundleName = `recording-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const preflight = await recordingNativeGlobalPreflight({ exportsDir });
  sendChannel(sender, eventChannelId, { type: "preflight", result: preflight.preflight });
  void recordEngineLog({
    level: preflight.preflight.strict_eligible ? "info" : "warn",
    event: "recording.preflight.completed",
    context: { session_id: id, backend_id: "strict-native-v3", phase: "preflight" },
    details: {
      strict_eligible: preflight.preflight.strict_eligible,
      encoder_id: preflight.preflight.encoder_id,
      failure_codes: preflight.preflight.failure_codes,
    },
  });
  if (!preflight.preflight.strict_eligible) {
    closeChannel(sender, eventChannelId);
    throw new Error(
      `Strict native preflight blocked: ${preflight.preflight.failure_codes.join(", ")}`,
    );
  }

  const temporaryDir = path.join(os.tmpdir(), "storycapture-strict-native");
  const audioPath = path.join(temporaryDir, `${id}.webm`);
  const wavPath = path.join(temporaryDir, `${id}.wav`);
  const actionsPath = path.join(temporaryDir, `${id}.actions.json`);
  let workspace: RecordingBundleWorkspace | null = null;
  let surface: RecordingNativeBrowserSurface | null = null;
  let platformSession: RecordingNativePlatformSession | null = null;
  try {
    workspace = await RecordingBundleWorkspace.create(exportsDir, bundleName);
    surface = new RecordingNativeBrowserSurface({
      url,
      dimensions,
      contentViewport: strictContentViewport(args.width, args.height),
    });
    await fs.mkdir(temporaryDir, { recursive: true });
    sendChannel(sender, eventChannelId, { type: "readiness", state: "global_ready" });
    await surface.load();
    sendChannel(sender, eventChannelId, { type: "readiness", state: "target_ready" });
    platformSession = createRecordingNativePlatformSession({
      platform: process.platform,
      helperPath: preflight.helperPath,
      sessionId: id,
      artifactPath: workspace.resolve("master/video.mp4"),
      dimensions,
      surface,
    });
    await platformSession.start();
    const initialReference = await surface.captureReference(0);
    sendChannel(sender, eventChannelId, {
      type: "readiness",
      state: "initial_surface_received",
    });
    const clock = new ActiveRecordingClock();
    let heartbeatSeq = 0;
    const heartbeat = setInterval(() => {
      heartbeatSeq += 1;
      sendChannel(sender, eventChannelId, { type: "heartbeat", seq: heartbeatSeq });
    }, 1_000);
    heartbeat.unref?.();
    sessions.set(id, {
      id,
      platformSession,
      surface,
      workspace,
      dimensions,
      request: { dimensions },
      startedAt: Date.now(),
      sender,
      eventChannelId,
      heartbeat,
      audioPath,
      wavPath,
      actionsPath,
      actionEvents: [],
      cursorMotionPreset: undefined,
      referenceSamples: [initialReference],
      clock,
      pauseGate: new RecordingPauseGate(),
      stopPromise: null,
    });
    sendChannel(sender, eventChannelId, {
      type: "capture-status",
      json: JSON.stringify({
        type: "started",
        session_id: id,
        backend_id: platformSession.backend.id,
      }),
    });
    return { id };
  } catch (error) {
    await platformSession?.close().catch(() => undefined);
    surface?.destroy();
    await workspace?.discard();
    await Promise.all([
      fs.rm(audioPath, { force: true }).catch(() => undefined),
      fs.rm(wavPath, { force: true }).catch(() => undefined),
      fs.rm(actionsPath, { force: true }).catch(() => undefined),
    ]);
    closeChannel(sender, eventChannelId);
    throw error;
  }
}

export function strictBrowserRecordingSession(id: string): StrictBrowserSession | null {
  return sessions.get(id) ?? null;
}

export function strictBrowserRecordingContents(id: string): WebContents | null {
  return sessions.get(id)?.surface.contents ?? null;
}

export function strictBrowserRecordingInputCoordinateScale(id: string): number | null {
  return sessions.get(id)?.surface.inputCoordinateScale() ?? null;
}

export function strictBrowserRecordingClockMs(id: string): number | null {
  return sessions.get(id)?.clock.milliseconds() ?? null;
}

export async function requireStrictBrowserRecordingReadiness(
  id: string,
  state: BrowserRecordingReadinessState,
): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`strict recording session ${id} not found`);
  if (state !== "pre_input_frame_committed") return;
  if (session.referenceSamples.length >= MAX_REFERENCE_SAMPLES) return;
  const frameIndex = Math.max(0, Math.floor((session.clock.milliseconds() * STRICT_FPS) / 1_000));
  if (session.referenceSamples.some((sample) => sample.frame_index === frameIndex)) return;
  session.referenceSamples.push(await session.surface.captureReference(frameIndex));
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
  session.pauseGate.pause();
  try {
    await session.platformSession.pause();
    session.clock.pause();
  } catch (error) {
    session.pauseGate.resume();
    throw error;
  }
  return true;
}

export async function resumeStrictBrowserRecording(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  await session.platformSession.resume();
  session.clock.resume();
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

export async function stopStrictBrowserRecording(id: string): Promise<RecordingResultV3 | null> {
  const session = sessions.get(id);
  if (!session) return null;
  session.stopPromise ??= stopSession(session);
  return session.stopPromise;
}

function pushFailure(failures: RecordingV3FailureCode[], failure: RecordingV3FailureCode): void {
  if (!failures.includes(failure)) failures.push(failure);
}

async function verifiedNativeEvidence(
  evidence: RecordingNativeMasterEvidence,
): Promise<RecordingNativeMasterEvidence> {
  const failures = [...(evidence.failure_codes ?? [])];
  const stat = await fs.stat(evidence.artifact_path).catch(() => null);
  const probe = await probeRecording(evidence.artifact_path);
  if (!stat?.isFile() || stat.size === 0) pushFailure(failures, "artifact_truncated");
  if (probe.status === "invalid") {
    pushFailure(failures, "artifact_probe_failed");
    return {
      ...evidence,
      artifact_bytes: stat?.size ?? 0,
      artifact: { finalized: evidence.finalized, full_decode_succeeded: false, decoded_frames: 0 },
      failure_codes: failures,
    };
  }
  if (probe.codec !== "h264") pushFailure(failures, "artifact_codec_mismatch");
  if (probe.width !== evidence.width || probe.height !== evidence.height) {
    pushFailure(failures, "artifact_resolution_mismatch");
  }
  const strictFps = { numerator: 60, denominator: 1 };
  if (
    !rationalsEqual(probe.real_frame_rate, strictFps) ||
    !rationalsEqual(probe.average_frame_rate, strictFps)
  ) {
    pushFailure(failures, "source_rate_mismatch");
  }
  if (!probe.stream_time_base || probe.counted_frames === null) {
    pushFailure(failures, "artifact_probe_failed");
  }
  if (!probe.full_decode_succeeded) pushFailure(failures, "artifact_decode_failed");
  const decodedFrames = probe.counted_frames ?? probe.declared_frames ?? 0;
  if (decodedFrames !== evidence.output_frames) {
    pushFailure(failures, "artifact_frame_count_mismatch");
  }
  if (
    probe.declared_frames !== null &&
    probe.counted_frames !== null &&
    probe.declared_frames !== probe.counted_frames
  ) {
    pushFailure(failures, "artifact_frame_count_mismatch");
  }
  const pts = probePtsAnomalies(probe, strictFps);
  if (pts.pts_gaps > 0) pushFailure(failures, "artifact_pts_gap");
  if (pts.pts_duplicates > 0) pushFailure(failures, "artifact_pts_duplicate");
  if (
    probe.counted_frames !== null &&
    (probe.frames.length !== probe.counted_frames ||
      probe.frames.some(
        (frame) =>
          (frame.best_effort_timestamp_time_seconds === null && frame.pts_time_seconds === null) ||
          frame.duration_time_seconds === null,
      ))
  ) {
    pushFailure(failures, "artifact_probe_failed");
  }
  const frameDurationMs = 1_000 / STRICT_FPS;
  if (
    probe.duration_ms !== null &&
    probe.duration_ms + frameDurationMs / 2 < evidence.finalized_duration_us / 1_000
  ) {
    pushFailure(failures, "artifact_truncated");
  }
  const pixelFormat = probe.pixel_format === "yuv420p" ? "yuv420p" : evidence.pixel_format;
  return {
    ...evidence,
    artifact_bytes: stat?.size ?? 0,
    pixel_format: pixelFormat,
    artifact: {
      finalized: evidence.finalized,
      full_decode_succeeded: probe.full_decode_succeeded,
      decoded_frames: decodedFrames,
    },
    failure_codes: failures,
  };
}

async function qualityComparisons(
  session: StrictBrowserSession,
  evidence: RecordingNativeMasterEvidence,
): Promise<Array<{ reference: Buffer; actual: Buffer }>> {
  const byFrame = new Map<number, RecordingQualityReferenceSample>();
  for (const sample of session.referenceSamples) {
    const frameIndex = Math.min(sample.frame_index, Math.max(0, evidence.output_frames - 1));
    if (!byFrame.has(frameIndex)) byFrame.set(frameIndex, { ...sample, frame_index: frameIndex });
  }
  const decoder = new SequentialMasterDecoder(
    evidence.artifact_path,
    session.dimensions.requested_output_width,
    session.dimensions.requested_output_height,
  );
  try {
    const comparisons: Array<{ reference: Buffer; actual: Buffer }> = [];
    let lastDecodedFrame = -1;
    for (const [frameIndex, sample] of [...byFrame].sort(([left], [right]) => left - right)) {
      if (
        sample.width !== session.dimensions.requested_output_width ||
        sample.height !== session.dimensions.requested_output_height
      ) {
        continue;
      }
      const firstCandidate = Math.max(
        lastDecodedFrame + 1,
        frameIndex - REFERENCE_ALIGNMENT_RADIUS_FRAMES,
      );
      const lastCandidate = Math.min(
        evidence.output_frames - 1,
        frameIndex + REFERENCE_ALIGNMENT_RADIUS_FRAMES,
      );
      let bestActual: Buffer | null = null;
      let bestError = Number.POSITIVE_INFINITY;
      for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
        const actual = Buffer.from(await decoder.readFrame(candidate));
        lastDecodedFrame = candidate;
        const error = sampledFrameAlignmentError(
          sample.pixels,
          actual,
          session.dimensions.requested_output_width,
          session.dimensions.requested_output_height,
        );
        if (error < bestError) {
          bestError = error;
          bestActual = actual;
        }
      }
      if (bestActual) comparisons.push({ reference: sample.pixels, actual: bestActual });
    }
    return comparisons;
  } finally {
    decoder.close();
  }
}

async function stopSession(session: StrictBrowserSession): Promise<RecordingResultV3> {
  clearInterval(session.heartbeat);
  session.pauseGate.cancel();
  try {
    let evidence = await session.platformSession.stop();
    send(session, { type: "verifying", progress: 0 });
    evidence = await verifiedNativeEvidence(evidence);
    let comparisons: Array<{ reference: Buffer; actual: Buffer }> = [];
    try {
      comparisons = await qualityComparisons(session, evidence);
    } catch {
      evidence = {
        ...evidence,
        failure_codes: [...(evidence.failure_codes ?? []), "artifact_decode_failed"],
      };
    }
    const quality = verifyGenericRecordingQualityV3({
      width: session.dimensions.requested_output_width,
      height: session.dimensions.requested_output_height,
      frames: comparisons,
    });
    let actionsReady = false;
    if (session.actionEvents.length > 0) {
      const width = session.dimensions.requested_output_width;
      const height = session.dimensions.requested_output_height;
      try {
        const mediaClock = new RecordingMediaClock({ fpsNum: STRICT_FPS, fpsDen: 1 });
        for (let frame = 0; frame < evidence.output_frames; frame += 1) {
          mediaClock.commitFrame(true);
        }
        mediaClock.freeze();
        await writeActionsSidecarAtomic(
          session.actionsPath,
          recordingActionsFromSession(
            {
              outputPath: "master/video.mp4",
              width,
              height,
              outputWidth: width,
              outputHeight: height,
              fps: STRICT_FPS,
              frameSeq: evidence.output_frames,
              target: { kind: "author_preview" },
              frameCrop: null,
              mediaClock,
            },
            scaleActionTimelineEvents(
              session.actionEvents,
              session.surface.outputCoordinateScale(),
            ),
            { cursorMotionPreset: session.cursorMotionPreset, version: 3 },
          ),
        );
        actionsReady = true;
      } catch {
        evidence = {
          ...evidence,
          failure_codes: [...(evidence.failure_codes ?? []), "contract_mismatch"],
        };
      }
    }
    const hasAudio = await fs
      .stat(session.audioPath)
      .then((stat) => stat.isFile() && stat.size > 0)
      .catch(() => false);
    let audioReady = false;
    if (hasAudio) {
      try {
        await transcodeAudioFileToPcmWav(session.audioPath, session.wavPath);
        audioReady = true;
      } catch (error) {
        send(session, {
          type: "audio-unavailable",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const result = await finalizeRecordingNativeMaster({
      workspace: session.workspace,
      evidence,
      dimensions: session.dimensions,
      backend: session.platformSession.backend,
      quality,
      actionsSourcePath: actionsReady ? session.actionsPath : null,
      audioSources: audioReady ? [{ role: "microphone", sourcePath: session.wavPath }] : [],
    });
    send(session, { type: "live-evidence", evidence: result.cadence_evidence });
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
        backend_id: session.platformSession.backend.id,
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
    send(session, {
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    sessions.delete(session.id);
    await session.platformSession.close().catch(() => undefined);
    session.surface.destroy();
    await session.workspace.discard();
    await removeTemporaryFiles(session);
    closeChannel(session.sender, session.eventChannelId);
  }
}
