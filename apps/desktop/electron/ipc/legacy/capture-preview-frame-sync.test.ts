import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopCapturer } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/storycapture-test" },
  BrowserWindow: vi.fn(),
  desktopCapturer: { getSources: vi.fn() },
  dialog: {},
  screen: {},
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("ffmpeg-static", () => ({ default: null }));

import { RecordingActionLandmarkRecorder } from "../action-landmarks";
import { CaptureBackendDeliveryGuard, type CaptureBackendProvenance } from "../capture-backend";
import {
  disposeRecordingCheckpoints,
  registerRecordingCheckpoints,
} from "../recording-checkpoints";
import { RecordingMediaClock } from "../recording-media-clock";
import { recordingReadiness } from "../recording-readiness";
import {
  acknowledgeEncodedRecordingFrames,
  recordingCaptureStateSnapshot,
  recordingFrameCommitBudgetMs,
  requestRecordingFrameCommit,
  scheduleRecordingFrame,
  submitAuthorPreviewFrame,
  submitLatestAuthorPreviewFrame,
} from "./capture-preview";
import { type RecordingSession, recordingSessions } from "./shared";

function recordingSession(): RecordingSession {
  const session = {
    id: "recording-frame-sync",
    fps: 60,
    effectiveFps: 60,
    paused: false,
    lifecycle: "recording",
    streaming: false,
    mediaClock: new RecordingMediaClock({ fpsNum: 60, fpsDen: 1 }),
    actionLandmarks: new RecordingActionLandmarkRecorder(),
    captureInFlight: null,
    encoderBackpressured: false,
    encoderError: null,
    framesDropped: 0,
    skippedTicks: 0,
  } as unknown as RecordingSession;
  recordingSessions.set(session.id, session);
  return session;
}

function commitFrame(session: RecordingSession): void {
  const landmark = session.mediaClock.commitFrame(true);
  if (landmark) session.actionLandmarks.commitFrame(landmark);
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(desktopCapturer.getSources).mockReset();
  recordingReadiness.remove("recording-frame-sync");
  recordingSessions.clear();
});

