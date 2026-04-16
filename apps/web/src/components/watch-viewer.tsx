"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { Chapter, AnalyticsEvent } from "./video-player";
import { ChapterNav } from "./chapter-nav";

interface WatchViewerProps {
  videoUrl: string;
  thumbnailUrl: string | null;
  chapters: Chapter[];
  projectName: string;
  /** Video ID for analytics event tracking */
  videoId: string;
}

/**
 * Client component that combines VideoPlayer + ChapterNav with shared playback state.
 * Used by the /watch/[slug] server component page.
 *
 * Wires analytics events to /api/analytics/ingest (Plan 04-08).
 * Session tracking via /api/analytics/session cookie (D-06 GDPR-safe).
 */
export function WatchViewer({
  videoUrl,
  thumbnailUrl,
  chapters,
  projectName,
  videoId,
}: WatchViewerProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const lastSceneRef = useRef<number>(-1);
  const playStartRef = useRef<number>(0);

  // Initialize session cookie on mount
  useEffect(() => {
    fetch("/api/analytics/session")
      .then((res) => res.json())
      .then((data: { sessionId: string }) => {
        sessionIdRef.current = data.sessionId;
      })
      .catch(() => {
        // Silent fail — analytics are best-effort (T-04-28)
      });
  }, []);

  // Send analytics event to ingest endpoint
  const sendEvent = useCallback(
    (event: string, extra?: { currentScene?: number; watchDurationSec?: number }) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      const payload = {
        videoId,
        event,
        sessionId,
        ...extra,
      };

      // Use sendBeacon for 'ended' to survive page unload
      if (event === "ended" && navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/analytics/ingest",
          new Blob([JSON.stringify(payload)], { type: "application/json" }),
        );
      } else {
        fetch("/api/analytics/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {
          // Silent fail — analytics are best-effort (T-04-28)
        });
      }
    },
    [videoId],
  );

  // Detect scene boundary crossings
  const checkSceneBoundary = useCallback(
    (time: number) => {
      if (chapters.length === 0) return;

      let currentSceneIdx = 0;
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (time >= chapters[i]!.startTimeSec) {
          currentSceneIdx = i;
          break;
        }
      }

      if (currentSceneIdx !== lastSceneRef.current) {
        lastSceneRef.current = currentSceneIdx;
        sendEvent("scene_enter", { currentScene: currentSceneIdx });
      }
    },
    [chapters, sendEvent],
  );

  const handleTimeUpdate = useCallback(
    (time: number) => {
      setCurrentTime(time);
      checkSceneBoundary(time);
    },
    [checkSceneBoundary],
  );

  const handleSeek = useCallback((timeSec: number) => {
    seekRef.current?.(timeSec);
  }, []);

  // Stable ref for seek function from VideoPlayer
  const seekRef = { current: null as ((t: number) => void) | null };

  const handleAnalyticsEvent = useCallback(
    (analyticsEvent: AnalyticsEvent) => {
      switch (analyticsEvent.event) {
        case "play":
          playStartRef.current = Date.now();
          sendEvent("play");
          break;
        case "pause":
          sendEvent("pause");
          break;
        case "seek":
          sendEvent("seek");
          break;
        case "ended": {
          const watchDurationSec = (Date.now() - playStartRef.current) / 1000;
          sendEvent("ended", { watchDurationSec });
          break;
        }
      }
    },
    [sendEvent],
  );

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
