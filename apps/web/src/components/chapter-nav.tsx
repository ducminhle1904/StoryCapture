"use client";

import type { Chapter } from "./video-player";

interface ChapterNavProps {
  chapters: Chapter[];
  currentTime: number;
  onSeek: (timeSec: number) => void;
}

/**
 * Horizontal pill/tab navigation derived from DSL scene boundaries.
 * Highlights the active chapter based on current playback position.
 * Scrollable horizontally when many chapters are present.
 */
export function ChapterNav({ chapters, currentTime, onSeek }: ChapterNavProps) {
  if (chapters.length === 0) return null;

  // Determine active chapter: the last chapter whose startTimeSec <= currentTime
  let activeIndex = 0;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (currentTime >= chapters[i]!.startTimeSec) {
      activeIndex = i;
      break;
    }
  }

  return (
    <nav
      className="flex gap-2 overflow-x-auto py-3 scrollbar-thin"
      aria-label="Video chapters"
    >
      {chapters.map((chapter, index) => {
        const isActive = index === activeIndex;
        return (
          <button
            key={`${chapter.label}-${chapter.startTimeSec}`}
            onClick={() => onSeek(chapter.startTimeSec)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-zinc-100 text-zinc-900"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            }`}
            aria-current={isActive ? "step" : undefined}
          >
            {chapter.label}
          </button>
        );
      })}
    </nav>
  );
}
