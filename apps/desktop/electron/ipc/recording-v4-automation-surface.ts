import type { WebContents } from "electron";
import type { RecordingV4ActionInput } from "@storycapture/shared-types/recording-v4";

export type RecordingV4AutomationAction = RecordingV4ActionInput;

export interface RecordingV4AutomationSurface {
  contents: WebContents;
  inputCoordinateScale: number;
  cursorCoordinateSize: { width: number; height: number };
  currentMediaTimeMs: () => number;
  recordAction: (action: RecordingV4AutomationAction) => Promise<unknown>;
  recordCursorSample: (point: { x: number; y: number }) => Promise<unknown>;
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
