import { bundledBackgroundAssetIdFromPath } from "./background-asset";
import type { EditorBackgroundKind } from "./store";
import { DEFAULT_BACKGROUND } from "./store";
import type { TimelineSlice } from "./timeline-slice";
import { cloneTimelineTracks } from "./timeline-slice";

export const TIMELINE_LAYOUT_VERSION = 4;
export const TIMELINE_TIMING_MODEL_VERSION = 1;

export interface TimelineLayoutV4 {
  version: typeof TIMELINE_LAYOUT_VERSION;
  timingModelVersion: typeof TIMELINE_TIMING_MODEL_VERSION;
  sourceRevision: string | null;
  tracks: TimelineSlice["tracks"];
  durationMs: number;
  background: EditorBackgroundKind;
}

export type TimelineLayoutParseResult =
  | { ok: true; layout: TimelineLayoutV4; migrated: boolean; rebuiltGeneratedLayers: boolean }
  | { ok: false; reason: string };

/** Compatibility alias for callers that only depend on the current layout shape. */
export type TimelineLayoutV3 = TimelineLayoutV4;
export type TimelineLayoutV2 = TimelineLayoutV4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClipArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseTracks(value: unknown): TimelineSlice["tracks"] | null {
  if (!isRecord(value)) return null;
  const video = value.video;
  const cursor = value.cursor;
  const zoom = value.zoom;
  const sound = value.sound;
  const annotations = value.annotations;
  if (
    !isClipArray(video) ||
    !isClipArray(cursor) ||
    !isClipArray(zoom) ||
    !isClipArray(sound) ||
    !isClipArray(annotations)
  ) {
    return null;
  }
  return cloneTimelineTracks({
    video: video
      .filter(isRecord)
      .map((clip) => ({ ...clip, trackId: "video" })) as TimelineSlice["tracks"]["video"],
    cursor: cursor
      .filter(isRecord)
      .map((clip) => ({ ...clip, trackId: "cursor" })) as TimelineSlice["tracks"]["cursor"],
    zoom: zoom
      .filter(isRecord)
      .map((clip) => ({ ...clip, trackId: "zoom" })) as TimelineSlice["tracks"]["zoom"],
    sound: sound
      .filter(isRecord)
      .map((clip) => ({ ...clip, trackId: "sound" })) as TimelineSlice["tracks"]["sound"],
    annotations: annotations.filter(isRecord).map((clip) => ({
      ...clip,
      trackId: "annotations",
    })) as TimelineSlice["tracks"]["annotations"],
  });
}

function parseBackground(value: unknown): EditorBackgroundKind {
  if (!isRecord(value) || typeof value.kind !== "string") return DEFAULT_BACKGROUND;
  if (value.kind === "transparent") return { kind: "transparent" };
  if (value.kind === "solid" && isRecord(value.color)) {
    const { r, g, b, a } = value.color;
    if (isFiniteNumber(r) && isFiniteNumber(g) && isFiniteNumber(b) && isFiniteNumber(a)) {
      return { kind: "solid", color: { r, g, b, a } };
    }
  }
  if (value.kind === "gradient" && typeof value.preset_id === "string") {
    return { kind: "gradient", preset_id: value.preset_id };
  }
  if (value.kind === "image" && typeof value.path === "string") {
    const assetId =
      typeof value.assetId === "string"
        ? value.assetId
        : bundledBackgroundAssetIdFromPath(value.path);
    return { kind: "image", assetId, path: value.path };
  }
  return DEFAULT_BACKGROUND;
}

export function serializeTimelineLayout(input: {
  tracks: TimelineSlice["tracks"];
  durationMs: number;
  background: EditorBackgroundKind;
}): string {
  const sourceRevision =
    input.tracks.video.find((clip) => clip.sourceRevision)?.sourceRevision ?? null;
  const layout: TimelineLayoutV4 = {
    version: TIMELINE_LAYOUT_VERSION,
    timingModelVersion: TIMELINE_TIMING_MODEL_VERSION,
    sourceRevision,
    tracks: cloneTimelineTracks(input.tracks),
    durationMs: Math.max(0, input.durationMs),
    background: input.background,
  };
  return JSON.stringify(layout);
}

