import { describe, expect, it } from "vitest";
import {
  AuthorPreviewTabGrantBroker,
  createRecordingAudioTrackRequest,
  RecordingAudioTrackRegistry,
  recordingAudioMode,
  validateRecordingAudioSelection,
} from "./audio-tracks";

function request(
  role: "microphone" | "tab" | "system",
  requirement: "required" | "optional" = "optional",
) {
  return createRecordingAudioTrackRequest({ role, requirement, source_id: `${role}-source` });
}

describe("recording audio track selection", () => {
  it("keeps legacy as the safe default", () => {
    expect(recordingAudioMode(undefined)).toBe("legacy");
    expect(recordingAudioMode("multitrack_shadow")).toBe("multitrack_shadow");
  });

  it("enforces target-specific program audio", () => {
    expect(() => validateRecordingAudioSelection("author_preview", [request("system")])).toThrow(
      "system audio is forbidden",
    );
    expect(() => validateRecordingAudioSelection("display", [request("tab")])).toThrow(
      "tab audio requires",
    );
    expect(() =>
      validateRecordingAudioSelection("author_preview", [request("microphone"), request("tab")]),
    ).not.toThrow();
  });

  it("rejects duplicate roles", () => {
    expect(() =>
      validateRecordingAudioSelection("author_preview", [
        request("microphone"),
        request("microphone"),
      ]),
    ).toThrow("duplicate audio role");
  });
});

describe("RecordingAudioTrackRegistry", () => {
  it("authenticates identity and records media-clock PTS", () => {
    const registry = new RecordingAudioTrackRegistry();
    const track = request("tab", "required");
    registry.register({
      sessionId: "session-1",
      targetKind: "author_preview",
      originMonotonicEpochMs: 1_000,
      requests: [track],
    });
    const identity = {
      session_id: "session-1",
      track_id: track.track_id,
      role: track.role,
      source_id: track.source_id,
      capture_token: track.capture_token,
    };
    registry.begin(identity, { sequence: 0, relativePath: "audio/tab.webm", container: "webm" });
    registry.chunk(identity, {
      sequence: 1,
      byteLength: 32,
      ptsUs: 33_333,
      monotonicEpochMs: 9_999,
      durationUs: 20_000,
    });
    const completed = registry.complete(identity, { sequence: 2, totalBytes: 32, totalChunks: 1 });
    expect(completed).toMatchObject({
      requirement: "required",
      status: "completed",
      first_pts_us: 33_333,
      last_pts_us: 53_333,
      duration_us: 20_000,
    });
  });

  it("rejects stale, mismatched, and post-terminal chunks", () => {
    const registry = new RecordingAudioTrackRegistry();
    const track = request("microphone");
    registry.register({
      sessionId: "session-1",
      targetKind: "display",
      originMonotonicEpochMs: 0,
      requests: [track],
    });
    const identity = {
      session_id: "session-1",
      track_id: track.track_id,
      role: track.role,
      source_id: track.source_id,
      capture_token: track.capture_token,
    };
    expect(() => registry.authenticate({ ...identity, capture_token: "wrong" })).toThrow(
      "identity mismatch",
    );
    registry.begin(identity, { sequence: 0, relativePath: "audio/mic.webm", container: "webm" });
    registry.complete(identity, { sequence: 1, totalBytes: 0, totalChunks: 0 });
    expect(registry.descriptors("session-1")[0]).toMatchObject({
      status: "failed",
      failure_reason: "audio_zero_samples",
    });
    expect(() =>
      registry.chunk(identity, {
        sequence: 2,
        byteLength: 1,
        monotonicEpochMs: 1,
        durationUs: 1,
      }),
    ).toThrow("not writable");
    registry.remove("session-1");
    expect(() => registry.authenticate(identity)).toThrow("stale");
  });
});

describe("AuthorPreviewTabGrantBroker", () => {
  it("grants exactly once to the expected internal frame", () => {
    const broker = new AuthorPreviewTabGrantBroker();
    const requester = {} as never;
    const source = {} as never;
    broker.arm({
      sessionId: "session-1",
      trackId: "tab-1",
      captureToken: "secret",
      requester,
      source,
    });
    expect(broker.consume({} as never)).toBeNull();
    expect(broker.consume(requester)).toMatchObject({ sessionId: "session-1", source });
    expect(broker.consume(requester)).toBeNull();
  });
});
