"use client";

import { useRef, useCallback, useEffect } from "react";

export interface Chapter {
  label: string;
  startTimeSec: number;
}

export interface AnalyticsEvent {
  event: "play" | "pause" | "seek" | "ended";
  currentTime: number;
}

interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  chapters?: Chapter[];
  onAnalyticsEvent?: (event: AnalyticsEvent) => void;
  onTimeUpdate?: (currentTime: number) => void;
  className?: string;
}

/**
 * HTML5 video player with poster/thumbnail support, chapter seeking,
 * and analytics event callback. Responsive 16:9 aspect ratio with dark background.
 */
export function VideoPlayer({
  src,
  poster,
  onAnalyticsEvent,
  onTimeUpdate,
  className = "",
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const emit = useCallback(
    (event: AnalyticsEvent["event"], currentTime: number) => {
      onAnalyticsEvent?.({ event, currentTime });
    },
    [onAnalyticsEvent],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => onTimeUpdate?.(video.currentTime);
    const handlePlay = () => emit("play", video.currentTime);
    const handlePause = () => emit("pause", video.currentTime);
    const handleSeeked = () => emit("seek", video.currentTime);
    const handleEnded = () => emit("ended", video.currentTime);

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("ended", handleEnded);
    };
  }, [emit, onTimeUpdate]);

  /** Seek to a specific time (called by ChapterNav). */
  const seekTo = useCallback((timeSec: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = timeSec;
    }
  }, []);

  return (
    <div
      className={`relative w-full overflow-hidden rounded-lg bg-black ${className}`}
      style={{ aspectRatio: "16 / 9" }}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        controls
        playsInline
        className="h-full w-full object-contain"
      />
    </div>
  );
}

/**
 * Hook to get a ref-stable seekTo function from a VideoPlayer.
 * Usage: pass seekTo as onSeek prop to ChapterNav.
 */
export function useVideoSeek() {
  const videoRef = useRef<HTMLVideoElement>(null);

  const seekTo = useCallback((timeSec: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = timeSec;
    }
  }, []);

  return { videoRef, seekTo };
}
