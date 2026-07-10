import type { RecordingActions } from "@/ipc/actions";
import type { UndoableAction } from "../undo/actions";
import {
  insertSourceHolds,
  removeSourceHolds,
  sourcePtsUsToTimelineMs,
  timelineMsToSourcePtsUs,
} from "./source-timeline-map";
import type { Clip, CursorMotionPreset, TimelineSlice } from "./timeline-slice";
import { buildVirtualCursorSchedule } from "./virtual-cursor-scheduler";

export interface CursorPresetReflowResult {
  action: Extract<UndoableAction, { kind: "edit-sync-group" }>;
  compressedSegments: number;
  insertedHoldUs: number;
}

export function buildCursorPresetReflow(input: {
  tracks: TimelineSlice["tracks"];
  cursorClipId: string;
  actions: RecordingActions;
  motionPreset: CursorMotionPreset;
  preserveFullMotion: boolean;
}): CursorPresetReflowResult | null {
  const cursor = input.tracks.cursor.find((clip) => clip.id === input.cursorClipId);
  const syncGroupId = cursor?.syncGroupId;
  if (!cursor || !syncGroupId) return null;
  const before = Object.values(input.tracks)
    .flatMap((clips) => clips as Clip[])
    .filter((clip) => clip.syncGroupId === syncGroupId);
  const schedule = buildVirtualCursorSchedule(input.actions, input.motionPreset, {
    preserveFullMotion: input.preserveFullMotion,
  });
  if (!schedule) return null;
  const currentMap = input.tracks.video.find(
    (clip) => clip.syncGroupId === syncGroupId,
  )?.sourceTimeMap;
  if (!currentMap) return null;
  const baseMap = removeSourceHolds(currentMap, "cursor-motion");
  const nextMap = input.preserveFullMotion ? insertSourceHolds(baseMap, schedule.holds) : baseMap;
  const finalTimelineMs = nextMap.segments.at(-1)?.timelineEndMs ?? cursor.durationMs;
  const after = before.map((clip): Clip => {
    const sourceStartUs =
      timelineMsToSourcePtsUs(currentMap, clip.startMs) ??
      Math.round(Math.max(0, clip.startMs) * 1000);
    const mappedStart = sourcePtsUsToTimelineMs(nextMap, sourceStartUs) ?? clip.startMs;
    if (clip.trackId === "cursor") {
      return {
        ...clip,
        startMs: mappedStart,
        durationMs: finalTimelineMs,
        sourceTimeMap: nextMap,
        motionPreset: input.motionPreset,
        preserveFullMotion: input.preserveFullMotion,
      };
    }
    return {
      ...clip,
      startMs: mappedStart,
      durationMs: clip.trackId === "video" ? finalTimelineMs : clip.durationMs,
      sourceTimeMap: nextMap,
    } as Clip;
  });
  return {
    action: { kind: "edit-sync-group", syncGroupId, before, after },
    compressedSegments: schedule.segments.filter((segment) => segment.compressed).length,
    insertedHoldUs: schedule.holds.reduce((sum, hold) => sum + hold.durationUs, 0),
  };
}
