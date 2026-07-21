"use client";

import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
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
    <nav className="overflow-x-auto py-3" aria-label="Video chapters">
      <SegmentedControl
        label="Video chapters"
        value={String(activeIndex)}
        onChange={(value) => onSeek(chapters[Number(value)]!.startTimeSec)}
        size="sm"
      >
        {chapters.map((chapter, index) => (
          <SegmentedControlItem
            key={`${chapter.label}-${chapter.startTimeSec}`}
            value={String(index)}
            label={chapter.label}
          />
        ))}
      </SegmentedControl>
    </nav>
  );
}
