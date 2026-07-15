import { describe, expect, it } from "vitest";

import {
  buildLegacyRecordingAvMuxArgs,
  buildRecordingAvMuxPlan,
  classifyRecordingAv,
  monotonicEpochMilliseconds,
  RECORDING_AV_MAX_MUX_DURATION_US,
  type RecordingAudioStreamSnapshot,
  RecordingAudioStreamValidator,
  type RecordingAvAlignment,
  RecordingAvClock,
  RecordingAvClockError,
  RecordingAvSessionRegistry,
  recordingAvMode,
  recordingUsesLiveVideoSink,
  serializeRecordingAvSnapshot,
} from "./recording-av-clock";

describe("recording A/V rollout mode", () => {
  it("defaults unknown values to legacy and accepts the two opt-in modes", () => {
    expect(recordingAvMode(undefined)).toBe("legacy");
    expect(recordingAvMode("legacy")).toBe("legacy");
    expect(recordingAvMode("shadow")).toBe("shadow");
    expect(recordingAvMode("unified")).toBe("unified");
    expect(recordingAvMode("invalid")).toBe("legacy");
  });

  it("preserves legacy media selection until unified while readiness enforcement wins", () => {
    const selected = (mode: "legacy" | "shadow" | "unified", audioRequested: boolean) =>
      recordingUsesLiveVideoSink({
        mode,
        targetKind: "author_preview",
        audioRequested,
        readinessEnforced: false,
      });

    expect(selected("legacy", false)).toBe(true);
    expect(selected("legacy", true)).toBe(false);
    expect(selected("shadow", false)).toBe(true);
    expect(selected("shadow", true)).toBe(false);
    expect(selected("unified", true)).toBe(true);
    expect(
      recordingUsesLiveVideoSink({
        mode: "legacy",
        targetKind: "display",
        audioRequested: true,
        readinessEnforced: true,
      }),
    ).toBe(true);
  });
});

describe("legacy recording A/V mux", () => {
  it("pads and trims audio to the explicit video duration without -shortest", () => {
    const args = buildLegacyRecordingAvMuxArgs({
      videoDurationUs: 3_000_000,
      videoInputPath: "/take/video.silent.mp4",
      audioInputPath: "/take/microphone.webm",
      outputPath: "/take/video.mp4",
    });

    expect(args.join(" ")).toContain("apad=whole_dur=3.000000");
    expect(args.join(" ")).toContain("atrim=start=0:end=3.000000");
    expect(args).toContain("-t");
    expect(args).not.toContain("-shortest");
  });
});

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(RecordingAvClockError);
    return (error as RecordingAvClockError).code;
  }
}

function completedAudio(input?: {
  startedAtMs?: number;
  endedAtMs?: number;
  mimeType?: string;
}): Readonly<RecordingAudioStreamSnapshot> {
  const startedAtMs = input?.startedAtMs ?? 1_000;
  const endedAtMs = input?.endedAtMs ?? 2_000;
  const stream = new RecordingAudioStreamValidator();
  stream.begin({
    sequence: 0,
    sessionId: "session-1",
    audioCaptureId: "audio-1",
    monotonicEpochMs: startedAtMs,
    mimeType: input?.mimeType ?? "audio/webm;codecs=opus",
  });
  stream.prepareChunk({
    sequence: 1,
    monotonicEpochMs: Math.max(startedAtMs, endedAtMs - 1),
    byteLength: 128,
    durationUs: Math.max(0, Math.round((endedAtMs - startedAtMs) * 1_000)),
  });
  stream.acknowledgeChunk(1);
  stream.end({
    sequence: 2,
    monotonicEpochMs: endedAtMs,
    totalBytes: 128,
    totalChunks: 1,
  });
  return stream.snapshot();
}

function muxAlignment(startOffsetUs: number, durationUs = 3_000_000): RecordingAvAlignment {
  return {
    clock: "encoded_video_pts",
    unit: "us",
    video_start_pts_us: 0,
    video_end_pts_us: durationUs,
    video_duration_us: durationUs,
    video_origin_monotonic_epoch_ms: 1_000,
    finalized_monotonic_epoch_ms: 4_000,
    audio_start_offset_us: startOffsetUs,
    audio_end_drift_us: 0,
    audio_active_duration_us: durationUs,
    audio_mapped_start_pts_us: startOffsetUs,
    audio_mapped_end_pts_us: durationUs,
    pause_spans: [],
  };
}

