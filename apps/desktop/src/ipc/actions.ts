import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface ActionPoint {
  x: number;
  y: number;
}

export interface ActionBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ActionTarget {
  kind: string;
  label: string | null;
  center: ActionPoint;
  bounds: ActionBounds;
}

export type ActionCursorMotionPreset = "natural" | "snappy" | "cinematic";

export interface ActionCursorTiming {
  motion_preset: ActionCursorMotionPreset;
  start_ms: number;
  arrival_ms: number;
  travel_ms: number;
  dwell_ms: number;
}

export interface ActionInputTiming {
  kind: "click" | "focus" | "hover" | "type" | "select" | "scroll" | "drag" | "upload";
  down_ms?: number;
  up_ms?: number;
  action_ms: number;
  text_start_ms?: number;
  text_end_ms?: number;
}

export interface ActionTimelineEvent {
  step_id: string | null;
  ordinal: number;
  verb: string;
  t_start_ms: number;
  t_action_ms: number;
  t_end_ms: number;
  target: ActionTarget | null;
  secondary_target: ActionTarget | null;
  pointer: { button: string; effect: string } | null;
  cursor_timing?: ActionCursorTiming | null;
  input_timing?: ActionInputTiming | null;
}

export interface RecordingActions {
  version: number;
  recording_path: string;
  cursor_motion_preset?: ActionCursorMotionPreset;
  viewport: { width: number; height: number };
  capture_rect: { x: number; y: number; width: number; height: number };
  fps: number;
  frame_count: number;
  events: ActionTimelineEvent[];
}

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
