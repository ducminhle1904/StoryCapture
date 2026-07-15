import { describe, expect, it } from "vitest";

import type { RecordingStepTimingSidecar } from "@/ipc/trajectory";

import type { SoundClip, TimelineSlice } from "./timeline-slice";
import {
  reflowVoiceoverClips,
  upsertVoiceoverTrackClip,
  voiceoverStartMs,
} from "./voiceover-timeline";

const TIMING: RecordingStepTimingSidecar = {
  version: 1,
  recordingPath: "/recording.mp4",
  storyHash: "story",
  timebase: "recording-ms",
  status: "completed",
  steps: [
    {
      ordinal: 2,
      stepId: "checkout",
      sceneName: "Checkout",
      verb: "click",
      startMs: 2_400,
      endMs: 3_000,
      durationMs: 600,
      status: "succeeded",
      confidence: "high",
    },
  ],
};

function tracks(): TimelineSlice["tracks"] {
  return {
    video: [
      {
        id: "video",
        trackId: "video",
        startMs: 0,
        durationMs: 5_000,
        sourcePath: "/recording.mp4",
        sourceRevision: "revision-a",
      },
    ],
    cursor: [],
    zoom: [],
    sound: [],
    annotations: [],
  };
}

describe("voiceover timeline binding", () => {
  it("upserts generated TTS on the sound timeline at its stable step timing", () => {
    const result = upsertVoiceoverTrackClip(
      tracks(),
      {
        filePath: "/tts/checkout.wav",
        durationMs: 1_250,
        binding: { kind: "story-voiceover", stepId: "checkout", ordinal: 2 },
      },
      { stepTiming: TIMING },
    );

    expect(result.sound).toEqual([
      expect.objectContaining({
        id: "voiceover-checkout",
        kind: "voiceover",
        path: "/tts/checkout.wav",
        startMs: 2_400,
        durationMs: 1_250,
        sourceRevision: "revision-a",
        sourceBinding: { kind: "story-voiceover", stepId: "checkout", ordinal: 2 },
      }),
    ]);
  });

  it("reflows a persisted voiceover after source timing changes", () => {
    const clip: SoundClip = {
      id: "voiceover-checkout",
      trackId: "sound",
      startMs: 900,
      durationMs: 1_250,
      path: "/tts/checkout.wav",
      kind: "voiceover",
      sourceRevision: "revision-a",
      sourceBinding: { kind: "story-voiceover", stepId: "checkout", ordinal: 2 },
    };
    const firstStep = TIMING.steps.at(0);
    if (!firstStep) throw new Error("expected a source timing step");
    const timing = {
      ...TIMING,
      steps: [{ ...firstStep, startMs: 3_600, endMs: 4_200 }],
    };

    const result = reflowVoiceoverClips([clip], {
      stepTiming: timing,
      sourceRevision: "revision-b",
    });

    expect(result.unresolved).toEqual([]);
    expect(result.clips[0]).toMatchObject({ startMs: 3_600, sourceRevision: "revision-b" });
  });

  it("does not fall back to an ordinal when a stable step id no longer matches", () => {
    expect(
      voiceoverStartMs({ kind: "story-voiceover", stepId: "different-step", ordinal: 2 }, TIMING),
    ).toBeNull();
    expect(voiceoverStartMs({ kind: "story-voiceover", stepId: null, ordinal: 2 }, TIMING)).toBe(
      2_400,
    );
  });

  it("preserves clip edits when the same stable step moves to a new ordinal", () => {
    const current = tracks();
    current.sound = [
      {
        id: "voiceover-checkout",
        trackId: "sound",
        startMs: 900,
        durationMs: 1_000,
        path: "/tts/old.wav",
        kind: "voiceover",
        gain: 0.65,
        sourceBinding: { kind: "story-voiceover", stepId: "checkout", ordinal: 1 },
      },
    ];

    const result = upsertVoiceoverTrackClip(current, {
      filePath: "/tts/new.wav",
      durationMs: 1_500,
      binding: { kind: "story-voiceover", stepId: "checkout", ordinal: 2 },
    });

    expect(result.sound).toHaveLength(1);
    expect(result.sound[0]).toMatchObject({
      id: "voiceover-checkout",
      gain: 0.65,
      path: "/tts/new.wav",
      sourceBinding: { kind: "story-voiceover", stepId: "checkout", ordinal: 2 },
    });
  });
});
