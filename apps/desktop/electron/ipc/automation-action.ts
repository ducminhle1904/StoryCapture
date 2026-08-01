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

export interface ActionPointer {
  button: string;
  effect: string;
}

export type ActionCursorMotionPreset = "natural" | "snappy" | "cinematic";

export interface ActionCursorTiming {
  motion_preset: ActionCursorMotionPreset;
  start_ms: number;
  arrival_ms: number;
  travel_ms: number;
  dwell_ms: number;
}

export interface ActionScrollTiming {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

export type ActionInputKind =
  | "click"
  | "focus"
  | "hover"
  | "type"
  | "select"
  | "scroll"
  | "drag"
  | "upload";

export interface ActionInputTiming {
  kind: ActionInputKind;
  down_ms?: number;
  up_ms?: number;
  action_ms: number;
  text_start_ms?: number;
  text_end_ms?: number;
}
