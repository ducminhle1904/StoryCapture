import { VIEWPORT_SIZES } from "@/state/editor";

export interface BrowserViewportSize {
  width: number;
  height: number;
}

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 1280,
  height: 800,
};

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
  const metaBlock = source.match(/\bmeta\s*\{([\s\S]*?)^\s*\}/im)?.[1] ?? "";
  const app = metaBlock.match(/^\s*app\s*:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/im);
  return normalizedHttpUrl(app?.[1] ?? app?.[2] ?? app?.[3] ?? null);
}

function normalizedHttpUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function storyFirstNavigateUrlForRecording(source: string): string | null {
  const navigatePattern = /^\s*navigate\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/gim;
  for (const match of source.matchAll(navigatePattern)) {
    const url = normalizedHttpUrl(match[1] ?? match[2] ?? match[3]);
    if (url) return url;
  }
  return null;
}

export function storyInitialUrlForRecording(source: string): string | null {
  return storyAppUrlForRecording(source);
}
