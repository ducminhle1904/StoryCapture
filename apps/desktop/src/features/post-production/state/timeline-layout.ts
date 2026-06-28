import type { EditorBackgroundKind } from "./store";
import { DEFAULT_BACKGROUND } from "./store";
import type { TimelineSlice } from "./timeline-slice";
import { cloneTimelineTracks } from "./timeline-slice";

export const TIMELINE_LAYOUT_VERSION = 1;

export interface TimelineLayoutV1 {
  version: typeof TIMELINE_LAYOUT_VERSION;
  tracks: TimelineSlice["tracks"];
  durationMs: number;
  background: EditorBackgroundKind;
}

export type TimelineLayoutParseResult =
  | { ok: true; layout: TimelineLayoutV1 }
  | { ok: false; reason: string };

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
    video: video.filter(isRecord).map((clip) => ({ ...clip, trackId: "video" })) as TimelineSlice["tracks"]["video"],
    cursor: cursor.filter(isRecord).map((clip) => ({ ...clip, trackId: "cursor" })) as TimelineSlice["tracks"]["cursor"],
    zoom: zoom.filter(isRecord).map((clip) => ({ ...clip, trackId: "zoom" })) as TimelineSlice["tracks"]["zoom"],
    sound: sound.filter(isRecord).map((clip) => ({ ...clip, trackId: "sound" })) as TimelineSlice["tracks"]["sound"],
    annotations: annotations
      .filter(isRecord)
      .map((clip) => ({ ...clip, trackId: "annotations" })) as TimelineSlice["tracks"]["annotations"],
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
    return { kind: "image", path: value.path };
  }
  return DEFAULT_BACKGROUND;
}

export function serializeTimelineLayout(input: {
  tracks: TimelineSlice["tracks"];
  durationMs: number;
  background: EditorBackgroundKind;
}): string {
  const layout: TimelineLayoutV1 = {
    version: TIMELINE_LAYOUT_VERSION,
    tracks: cloneTimelineTracks(input.tracks),
    durationMs: Math.max(0, input.durationMs),
    background: input.background,
  };
  return JSON.stringify(layout);
}

export function parseTimelineLayoutJson(layoutJson: string | null | undefined): TimelineLayoutParseResult {
  if (!layoutJson) return { ok: false, reason: "empty layout" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(layoutJson);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "layout root is not an object" };
  if (parsed.version !== TIMELINE_LAYOUT_VERSION) {
    return { ok: false, reason: `unsupported layout version ${String(parsed.version)}` };
  }
  const tracks = parseTracks(parsed.tracks);
  if (!tracks) return { ok: false, reason: "layout tracks are invalid" };
  const durationMs =
    typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs)
      ? Math.max(0, parsed.durationMs)
      : 0;
  return {
    ok: true,
    layout: {
      version: TIMELINE_LAYOUT_VERSION,
      tracks,
      durationMs,
      background: parseBackground(parsed.background),
    },
  };
}
