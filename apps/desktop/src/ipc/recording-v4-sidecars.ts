import {
  type RecordingV4ActionSidecar,
  type RecordingV4CursorSidecar,
  readRecordingV4ActionSidecar,
  readRecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import { useQuery } from "@tanstack/react-query";
import { readTextFile } from "@tauri-apps/plugin-fs";

export interface RecordingV4Sidecars {
  actions: RecordingV4ActionSidecar;
  cursor: RecordingV4CursorSidecar;
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