export function parseTimelineLayoutJson(
  layoutJson: string | null | undefined,
  options: {
    currentGeneratedTracks?: TimelineSlice["tracks"];
    currentSourceRevision?: string;
    timingToleranceMs?: number;
  } = {},
): TimelineLayoutParseResult {
  if (!layoutJson) return { ok: false, reason: "empty layout" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(layoutJson);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "layout root is not an object" };
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== TIMELINE_LAYOUT_VERSION
  ) {
    return { ok: false, reason: `unsupported layout version ${String(parsed.version)}` };
  }
  const tracks = parseTracks(parsed.tracks);
  if (!tracks) return { ok: false, reason: "layout tracks are invalid" };
  const durationMs =
    typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs)
      ? Math.max(0, parsed.durationMs)
      : 0;
  const isV1 = parsed.version === 1;
  const isLegacyLayout = parsed.version !== TIMELINE_LAYOUT_VERSION;
  const currentGenerated = options.currentGeneratedTracks;
  const currentRevision = options.currentSourceRevision;
  const storedRevision = typeof parsed.sourceRevision === "string" ? parsed.sourceRevision : null;
  const toleranceMs = Math.max(0, options.timingToleranceMs ?? 1);
  const timingMatches = currentGenerated
    ? generatedTimingMatches(tracks, currentGenerated, toleranceMs)
    : true;
  const sourceMatches = !currentRevision || storedRevision === currentRevision;
  const shouldRebuild = Boolean(currentGenerated && (!timingMatches || (!isV1 && !sourceMatches)));
  const migratedTracks =
    shouldRebuild && currentGenerated
      ? preserveIndependentOverlays(currentGenerated, tracks)
      : tracks;
  return {
    ok: true,
    layout: {
      version: TIMELINE_LAYOUT_VERSION,
      timingModelVersion: TIMELINE_TIMING_MODEL_VERSION,
      sourceRevision: currentRevision ?? storedRevision,
      tracks: migratedTracks,
      durationMs,
      background: parseBackground(parsed.background),
    },
    migrated: isLegacyLayout,
    rebuiltGeneratedLayers: shouldRebuild,
  };
}

function generatedClips(tracks: TimelineSlice["tracks"]) {
  return [
    ...tracks.video,
    ...tracks.cursor,
    ...tracks.zoom,
    ...tracks.sound,
    ...tracks.annotations,
  ].filter((clip) => clip.syncGroupId);
}

function generatedTimingMatches(
  stored: TimelineSlice["tracks"],
  current: TimelineSlice["tracks"],
  toleranceMs: number,
): boolean {
  const currentById = new Map(generatedClips(current).map((clip) => [clip.id, clip]));
  const storedGenerated = generatedClips(stored);
  if (storedGenerated.length !== currentById.size) return false;
  return storedGenerated.every((clip) => {
    const expected = currentById.get(clip.id);
    return Boolean(
      expected &&
        Math.abs(expected.startMs - clip.startMs) <= toleranceMs &&
        Math.abs(expected.durationMs - clip.durationMs) <= toleranceMs,
    );
  });
}

function preserveIndependentOverlays(
  current: TimelineSlice["tracks"],
  stored: TimelineSlice["tracks"],
): TimelineSlice["tracks"] {
  return cloneTimelineTracks({
    ...current,
    sound: [
      ...current.sound.filter((clip) => clip.syncGroupId),
      ...stored.sound.filter((clip) => !clip.syncGroupId),
    ],
    annotations: [
      ...current.annotations.filter((clip) => clip.syncGroupId),
      ...stored.annotations.filter((clip) => !clip.syncGroupId),
    ],
  });
}
