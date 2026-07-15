import { describe, expect, it, vi } from "vitest";

vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));

import type { RecordingSession } from "./legacy/shared";
import { RecordingLifecycleController } from "./recording-lifecycle";
import { classifyRecordingOutcome } from "./recording-outcome";

function session(id = "session-1"): RecordingSession {
  return {
    id,
    paused: false,
    lifecycle: "recording",
    mediaClock: {
      pause: vi.fn(),
      resume: vi.fn(),
    },
    pauseGate: {
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    },
    actionLandmarks: { cancelAll: vi.fn() },
    eventTarget: { isDestroyed: () => false, send: vi.fn() },
    eventChannelId: 7,
  } as unknown as RecordingSession;
}

const encoded = {
  output_path: "/tmp/video.mp4",
  frames_written: 30,
  frames_dropped: 0,
  cadence_warning: null,
  bytes: 1024,
};

describe("RecordingLifecycleController", () => {
  it("guards the transition table and makes pause/resume idempotent", async () => {
    const controller = new RecordingLifecycleController({ sessions: new Map() });
    const value = session();
    await controller.register(value);
    expect((await controller.markRecording(value.id)).state).toBe("recording");
    await controller.pause(value.id);
    await controller.pause(value.id);
    expect(value.mediaClock.pause).toHaveBeenCalledTimes(1);
    await controller.resume(value.id);
    await controller.resume(value.id);
    expect(value.mediaClock.resume).toHaveBeenCalledTimes(1);
  });

  it("shares one finalizer and one stable terminal result across duplicate stops", async () => {
    const controller = new RecordingLifecycleController({ sessions: new Map() });
    const value = session();
    await controller.register(value);
    await controller.markRecording(value.id);
    const finalizer = vi.fn(async () => encoded);
    const first = controller.stop(value.id, { kind: "complete" }, finalizer);
    const second = controller.stop(value.id, { kind: "cancel", actor: "user" }, finalizer);
    const [a, b] = await Promise.all([first, second]);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.outcome.verdict).toBe("cancelled");
    expect(controller.status(value.id)?.terminal_outcome).toBe(a.outcome);
  });

  it("returns the sealed terminal when cancellation arrives after candidate sealing", async () => {
    const controller = new RecordingLifecycleController({ sessions: new Map() });
    const value = session("sealed");
    await controller.register(value);
    await controller.markRecording(value.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sealed!: () => void;
    const didSeal = new Promise<void>((resolve) => {
      sealed = resolve;
    });
    const finalizer = vi.fn(async () => {
      controller.sealIntent(value.id, { kind: "complete" });
      sealed();
      await held;
      return encoded;
    });

    const first = controller.stop(value.id, { kind: "complete" }, finalizer);
    await didSeal;
    const lateCancel = controller.stop(value.id, { kind: "cancel", actor: "user" }, finalizer);
    release();
    const [completed, cancelled] = await Promise.all([first, lateCancel]);

    expect(completed).toBe(cancelled);
    expect(completed.outcome.verdict).toBe("passed");
    expect(finalizer).toHaveBeenCalledTimes(1);
  });

  it("never classifies cancellation as passed and salvages non-empty media", async () => {
    const controller = new RecordingLifecycleController({ sessions: new Map() });
    const value = session();
    await controller.register(value);
    await controller.markRecording(value.id);
    const terminal = await controller.stop(
      value.id,
      { kind: "cancel", actor: "user" },
      async () => encoded,
    );
    expect(terminal.snapshot.state).toBe("cancelled");
    expect(terminal.outcome).toMatchObject({
      verdict: "cancelled",
      reason_code: "cancelled_by_user",
    });
  });

  it("keeps cancellation terminal when salvage finalization fails", async () => {
    const controller = new RecordingLifecycleController({ sessions: new Map() });
    const value = session();
    await controller.register(value);
    await controller.markRecording(value.id);
    const terminal = await controller.stop(
      value.id,
      { kind: "cancel", actor: "host" },
      async () => {
        throw new Error("encoder failed");
      },
    );
    expect(terminal.snapshot.state).toBe("cancelled");
    expect(terminal.outcome.verdict).toBe("cancelled");
    expect(terminal.error_message).toBe("encoder failed");
  });

  it("expires and caps terminal cache entries", async () => {
    let now = 1_000;
    const controller = new RecordingLifecycleController({
      sessions: new Map(),
      now: () => now,
      terminalTtlMs: 100,
      terminalMaxEntries: 1,
    });
    for (const id of ["one", "two"]) {
      const value = session(id);
      await controller.register(value);
      await controller.markRecording(id);
      await controller.stop(id, { kind: "complete" }, async () => encoded);
    }
    expect(controller.status("one")).toBeNull();
    expect(controller.status("two")).not.toBeNull();
    now += 101;
    expect(controller.status("two")).toBeNull();
  });

  it("fails closed when strict finalization claims success without a committed bundle", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_MODE", "strict");
    try {
      const controller = new RecordingLifecycleController({ sessions: new Map() });
      const value = session("strict-uncommitted");
      await controller.register(value);
      await controller.markRecording(value.id);
      const claimedPassed = classifyRecordingOutcome({
        session_id: value.id,
        automation: {
          exit_reason: "completed",
          total_steps: 1,
          succeeded: 1,
          failed: 0,
          failed_ordinal: null,
        },
        capture: {
          output_path: encoded.output_path,
          frames_written: encoded.frames_written,
          frames_dropped: encoded.frames_dropped,
          cadence_warning: encoded.cadence_warning,
          finalized: true,
        },
        artifact_readable: true,
      });

      const terminal = await controller.stop(value.id, { kind: "complete" }, async () => ({
        ...encoded,
        terminal_outcome: claimedPassed,
        canonical_bundle_committed: false,
      }));

      expect(terminal.outcome).toMatchObject({
        verdict: "failed",
        reason_code: "bundle_commit_failed",
      });
      expect(terminal.terminal_event.disposition).toMatchObject({
        show_complete: false,
        can_publish: false,
        auto_open_take: false,
        retain_bundle: false,
      });
      expect(value.eventTarget.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caches the strict shadow candidate without emitting a strict terminal", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_MODE", "shadow");
    try {
      const controller = new RecordingLifecycleController({ sessions: new Map() });
      const value = session("shadow-candidate");
      await controller.register(value);
      await controller.markRecording(value.id);
      const legacyOutcome = classifyRecordingOutcome({
        session_id: value.id,
        automation: {
          exit_reason: "completed",
          total_steps: 1,
          succeeded: 1,
          failed: 0,
          failed_ordinal: null,
        },
        capture: {
          output_path: encoded.output_path,
          frames_written: encoded.frames_written,
          frames_dropped: encoded.frames_dropped,
          cadence_warning: encoded.cadence_warning,
          finalized: true,
        },
        artifact_readable: true,
      });
      const strictCandidate = classifyRecordingOutcome({
        session_id: value.id,
        automation: {
          exit_reason: "failed",
          total_steps: 1,
          succeeded: 0,
          failed: 1,
          failed_ordinal: 1,
        },
        capture: legacyOutcome.capture,
        artifact_readable: true,
      });

      const terminal = await controller.stop(value.id, { kind: "complete" }, async () => ({
        ...encoded,
        terminal_outcome: legacyOutcome,
        shadow_terminal_outcome: strictCandidate,
        canonical_bundle_committed: true,
      }));

      expect(terminal.outcome_mode).toBe("shadow");
      expect(terminal.outcome).toBe(strictCandidate);
      expect(terminal.legacy_result?.terminal_outcome).toBe(legacyOutcome);
      expect(controller.status(value.id)?.terminal_outcome).toBe(strictCandidate);
      expect(value.eventTarget.send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a strict terminal replayable when channel delivery throws", async () => {
    vi.stubEnv("STORYCAPTURE_RECORDING_OUTCOME_MODE", "strict");
    try {
      const controller = new RecordingLifecycleController({ sessions: new Map() });
      const value = session("delivery-failure");
      vi.mocked(value.eventTarget.send).mockImplementation(() => {
        throw new Error("renderer destroyed");
      });
      await controller.register(value);
      await controller.markRecording(value.id);

      const first = await controller.stop(value.id, { kind: "complete" }, async () => encoded);
      const replay = await controller.stop(value.id, { kind: "complete" }, async () => {
        throw new Error("must not run");
      });

      expect(replay).toBe(first);
      expect(controller.status(value.id)?.terminal_event).toBe(first.terminal_event);
      expect(value.eventTarget.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
