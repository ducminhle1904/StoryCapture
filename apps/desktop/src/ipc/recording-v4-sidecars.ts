import {
  type RecordingV4ActionSidecar,
  type RecordingV4CursorSidecar,
  readRecordingV4ActionSidecar,
  readRecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import { useQuery } from "@tanstack/react-query";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { RecordingStepTimingSidecar } from "./recording-step-timing";

export interface RecordingV4Sidecars {
  actions: RecordingV4ActionSidecar;
  cursor: RecordingV4CursorSidecar;
}

export function recordingV4StepTimingSidecar(
  actions: RecordingV4ActionSidecar | null,
  cursor: RecordingV4CursorSidecar | null,
  recordingPath: string,
): RecordingStepTimingSidecar | null {
  if (!actions || !cursor || actions.session_id !== cursor.session_id) return null;
  const captureRect = {
    x: 0,
    y: 0,
    width: cursor.geometry.capture_width,
    height: cursor.geometry.capture_height,
  };
  const terminalEvents = actions.events.filter(
    (event) => event.phase === "succeeded" || event.phase === "failed",
  );
  return {
    version: 4,
    recordingPath,
    captureRect,
    storyHash: actions.session_id,
    timebase: "recording-ms",
    status: terminalEvents.some((event) => event.phase === "failed") ? "failed" : "completed",
    steps: terminalEvents.map((event) => {
      const startMs = (event.timing?.started_us ?? event.active_media_time_us) / 1_000;
      const endMs = (event.timing?.ended_us ?? event.active_media_time_us) / 1_000;
      return {
        ordinal: event.ordinal,
        stepId: event.step_id,
        sceneName: "Recorded story",
        verb: event.verb ?? "unknown",
        startMs,
        endMs,
        durationMs: Math.max(0, endMs - startMs),
        status: event.phase === "failed" ? "failed" : "succeeded",
        cursor: null,
        target: event.target
          ? {
              selector: event.target.selector,
              bbox: {
                x: event.target.bounds.x,
                y: event.target.bounds.y,
                w: event.target.bounds.width,
                h: event.target.bounds.height,
              },
              matchKind: "primary",
            }
          : null,
        confidence: event.phase === "succeeded" ? "high" : "low",
      };
    }),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readTextFile(path)) as unknown;
}

export async function fetchRecordingV4Sidecars(
  actionsPath: string,
  cursorPath: string,
): Promise<RecordingV4Sidecars> {
  const [actionsValue, cursorValue] = await Promise.all([
    readJson(actionsPath),
    readJson(cursorPath),
  ]);
  const actions = readRecordingV4ActionSidecar(actionsValue);
  const cursor = readRecordingV4CursorSidecar(cursorValue);
  if (!actions) throw new Error(`invalid Recording V4 action sidecar: ${actionsPath}`);
  if (!cursor) throw new Error(`invalid Recording V4 cursor sidecar: ${cursorPath}`);
  if (actions.session_id !== cursor.session_id) {
    throw new Error("Recording V4 action and cursor sidecars belong to different sessions");
  }
  return { actions, cursor };
}

export function useRecordingV4Sidecars(
  actionsPath: string | null | undefined,
  cursorPath: string | null | undefined,
) {
  return useQuery({
    queryKey:
      actionsPath && cursorPath
        ? ["recording-v4-sidecars", actionsPath, cursorPath]
        : ["recording-v4-sidecars", "__disabled__"],
    queryFn: () => fetchRecordingV4Sidecars(actionsPath as string, cursorPath as string),
    enabled: Boolean(actionsPath && cursorPath),
  });
}
