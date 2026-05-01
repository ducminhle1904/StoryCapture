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

export interface RecordingStepTimingTarget {
  selector?: string | null;
  bbox?: { x: number; y: number; w: number; h: number } | null;
  matchKind: "primary" | "fuzzy" | "none" | string;
}

export interface RecordingStepTiming {
  ordinal: number;
  stepId?: string | null;
  sceneName: string;
  verb: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "succeeded" | "failed" | string;
  cursor?: { x: number; y: number } | null;
  target?: RecordingStepTimingTarget | null;
  confidence: "high" | "medium" | "low" | string;
}

export interface RecordingStepTimingSidecar {
  version: number;
  recordingPath: string;
  storyHash: string;
  timebase: "recording-ms" | string;
  status: "completed" | "failed" | "partial" | "recording_stopped" | "ui_detached" | string;
  steps: RecordingStepTiming[];
}

const KEYS = {
  trajectory: (recordingPath: string) => ["trajectory", recordingPath] as const,
  stepTiming: (recordingPath: string) => ["recording-step-timing", recordingPath] as const,
};

/** One-shot fetch for the trajectory sidecar. */
export async function fetchRecordingTrajectory(
  recordingPath: string,
): Promise<RecordingTrajectory | null> {
  return invoke<RecordingTrajectory | null>("get_recording_trajectory", {
    args: { recording_path: recordingPath },
  });
}

export function useRecordingTrajectory(recordingPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: recordingPath ? KEYS.trajectory(recordingPath) : ["trajectory", "__disabled__"],
    queryFn: () => fetchRecordingTrajectory(recordingPath as string),
    enabled: !!recordingPath && enabled,
  });
}

export async function fetchRecordingStepTiming(
  recordingPath: string,
): Promise<RecordingStepTimingSidecar | null> {
  return invoke<RecordingStepTimingSidecar | null>("get_recording_step_timing", {
    args: { recording_path: recordingPath },
  });
}

export function useRecordingStepTiming(recordingPath: string | undefined) {
  return useQuery({
    queryKey: recordingPath
      ? KEYS.stepTiming(recordingPath)
      : ["recording-step-timing", "__disabled__"],
    queryFn: () => fetchRecordingStepTiming(recordingPath as string),
    enabled: !!recordingPath,
  });
}