describe("recording audio stream validation", () => {
  it("acknowledges durable chunks in order and makes exact duplicates idempotent", () => {
    const stream = new RecordingAudioStreamValidator();
    const begin = {
      sequence: 0,
      sessionId: "session-1",
      audioCaptureId: "capture-1",
      monotonicEpochMs: 10_000,
      mimeType: "audio/webm;codecs=opus",
    };
    stream.begin(begin);
    expect(stream.begin(begin)).toMatchObject({ status: "duplicate", durable: true });
    const chunk = {
      sequence: 1,
      monotonicEpochMs: 11_000,
      byteLength: 512,
      durationUs: 1_000_000,
    };

    expect(stream.prepareChunk(chunk)).toMatchObject({
      status: "accepted",
      durable: false,
      nextSequence: 1,
    });
    expect(stream.prepareChunk(chunk)).toMatchObject({ status: "duplicate", durable: false });
    expect(stream.acknowledgeChunk(1)).toMatchObject({
      status: "accepted",
      durable: true,
      nextSequence: 2,
    });
    expect(stream.prepareChunk(chunk)).toMatchObject({ status: "duplicate", durable: true });
    expect(stream.acknowledgeChunk(1)).toMatchObject({ status: "duplicate", durable: true });
    expect(stream.snapshot()).toMatchObject({
      state: "streaming",
      next_sequence: 2,
      chunks_durable: 1,
      bytes_durable: 512,
      pending_sequence: null,
    });

    const end = {
      sequence: 2,
      monotonicEpochMs: 12_000,
      totalBytes: 512,
      totalChunks: 1,
    };
    stream.end(end);
    expect(stream.end(end)).toMatchObject({ status: "duplicate", durable: true });
  });

  it("fails gaps and conflicting duplicate metadata with stable reason codes", () => {
    const gap = new RecordingAudioStreamValidator();
    gap.begin({
      sequence: 0,
      sessionId: "session-gap",
      audioCaptureId: "capture-gap",
      monotonicEpochMs: 100,
      mimeType: "audio/webm",
    });

    expect(
      errorCode(() =>
        gap.prepareChunk({
          sequence: 2,
          monotonicEpochMs: 200,
          byteLength: 1,
        }),
      ),
    ).toBe("audio_sequence_gap");
    expect(gap.snapshot()).toMatchObject({ state: "failed", failure_reason: "audio_sequence_gap" });

    const conflict = new RecordingAudioStreamValidator();
    conflict.begin({
      sequence: 0,
      sessionId: "session-conflict",
      audioCaptureId: "capture-conflict",
      monotonicEpochMs: 100,
      mimeType: "audio/webm",
    });
    conflict.prepareChunk({ sequence: 1, monotonicEpochMs: 200, byteLength: 10 });
    conflict.acknowledgeChunk(1);

    expect(
      errorCode(() =>
        conflict.prepareChunk({ sequence: 1, monotonicEpochMs: 200, byteLength: 11 }),
      ),
    ).toBe("audio_sequence_conflict");
  });

  it("does not accept end until the final chunk is durable", () => {
    const undrained = new RecordingAudioStreamValidator();
    undrained.begin({
      sequence: 0,
      sessionId: "session-undrained",
      audioCaptureId: "capture-undrained",
      monotonicEpochMs: 1_000,
      mimeType: "audio/webm",
    });
    undrained.prepareChunk({ sequence: 1, monotonicEpochMs: 2_000, byteLength: 100 });

    expect(
      errorCode(() =>
        undrained.end({
          sequence: 2,
          monotonicEpochMs: 2_001,
          totalBytes: 100,
          totalChunks: 1,
        }),
      ),
    ).toBe("audio_drain_incomplete");
    expect(undrained.snapshot().final_drain_complete).toBe(false);

    const drained = new RecordingAudioStreamValidator();
    drained.begin({
      sequence: 0,
      sessionId: "session-drained",
      audioCaptureId: "capture-drained",
      monotonicEpochMs: 1_000,
      mimeType: "audio/webm",
    });
    drained.prepareChunk({ sequence: 1, monotonicEpochMs: 2_000, byteLength: 100 });
    drained.acknowledgeChunk(1);
    expect(
      drained.end({
        sequence: 2,
        monotonicEpochMs: 2_001,
        totalBytes: 100,
        totalChunks: 1,
      }),
    ).toMatchObject({ status: "accepted", durable: true, nextSequence: 3 });
    expect(drained.snapshot()).toMatchObject({ state: "ended", final_drain_complete: true });
  });

  it("preserves the MediaRecorder MIME type and its matching container", () => {
    const audio = completedAudio({ mimeType: "audio/webm;codecs=opus" });

    expect(audio.mime_type).toBe("audio/webm;codecs=opus");
    expect(audio.container).toBe("webm");
  });
});

