import { VIEWPORT_SIZES } from "@/state/editor";

export interface BrowserViewportSize {
  width: number;
  height: number;
}

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportSize = { width: 1280, height: 800 };

export function storyViewportSize(source: string): BrowserViewportSize {
  const pair = source.match(/\bviewport\s*:\s*(\d{2,5})\s*x\s*(\d{2,5})\b/i);
  if (pair) {
    return { width: Number(pair[1]), height: Number(pair[2]) };
  }

  const named = source.match(/\bviewport\s*:\s*(desktop|tablet|mobile)\b/i)?.[1]?.toLowerCase();
  if (named === "desktop" || named === "tablet" || named === "mobile") {
    const preset = VIEWPORT_SIZES[named];
    return { width: preset.w, height: preset.h };
  }
  return DEFAULT_BROWSER_VIEWPORT;
}

export function storyAppUrlForRecording(source: string): string | null {
  return source.match(/\bapp\s*:\s*["'](https?:\/\/[^"']+)["']/i)?.[1] ?? null;
}
