"use client";

import { useCallback, useState } from "react";

interface PrivacyToggleProps {
  videoId: string;
  initialIsPublic: boolean;
  onToggle: (videoId: string, isPublic: boolean) => Promise<void>;
}

/**
 * Toggle switch for video privacy (D-02).
 * Private = unlisted (only people with the link can view, noindex).
 * Public = searchable (indexed by search engines, oEmbed available).
 * No password protection or link expiry in v1.
 */
export function PrivacyToggle({
  videoId,
  initialIsPublic,
  onToggle,
}: PrivacyToggleProps) {
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [loading, setLoading] = useState(false);

  const handleToggle = useCallback(async () => {
    const newValue = !isPublic;
    setLoading(true);
    try {
      await onToggle(videoId, newValue);
      setIsPublic(newValue);
    } catch {
      // Revert on error (optimistic update rolled back)
    } finally {
      setLoading(false);
    }
  }, [isPublic, videoId, onToggle]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          disabled={loading}
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 ${
            isPublic ? "bg-emerald-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${
              isPublic ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>

        <span className="text-sm font-medium text-zinc-200">
          {isPublic ? "Public (searchable)" : "Private (unlisted)"}
        </span>
      </div>

      <p className="text-xs text-zinc-500">
        {isPublic
          ? "This video is indexed by search engines and available via oEmbed auto-unfurl."
          : "Only people with the direct link can view this video. It will not appear in search results."}
      </p>
    </div>
  );
}