describe("recording A/V clock", () => {
  it("derives monotonic epoch milliseconds without using wall-clock time", () => {
    expect(monotonicEpochMilliseconds(1_700_000_000_000, 12_345.25)).toBe(1_700_000_012_345.25);
  });

  it("normalizes pauses to a zero-duration point on the encoded-video timeline", () => {
    const audio = new RecordingAudioStreamValidator();
    audio.begin({
      sequence: 0,
      sessionId: "session-pause",
      audioCaptureId: "capture-pause",
      monotonicEpochMs: 1_000,
      mimeType: "audio/webm",
    });
    audio.pause({ sequence: 1, monotonicEpochMs: 2_000 });
    audio.resume({ sequence: 2, monotonicEpochMs: 3_000 });
    audio.prepareChunk({ sequence: 3, monotonicEpochMs: 4_000, byteLength: 64 });
    audio.acknowledgeChunk(3);
    audio.end({
      sequence: 4,
      monotonicEpochMs: 5_000,
      totalBytes: 64,
      totalChunks: 1,
    });

    const clock = new RecordingAvClock("session-pause");
    clock.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: 1_000 });
    clock.pause(2_000);
    expect(clock.pause(2_000)).toBe("duplicate");
    clock.resume(3_000);
    expect(clock.resume(3_000)).toBe("duplicate");
    clock.observeEncodedVideoFrame({ ptsUs: 2_966_667, monotonicEpochMs: 4_967 });

    const alignment = clock.alignment({
      videoEndPtsUs: 3_000_000,
      finalizedMonotonicEpochMs: 5_000,
      audioStream: audio.snapshot(),
    });

    expect(alignment).toMatchObject({
      clock: "encoded_video_pts",
      video_duration_us: 3_000_000,
      audio_start_offset_us: 0,
      audio_end_drift_us: 0,
      audio_active_duration_us: 3_000_000,
    });
    expect(alignment.pause_spans).toEqual([
      {
        started_monotonic_epoch_ms: 2_000,
        ended_monotonic_epoch_ms: 3_000,
        duration_us: 1_000_000,
        normalized_start_pts_us: 1_000_000,
        normalized_end_pts_us: 1_000_000,
      },
    ]);
  });

  it("treats the inclusive 80 ms drift boundary as pass", () => {
    const pass = classifyRecordingAv({
      audioRequested: true,
      audioReadable: true,
      audioStreamComplete: true,
      muxSucceeded: true,
      muxValidated: true,
      explicitVideoDurationBounded: true,
      audioStartOffsetUs: 80_000,
      audioEndDriftUs: -80_000,
    });
    const degraded = classifyRecordingAv({
      audioRequested: true,
      audioReadable: true,
      audioStreamComplete: true,
      muxSucceeded: true,
      muxValidated: true,
      explicitVideoDurationBounded: true,
      audioStartOffsetUs: 80_001,
      audioEndDriftUs: -80_001,
    });

    expect(pass).toEqual({ verdict: "pass", reasons: [], drift_limit_us: 80_000 });
    expect(degraded).toEqual({
      verdict: "degraded",
      reasons: ["av_start_drift_exceeded", "av_end_drift_exceeded"],
      drift_limit_us: 80_000,
    });
  });

  it("holds a ten-minute video-master clock across two pause spans", () => {
    const origin = 10_000;
    const audio = new RecordingAudioStreamValidator();
    audio.begin({
      sequence: 0,
      sessionId: "session-ten-minute",
      audioCaptureId: "capture-ten-minute",
      monotonicEpochMs: origin + 40,
      mimeType: "audio/webm;codecs=opus",
    });
    audio.prepareChunk({ sequence: 1, monotonicEpochMs: origin + 100_000, byteLength: 1_024 });
    audio.acknowledgeChunk(1);
    audio.pause({ sequence: 2, monotonicEpochMs: origin + 120_000 });
    audio.resume({ sequence: 3, monotonicEpochMs: origin + 125_000 });
    audio.pause({ sequence: 4, monotonicEpochMs: origin + 425_000 });
    audio.resume({ sequence: 5, monotonicEpochMs: origin + 430_000 });
    audio.prepareChunk({
      sequence: 6,
      monotonicEpochMs: origin + 610_020,
      byteLength: 2_048,
    });
    audio.acknowledgeChunk(6);
    audio.end({
      sequence: 7,
      monotonicEpochMs: origin + 610_040,
      totalBytes: 3_072,
      totalChunks: 2,
    });

    const clock = new RecordingAvClock("session-ten-minute");
    clock.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: origin });
    clock.pause(origin + 120_000);
    clock.resume(origin + 125_000);
    clock.pause(origin + 425_000);
    clock.resume(origin + 430_000);
    clock.observeEncodedVideoFrame({
      ptsUs: 599_966_667,
      monotonicEpochMs: origin + 610_000,
    });
    const snapshot = clock.finalize({
      videoEndPtsUs: 600_000_000,
      finalizedMonotonicEpochMs: origin + 610_000,
      audioStream: audio.snapshot(),
      audioReadable: true,
      muxSucceeded: true,
      muxValidated: true,
      explicitVideoDurationBounded: true,
    });

    expect(snapshot).toMatchObject({
      video_duration_us: 600_000_000,
      audio_start_offset_us: 40_000,
      audio_end_drift_us: 40_000,
      outcome: { verdict: "pass", reasons: [] },
    });
    expect(snapshot.pause_spans.map((span) => span.duration_us)).toEqual([5_000_000, 5_000_000]);
  });

  it("rejects impossible transitions and non-increasing encoded PTS", () => {
    const resumedTooSoon = new RecordingAvClock("session-invalid-resume");
    expect(errorCode(() => resumedTooSoon.resume(1_000))).toBe("av_clock_transition_invalid");

    const pts = new RecordingAvClock("session-invalid-pts");
    pts.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: 1_000 });
    expect(
      errorCode(() => pts.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: 1_001 })),
    ).toBe("video_pts_invalid");
  });

  it("produces an immutable, JSON-safe snapshot without captured media bytes or paths", () => {
    const audio = completedAudio({ startedAtMs: 1_000, endedAtMs: 2_000 });
    const clock = new RecordingAvClock("session-json");
    clock.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: 1_000 });
    clock.observeEncodedVideoFrame({ ptsUs: 966_667, monotonicEpochMs: 1_967 });
    const snapshot = clock.finalize({
      videoEndPtsUs: 1_000_000,
      finalizedMonotonicEpochMs: 2_000,
      audioStream: audio,
      audioReadable: true,
      muxSucceeded: true,
      muxValidated: true,
      explicitVideoDurationBounded: true,
    });
    const json = serializeRecordingAvSnapshot(snapshot);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.audio)).toBe(true);
    expect(parsed).toMatchObject({
      version: 1,
      session_id: "session-json",
      clock: "encoded_video_pts",
    });
    expect(json).not.toContain("output_path");
    expect(json).not.toContain("audioInputPath");
    expect(json).not.toContain("Uint8Array");
  });
});

