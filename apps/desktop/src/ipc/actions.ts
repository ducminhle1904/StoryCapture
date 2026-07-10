import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import type { RecordingActions } from "./action-sidecar";

export type {
  ActionBounds,
  ActionCaptureRect,
  ActionCursorMotionPreset,
  ActionCursorPath,
  ActionCursorTiming,
  ActionEventConfidence,
  ActionInputKind,
  ActionInputLandmarks,
  ActionInputTiming,
  ActionMediaClock,
  ActionMediaLandmark,
  ActionPoint,
  ActionPresentation,
  ActionRecordingConfidence,
  ActionSourceVersion,
  ActionTarget,
  ActionTimelineEvent,
  RecordingActions,
} from "./action-sidecar";
export {
  actionSidecarFps,
  parseActionSidecar,
  parseActionSidecarJson,
} from "./action-sidecar";

const KEYS = {
  actions: (recordingPath: string) => ["actions", recordingPath] as const,
};

export async function fetchRecordingActions(
  recordingPath: string,
): Promise<RecordingActions | null> {
  return invoke<RecordingActions | null>("get_recording_actions", {
    args: { recording_path: recordingPath },
  });
}

export function useRecordingActions(recordingPath: string | undefined) {
  return useQuery({
    queryKey: recordingPath ? KEYS.actions(recordingPath) : ["actions", "__disabled__"],
    queryFn: () => fetchRecordingActions(recordingPath as string),
    enabled: !!recordingPath,
  });
}
