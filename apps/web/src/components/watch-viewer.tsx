"use client";

import { useState, useCallback } from "react";
import { VideoPlayer } from "./video-player";
import type { Chapter, AnalyticsEvent } from "./video-player";
import { ChapterNav } from "./chapter-nav";

interface WatchViewerProps {
  videoUrl: string;
  thumbnailUrl: string | null;
  chapters: Chapter[];
  projectName: string;
}

/**
 * Client component that combines VideoPlayer + ChapterNav with shared playback state.
 * Used by the /watch/[slug] server component page.
 */
export function WatchViewer({
  videoUrl,
  thumbnailUrl,
  chapters,
  projectName,
}: WatchViewerProps) {
  const [currentTime, setCurrentTime] = useState(0);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleSeek = useCallback((timeSec: number) => {
    // We need to communicate with the video element.
    // Use a ref-based approach via a shared ref.
    seekRef.current?.(timeSec);
  }, []);

  // Stable ref for seek function from VideoPlayer
  const seekRef = { current: null as ((t: number) => void) | null };

  const handleAnalyticsEvent = useCallback((_event: AnalyticsEvent) => {
    // Will be wired to /api/analytics/ingest in Plan 04-08
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="mb-4 text-xl font-semibold text-zinc-100">
        {projectName}
      </h1>

      <VideoPlayerWithSeek
        src={videoUrl}
        poster={thumbnailUrl}
        chapters={chapters}
        onAnalyticsEvent={handleAnalyticsEvent}
        onTimeUpdate={handleTimeUpdate}
        onSeekRef={(fn) => {
          seekRef.current = fn;
        }}
      />

      {chapters.length > 0 && (
        <ChapterNav
          chapters={chapters}
          currentTime={currentTime}
          onSeek={handleSeek}
        />
      )}

      <footer className="mt-8 border-t border-zinc-800 pt-4 text-center text-xs text-zinc-500">
        Made with{" "}
        <a
          href="https://storycapture.app"
          className="text-zinc-400 underline hover:text-zinc-300"
          target="_blank"
          rel="noopener noreferrer"
        >
          StoryCapture
        </a>
      </footer>
    </div>
  );
}

/**
 * Wrapper that exposes a seek function via callback ref.
 */
function VideoPlayerWithSeek({
  src,
  poster,
  chapters,
  onAnalyticsEvent,
  onTimeUpdate,
  onSeekRef,
}: {
  src: string;
  poster: string | null;
  chapters: Chapter[];
  onAnalyticsEvent: (event: AnalyticsEvent) => void;
  onTimeUpdate: (currentTime: number) => void;
  onSeekRef: (seekFn: (timeSec: number) => void) => void;
}) {
  const videoRef = useVideoRef(onSeekRef);

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg bg-black"
      style={{ aspectRatio: "16 / 9" }}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        controls
        playsInline
        className="h-full w-full object-contain"
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onPlay={(e) =>
          onAnalyticsEvent({ event: "play", currentTime: e.currentTarget.currentTime })
        }
        onPause={(e) =>
          onAnalyticsEvent({ event: "pause", currentTime: e.currentTarget.currentTime })
        }
        onSeeked={(e) =>
          onAnalyticsEvent({ event: "seek", currentTime: e.currentTarget.currentTime })
        }
        onEnded={(e) =>
          onAnalyticsEvent({ event: "ended", currentTime: e.currentTarget.currentTime })
        }
      />
    </div>
  );
}

import { useRef, useEffect } from "react";

function useVideoRef(onSeekRef: (seekFn: (t: number) => void) => void) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onSeekRef((timeSec: number) => {
      if (ref.current) {
        ref.current.currentTime = timeSec;
      }
    });
  }, [onSeekRef]);

  return ref;
}