describe("recording A/V mux plan", () => {
  it("delays late audio, resamples, pads, trims, and explicitly bounds video-master duration", () => {
    const plan = buildRecordingAvMuxPlan({
      alignment: muxAlignment(80_000),
      audio: { mime_type: "audio/webm;codecs=opus", container: "webm" },
      videoInputPath: "/take/video.silent.mp4",
      audioInputPath: "/take/microphone.webm",
      outputPath: "/take/video.muxing.mp4",
    });
    const args = plan.args.join(" ");

    expect(plan).toMatchObject({
      master_clock: "encoded_video_pts",
      audio_mime_type: "audio/webm;codecs=opus",
      audio_container: "webm",
      adjustment: "delay",
      duration_us: 3_000_000,
    });
    expect(plan.filter_complex).toContain("atrim=start=0");
    expect(plan.filter_complex).toContain("adelay=80.000:all=1");
    expect(plan.filter_complex).toContain("aresample=async=1:first_pts=0");
    expect(plan.filter_complex).toContain("apad=whole_dur=3.000000");
    expect(plan.filter_complex).toContain("atrim=start=0:end=3.000000");
    expect(args).toContain("-t 3.000000");
    expect(plan.args).not.toContain("-shortest");
  });

  it("trims early audio and preserves a non-WebM MIME/container pair", () => {
    const plan = buildRecordingAvMuxPlan({
      alignment: muxAlignment(-125_000),
      audio: { mime_type: "audio/ogg; codecs=opus", container: "ogg" },
      videoInputPath: "/take/video.silent.mp4",
      audioInputPath: "/take/microphone.ogg",
      outputPath: "/take/video.muxing.mp4",
    });

    expect(plan.adjustment).toBe("trim");
    expect(plan.audio_mime_type).toBe("audio/ogg; codecs=opus");
    expect(plan.audio_container).toBe("ogg");
    expect(plan.filter_complex).toContain("[1:a]atrim=start=0.125000");
    expect(plan.filter_complex).not.toContain("adelay=");
  });

  it("rejects an unbounded duration instead of silently truncating it", () => {
    expect(
      errorCode(() =>
        buildRecordingAvMuxPlan({
          alignment: muxAlignment(0, RECORDING_AV_MAX_MUX_DURATION_US + 1),
          audio: { mime_type: "audio/webm", container: "webm" },
          videoInputPath: "/take/video.silent.mp4",
          audioInputPath: "/take/microphone.webm",
          outputPath: "/take/video.muxing.mp4",
        }),
      ),
    ).toBe("mux_duration_unbounded");
  });
});