describe("recording frame synchronization", () => {
  it.each([
    {
      target: { kind: "display", display_id: 1 } as const,
      expectedReason: "display_removed",
      expectedError: "not found",
    },
    {
      target: { kind: "window_by_pid", pid: 42, title_hint: "Demo" } as const,
      expectedReason: "source_unresolvable",
      expectedError: "owner PID metadata",
    },
  ])("emits one $expectedReason target loss and rejects later external frames", async ({
    target,
    expectedReason,
    expectedError,
  }) => {
    const session = recordingSession();
    const deliveries: unknown[] = [];
    const captureBackend: CaptureBackendProvenance = {
      contract_version: 1,
      mode: "contract_internal",
      selected_backend_id: "electron_external",
      attempted_backend_id: null,
      fallback_reason: null,
      delivery_mode: "host_frames",
      timestamp_source: "recording_media_clock",
      resolved_target_identity: "display:1",
      platform_version: process.platform,
      target_loss_reason: null,
      terminal_status: "pending",
    };
    Object.assign(session, {
      target,
      width: 2,
      height: 2,
      sourceFramesReceived: 0,
      captureDurationMs: [],
      lateFrames: 0,
      captureTimer: null,
      captureBackend,
      captureBackendDelivery: new CaptureBackendDeliveryGuard(
        {
          backend_id: "electron_external",
          session_id: session.id,
          ownership_token: session.id,
        },
        {
          deliver: async (event) => {
            deliveries.push(event);
            return "accepted";
          },
        },
      ),
      captureBackendDeliverySequence: 0,
      captureBackendFrameIndex: 0,
      captureBackendLastPtsUs: null,
    });
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);

    await expect(submitLatestAuthorPreviewFrame(session)).rejects.toThrow(expectedError);
    expect(session.captureBackend).toMatchObject({
      target_loss_reason: expectedReason,
      terminal_status: "target_lost",
    });
    expect(session.encoderError).toMatchObject({ name: "CaptureTargetLostError" });
    expect(deliveries).toEqual([
      expect.objectContaining({
        type: "targetLost",
        sequence: 0,
        reason: expectedReason,
        last_pts_us: null,
      }),
    ]);
    expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);

    await expect(submitLatestAuthorPreviewFrame(session)).rejects.toThrow(
      "capture target already terminated",
    );
    expect(deliveries).toHaveLength(1);
    expect(desktopCapturer.getSources).toHaveBeenCalledTimes(1);
  });

  it("counts each successful external source capture before live-sink submission", async () => {
    const session = recordingSession();
    const write = vi.fn(() => true);
    const deliveries: unknown[] = [];
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 2 }),
      resize: vi.fn(),
      toBitmap: () => Buffer.alloc(16),
    };
    image.resize.mockReturnValue(image);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      {
        id: "screen:1:0",
        name: "Display 1",
        display_id: "1",
        thumbnail: image,
        appIcon: null,
      },
    ] as never);
    Object.assign(session, {
      target: { kind: "display", display_id: 1 },
      width: 2,
      height: 2,
      sourceFramesReceived: 0,
      captureDurationMs: [],
      lateFrames: 0,
      captureBackend: {
        contract_version: 1,
        mode: "contract_internal",
        selected_backend_id: "electron_external",
        attempted_backend_id: null,
        fallback_reason: null,
        delivery_mode: "host_frames",
        timestamp_source: "recording_media_clock",
        resolved_target_identity: "display:1",
        platform_version: process.platform,
        target_loss_reason: null,
        terminal_status: "pending",
      } satisfies CaptureBackendProvenance,
      captureBackendDelivery: new CaptureBackendDeliveryGuard(
        {
          backend_id: "electron_external",
          session_id: session.id,
          ownership_token: session.id,
        },
        {
          deliver: async (event) => {
            deliveries.push(event);
            return "accepted";
          },
        },
      ),
      captureBackendDeliverySequence: 0,
      captureBackendFrameIndex: 0,
      captureBackendLastPtsUs: null,
      ffmpegProcess: {
        killed: false,
        stdin: {
          destroyed: false,
          writableLength: 0,
          write,
        },
      },
    });

    await submitLatestAuthorPreviewFrame(session);

    expect(session.sourceFramesReceived).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(deliveries).toEqual([
      expect.objectContaining({
        type: "frame",
        sequence: 0,
        frame_index: 0,
        pts_us: 0,
        pixel_format: "bgra",
      }),
    ]);
  });

  it("keeps legacy sink bytes and media clock authoritative when shadow validation fails", async () => {
    const bitmap = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    const image = {
      getSize: () => ({ width: 2, height: 2 }),
      resize: vi.fn(),
      toBitmap: () => Buffer.from(bitmap),
    };
    image.resize.mockReturnValue(image);

    const createSession = (mode: "legacy" | "contract_shadow") => {
      const session = recordingSession();
      const writes: Buffer[] = [];
      const captureBackend: CaptureBackendProvenance = {
        contract_version: 1,
        mode,
        selected_backend_id: "electron_external",
        attempted_backend_id: null,
        fallback_reason: null,
        delivery_mode: "host_frames",
        timestamp_source: "recording_media_clock",
        resolved_target_identity: "display:1",
        platform_version: process.platform,
        target_loss_reason: null,
        terminal_status: "pending",
      };
      Object.assign(session, {
        target: { kind: "display", display_id: 1 },
        width: 2,
        height: 2,
        captureDurationMs: [],
        lateFrames: 0,
        captureBackend,
        captureBackendDelivery:
          mode === "contract_shadow"
            ? new CaptureBackendDeliveryGuard(
                {
                  backend_id: "electron_external",
                  session_id: session.id,
                  ownership_token: session.id,
                },
                {
                  deliver: async () => {
                    throw new Error("shadow validator unavailable");
                  },
                },
              )
            : null,
        captureBackendDeliverySequence: 0,
        captureBackendFrameIndex: 0,
        captureBackendLastPtsUs: null,
        ffmpegProcess: {
          killed: false,
          stdin: {
            destroyed: false,
            writableLength: 0,
            write: (chunk: Uint8Array) => {
              writes.push(Buffer.from(chunk));
              return true;
            },
          },
        },
      });
      return { session, writes };
    };

    const legacy = createSession("legacy");
    const shadow = createSession("contract_shadow");
    await submitAuthorPreviewFrame(legacy.session, image as never);
    await submitAuthorPreviewFrame(shadow.session, image as never);

    expect(legacy.writes).toEqual([bitmap]);
    expect(shadow.writes).toEqual(legacy.writes);
    expect(shadow.session.mediaClock.snapshot()).toEqual(legacy.session.mediaClock.snapshot());
    expect(shadow.session.framesDropped).toBe(legacy.session.framesDropped);
    expect(shadow.session.encoderError).toBeNull();
  });

  it("commits readiness only after the encoder acknowledges a submitted frame", async () => {
    const session = recordingSession();
    session.streaming = true;
    const readiness = recordingReadiness.register({
      sessionId: session.id,
      mode: "enforce",
      sinkAcknowledgements: true,
    });
    readiness.markSourceReady();

    const queueFrame = vi.fn(async () => {
      readiness.markFrameSubmitted();
    });
    const outcome = readiness.require({
      barrier: "first_frame_committed",
      budgetMs: 1_000,
      requestedMediaUs: 0,
      queueFrame,
    });

    await vi.waitFor(() => expect(queueFrame).toHaveBeenCalled());
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeEncodedRecordingFrames(session, 1);

    await expect(outcome).resolves.toMatchObject({
      status: "committed",
      encoded_frames: 1,
      committed_landmark: { frameIndex: 0, ptsUs: 0 },
    });
    expect(session.frameSeq).toBe(1);
  });

  it("accepts a primary encoder ACK while the checkpoint mirror is still writing", async () => {
    const session = recordingSession();
    session.streaming = true;
    Object.assign(session, {
      target: { kind: "author_preview", stream_id: "preview-1" },
      width: 2,
      height: 2,
      sourceFramesReceived: 1,
      captureDurationMs: [],
      lateFrames: 0,
      ffmpegProcess: {
        killed: false,
        stdin: {
          destroyed: false,
          writableLength: 0,
          write: vi.fn(() => true),
        },
      },
    });
    const readiness = recordingReadiness.register({
      sessionId: session.id,
      mode: "enforce",
      sinkAcknowledgements: true,
    });
    readiness.markSourceReady();
    const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-ack-race-"));
    let releaseCheckpoint: () => void = () => {
      throw new Error("checkpoint write was not started");
    };
    const checkpointWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCheckpoint = resolve;
        }),
    );
    const coordinator = registerRecordingCheckpoints({
      sessionId: session.id,
      segmentsDir: checkpointDir,
      width: 2,
      height: 2,
      fps: 60,
      declareArtifacts: async () => {},
      encoderFactory: () => ({
        write: checkpointWrite,
        finish: async () => {},
        abort: async () => {},
      }),
    });
    await coordinator.beginScene({
      scene_id: "scene-1",
      scene_name: "Scene 1",
      scene_ordinal: 1,
      step_ordinal: 0,
    });
    const image = {
      getSize: () => ({ width: 2, height: 2 }),
      resize: vi.fn(),
      toBitmap: () => Buffer.alloc(16),
    };
    image.resize.mockReturnValue(image);

    const submission = submitAuthorPreviewFrame(session, image as never);
    await vi.waitFor(() => expect(checkpointWrite).toHaveBeenCalledTimes(1));
    acknowledgeEncodedRecordingFrames(session, 1);

    expect(readiness.snapshot()).toMatchObject({ submitted_frames: 1, encoded_frames: 1 });
    releaseCheckpoint();
    await submission;
    await disposeRecordingCheckpoints(session.id);
    await fs.rm(checkpointDir, { recursive: true, force: true });
  });

  it("requests a serialized frame and returns its committed media landmark", async () => {
    const session = recordingSession();
    let releaseInFlight: (() => void) | undefined;
    session.captureInFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    const queueFrame = vi.fn(async () => commitFrame(session));

    const outcome = requestRecordingFrameCommit(session, queueFrame);
    expect(queueFrame).not.toHaveBeenCalled();
    releaseInFlight?.();

    await expect(outcome).resolves.toEqual({
      status: "committed",
      landmark: { frameIndex: 0, ptsUs: 0 },
    });
    expect(queueFrame).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded degraded outcome when capture stays backpressured", async () => {
    vi.useFakeTimers();
    const session = recordingSession();
    session.captureInFlight = new Promise<void>(() => undefined);
    const queueFrame = vi.fn(async () => commitFrame(session));

    const outcome = requestRecordingFrameCommit(session, queueFrame);
    await vi.advanceTimersByTimeAsync(recordingFrameCommitBudgetMs(session));

    await expect(outcome).resolves.toEqual({
      status: "degraded",
      reason: "frame_commit_timeout",
    });
    expect(queueFrame).not.toHaveBeenCalled();
  });

  it("reports terminal encoder state and exposes a non-sensitive snapshot", async () => {
    const session = recordingSession();
    session.encoderError = new Error("secret encoder stderr");

    await expect(requestRecordingFrameCommit(session, vi.fn())).resolves.toEqual({
      status: "degraded",
      reason: "encoder_error",
    });
    expect(recordingCaptureStateSnapshot(session)).toEqual({
      session_id: session.id,
      lifecycle: "recording",
      paused: false,
      streaming: false,
      frame_count: 0,
      capture_in_flight: false,
      encoder_backpressured: false,
      encoder_error: true,
      frames_dropped: 0,
      skipped_ticks: 0,
    });
  });

  it("degrades a frame request when pause wins the in-flight drain race", async () => {
    const session = recordingSession();
    let releaseInFlight: (() => void) | undefined;
    session.captureInFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    const outcome = requestRecordingFrameCommit(session, vi.fn());

    session.paused = true;
    session.lifecycle = "paused";
    releaseInFlight?.();

    await expect(outcome).resolves.toEqual({
      status: "degraded",
      reason: "capture_paused",
    });
  });

  it("cancels requests after the recording session is removed", async () => {
    const session = recordingSession();
    recordingSessions.delete(session.id);

    await expect(requestRecordingFrameCommit(session, vi.fn())).resolves.toEqual({
      status: "cancelled",
    });
  });

  it("handles background capture rejection without leaving an unhandled promise", async () => {
    const session = recordingSession();
    scheduleRecordingFrame(session, async () => {
      throw new Error("capture unavailable");
    });

    await vi.waitFor(() => expect(session.framesDropped).toBe(1));
  });

  it("does not attach duplicate handlers while a scheduled capture is in flight", () => {
    const session = recordingSession();
    session.captureInFlight = new Promise<void>(() => undefined);
    const queueFrame = vi.fn(async () => undefined);

    scheduleRecordingFrame(session, queueFrame);
    scheduleRecordingFrame(session, queueFrame);

    expect(queueFrame).not.toHaveBeenCalled();
    expect(session.skippedTicks).toBe(2);
  });
});
