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

vi.mock("../recording-observability", () => ({
  recordEngineLog: vi.fn(async () => null),
}));

import { RecordingActionLandmarkRecorder } from "../action-landmarks";
import { RecordingMediaClock } from "../recording-media-clock";
import {
  recordingCaptureStateSnapshot,
  recordingFrameCommitBudgetMs,
  requestRecordingFrameCommit,
  scheduleRecordingFrame,
} from "./capture-preview";
import { type RecordingSession, recordingSessions } from "./shared";

function recordingSession(): RecordingSession {
  const session = {
    id: "recording-frame-sync",
    target: { kind: "display", display_id: 1 },
    width: 1280,
    height: 720,
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
    frameSeq: 0,
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
  recordingSessions.clear();
});

describe("recording frame synchronization", () => {
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