describe("recording A/V session registry", () => {
  it("owns the silent-video path, capture identity, pause gate, and terminal audio drain", async () => {
    const registry = new RecordingAvSessionRegistry();
    const runtime = registry.register({
      sessionId: "take-1",
      audioRequested: true,
      audioCaptureId: "audio-1",
      videoOutputPath: "/take/video.mp4",
      registeredMonotonicEpochMs: 1_000,
    });

    expect(runtime.videoOnlyPath).toBe("/take/video.video-only.mp4");
    runtime.assertAudioCaptureId("audio-1");
    expect(() => runtime.assertAudioCaptureId("audio-2")).toThrow(RecordingAvClockError);
    expect(runtime.observeEncodedVideoFrame({ ptsUs: 0, monotonicEpochMs: 1_000 })).toBe(true);
    runtime.pause(1_010);
    expect(runtime.observeEncodedVideoFrame({ ptsUs: 33_333, monotonicEpochMs: 1_011 })).toBe(
      false,
    );
    runtime.resume(1_020);
    expect(runtime.observeEncodedVideoFrame({ ptsUs: 66_666, monotonicEpochMs: 1_030 })).toBe(true);

    runtime.audio.begin({
      sequence: 0,
      sessionId: "take-1",
      audioCaptureId: "audio-1",
      monotonicEpochMs: 1_000,
      mimeType: "audio/webm",
    });
    runtime.audio.end({
      sequence: 1,
      monotonicEpochMs: 1_040,
      totalBytes: 0,
      totalChunks: 0,
    });
    runtime.markAudioTerminal();

    await expect(runtime.waitForAudioTerminal(10)).resolves.toMatchObject({
      state: "ended",
      final_drain_complete: true,
    });
    registry.remove("take-1");
    expect(registry.get("take-1")).toBeNull();
  });

  it("keeps the canonical video path when audio was not requested", () => {
    const registry = new RecordingAvSessionRegistry();
    const runtime = registry.register({
      sessionId: "take-2",
      audioRequested: false,
      videoOutputPath: "/take/video.mp4",
      registeredMonotonicEpochMs: 1_000,
    });

    expect(runtime.videoOnlyPath).toBe("/take/video.mp4");
  });
});
