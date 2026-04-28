/**
 * Cursor-trajectory IPC hook (Phase 19-02).
 *
 * Reads the `<recording>.trajectory.json` sidecar that ships next to
 * an MP4 produced by `start_recording`. Returns `null` when the
 * sidecar is missing (older recording or sampler skipped).
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrajectoryFrame {
  t_ms: number;
  x: number;
  y: number;
  click: boolean;
}

export interface RecordingTrajectory {
  recording_path: string;
  capture_rect: CaptureRect;
  fps: number;
  frame_count: number;
  frames: TrajectoryFrame[];
}

const KEYS = {
  trajectory: (recordingPath: string) => ["trajectory", recordingPath] as const,
};

/** One-shot fetch for the trajectory sidecar. */
export async function fetchRecordingTrajectory(
  recordingPath: string,
): Promise<RecordingTrajectory | null> {
  return invoke<RecordingTrajectory | null>("get_recording_trajectory", {
    args: { recording_path: recordingPath },
  });
}

export function useRecordingTrajectory(recordingPath: string | undefined) {
  return useQuery({
    queryKey: recordingPath
      ? KEYS.trajectory(recordingPath)
      : ["trajectory", "__disabled__"],
    queryFn: () => fetchRecordingTrajectory(recordingPath as string),
    enabled: !!recordingPath,
  });
}
