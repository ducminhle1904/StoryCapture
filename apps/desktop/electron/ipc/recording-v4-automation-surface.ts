import type { WebContents } from "electron";

export interface RecordingV4AutomationAction {
  step_id: string | null;
  ordinal: number;
  phase: string;
  payload?: Record<string, unknown>;
}

export interface RecordingV4AutomationSurface {
  contents: WebContents;
  inputCoordinateScale: number;
  currentMediaTimeMs: () => number;
  recordAction: (action: RecordingV4AutomationAction) => Promise<unknown>;
  isActive: () => boolean;
}

const surfaces = new Map<string, RecordingV4AutomationSurface>();

export function registerRecordingV4AutomationSurface(
  sessionId: string,
  surface: RecordingV4AutomationSurface,
): void {
  if (surfaces.has(sessionId)) {
    throw new Error(`Recording V4 automation surface ${sessionId} already exists.`);
  }
  surfaces.set(sessionId, surface);
}

export function recordingV4AutomationSurface(
  sessionId: string,
): RecordingV4AutomationSurface | null {
  return surfaces.get(sessionId) ?? null;
}

export function unregisterRecordingV4AutomationSurface(sessionId: string): void {
  surfaces.delete(sessionId);
}
