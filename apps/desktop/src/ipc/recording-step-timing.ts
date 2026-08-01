export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  status: "succeeded" | "failed";
  cursor?: { x: number; y: number } | null;
  target?: RecordingStepTimingTarget | null;
  confidence: "high" | "low";
}

export interface RecordingStepTimingSidecar {
  version: 4;
  recordingPath: string;
  captureRect?: CaptureRect | null;
  storyHash: string;
  timebase: "recording-ms";
  status: "completed" | "failed";
  steps: RecordingStepTiming[];
}
