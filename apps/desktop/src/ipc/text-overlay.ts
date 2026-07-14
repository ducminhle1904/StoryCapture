export const TEXT_OVERLAY_DEFAULT_DURATION_MS = 2_000;
export const TEXT_OVERLAY_MIN_DURATION_MS = 100;
export const TEXT_OVERLAY_MAX_DURATION_MS = 30_000;

export interface TextOverlayDurationResult {
  durationMs: number | null;
  error: string | null;
}

export function validateTextOverlayText(text: string): string | null {
  return text.trim() ? null : "Text overlay text must not be empty.";
}

export function parseTextOverlayDuration(raw: string): TextOverlayDurationResult {
  const match = raw.trim().match(/^(\d+)ms$/);
  if (!match) {
    return {
      durationMs: null,
      error: "Text overlay duration must be an integer followed by ms.",
    };
  }

  const durationMs = Number(match[1]);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < TEXT_OVERLAY_MIN_DURATION_MS ||
    durationMs > TEXT_OVERLAY_MAX_DURATION_MS
  ) {
    return {
      durationMs: null,
      error: `Text overlay duration must be between ${TEXT_OVERLAY_MIN_DURATION_MS}ms and ${TEXT_OVERLAY_MAX_DURATION_MS}ms.`,
    };
  }

  return { durationMs, error: null };
}
