import type { RecordingStepTimingSidecar } from "@/ipc/trajectory";

import { useEditorStore } from "./store";
import type { SoundClip, TimelineSlice } from "./timeline-slice";

export type VoiceoverStepBinding = NonNullable<SoundClip["sourceBinding"]>;

export interface VoiceoverTimelineClipInput {
  filePath: string;
  durationMs: number;
  binding: VoiceoverStepBinding;
  label?: string;
}

function voiceoverClipId(binding: VoiceoverStepBinding): string {
  const identity = binding.stepId ?? `ordinal-${binding.ordinal}`;
  return `voiceover-${identity.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function voiceoverBindingMatches(
  candidate: VoiceoverStepBinding | undefined,
  binding: VoiceoverStepBinding,
): boolean {
  if (!candidate) return false;
  return binding.stepId === null
    ? candidate.stepId === null && candidate.ordinal === binding.ordinal
    : candidate.stepId === binding.stepId;
}

export function voiceoverStartMs(
  binding: VoiceoverStepBinding,
  stepTiming: RecordingStepTimingSidecar | null | undefined,
): number | null {
  const step =
    binding.stepId === null
      ? stepTiming?.steps.find((candidate) => candidate.ordinal === binding.ordinal)
      : stepTiming?.steps.find((candidate) => candidate.stepId === binding.stepId);
  return step ? Math.max(0, step.startMs) : null;
}

export function upsertVoiceoverTrackClip(
  tracks: TimelineSlice["tracks"],
  input: VoiceoverTimelineClipInput,
  options: {
    stepTiming?: RecordingStepTimingSidecar | null;
    fallbackStartMs?: number;
  } = {},
): TimelineSlice["tracks"] {
  const existing = tracks.sound.find(
    (clip) =>
      clip.kind === "voiceover" && voiceoverBindingMatches(clip.sourceBinding, input.binding),
  );
  const source = tracks.video[0];
  const startMs =
    voiceoverStartMs(input.binding, options.stepTiming) ??
    existing?.startMs ??
    Math.max(0, options.fallbackStartMs ?? 0);
  const next: SoundClip = {
    id: existing?.id ?? voiceoverClipId(input.binding),
    trackId: "sound",
    startMs,
    durationMs: Math.max(1, Math.round(input.durationMs)),
    path: input.filePath,
    kind: "voiceover",
    gain: existing?.gain ?? 1,
    label: input.label ?? existing?.label ?? "Voiceover",
    sourceBinding: input.binding,
    sourceRevision: source?.sourceRevision,
    sourceTimeMap: source?.sourceTimeMap,
  };
  return {
    ...tracks,
    sound: [...tracks.sound.filter((clip) => clip.id !== next.id), next].sort(
      (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
    ),
  };
}

export function commitVoiceoverTimelineClip(input: VoiceoverTimelineClipInput): void {
  useEditorStore.setState((state) => {
    const tracks = upsertVoiceoverTrackClip(state.tracks, input, {
      stepTiming: state._undoExtras?.stepTiming ?? null,
      fallbackStartMs: state.playheadMs,
    });
    const voiceover = tracks.sound.find(
      (clip) =>
        clip.kind === "voiceover" && voiceoverBindingMatches(clip.sourceBinding, input.binding),
    );
    const durationMs = voiceover
      ? Math.max(state.durationMs, voiceover.startMs + voiceover.durationMs)
      : state.durationMs;
    return { tracks, durationMs };
  });
}

export function reflowVoiceoverClips(
  clips: readonly SoundClip[],
  options: {
    stepTiming?: RecordingStepTimingSidecar | null;
    sourceRevision?: string;
    sourceTimeMap?: SoundClip["sourceTimeMap"];
  },
): { clips: SoundClip[]; unresolved: SoundClip[] } {
  const unresolved: SoundClip[] = [];
  const next = clips.map((clip) => {
    if (clip.kind !== "voiceover" || !clip.sourceBinding) return clip;
    const startMs = voiceoverStartMs(clip.sourceBinding, options.stepTiming);
    if (startMs === null) {
      unresolved.push(clip);
      return clip;
    }
    return {
      ...clip,
      startMs,
      sourceRevision: options.sourceRevision,
      sourceTimeMap: options.sourceTimeMap,
    };
  });
  return { clips: next, unresolved };
}
