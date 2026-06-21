import { VIEWPORT_SIZES } from "@/state/editor";
import { parsedCommands, parseStorySource } from "../../../electron/ipc/story-parser";

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

  const named = source
    .match(/\bviewport\s*:\s*(desktop|tablet|mobile)\b/i)?.[1]
    ?.toLowerCase();
  if (named === "desktop" || named === "tablet" || named === "mobile") {
    const preset = VIEWPORT_SIZES[named];
    return { width: preset.w, height: preset.h };
  }
  return DEFAULT_BROWSER_VIEWPORT;
}

export function storyAppUrlForRecording(source: string): string | null {
  const parsedAppUrl = parseStorySource(source).ast?.meta.app ?? null;
  const metaBlockAppUrl =
    source
      .match(/\bmeta\s*\{([\s\S]*?)(?:^\s*\}|})/im)?.[1]
      ?.match(/^\s*app\s*:\s*["'](https?:\/\/[^"']+)["']/im)?.[1] ?? null;
  return normalizedHttpUrl(parsedAppUrl ?? metaBlockAppUrl);
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

export function storyFirstNavigateUrlForRecording(
  source: string,
): string | null {
  for (const command of parsedCommands(source)) {
    if (command.verb !== "navigate") continue;
    const url = normalizedHttpUrl(command.url);
    if (url) return url;
  }
  return null;
}

export function storyInitialUrlForRecording(source: string): string | null {
  return storyAppUrlForRecording(source);
}
