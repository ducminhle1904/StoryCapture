export const AUTOMATION_RECORDING_TAIL_DURATION_MS = 500;
export const AUTOMATION_RECORDING_TAIL_FRAME_COUNT = 2;

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
