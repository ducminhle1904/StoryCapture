import { HOST_CURSOR_MIN_FINAL_TAIL_MS } from "./cursor-timing";

export const AUTOMATION_RECORDING_TAIL_DURATION_MS = Math.max(1200, HOST_CURSOR_MIN_FINAL_TAIL_MS);
export const AUTOMATION_RECORDING_TAIL_FRAME_COUNT = 4;
export const AUTOMATION_RECORDING_MAX_PADDING_MS = 5000;

export function recordingTailFrameDelaysMs(
  durationMs = AUTOMATION_RECORDING_TAIL_DURATION_MS,
  frameCount = AUTOMATION_RECORDING_TAIL_FRAME_COUNT,
): number[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  if (!Number.isFinite(frameCount) || frameCount <= 0) return [];
  const count = Math.max(1, Math.trunc(frameCount));
  const delayMs = Math.ceil(durationMs / count);
  return Array.from({ length: count }, () => delayMs);
}

export function recordingFrameCountForElapsedMs(elapsedMs: number, fps: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.ceil((elapsedMs / 1000) * fps);
}
