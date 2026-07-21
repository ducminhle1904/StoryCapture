"use client";

import { Switch } from "@astryxdesign/core/Switch";
import { useCallback, useState } from "react";

interface PrivacyToggleProps {
  videoId: string;
  initialIsPublic: boolean;
  onToggle: (videoId: string, isPublic: boolean) => Promise<void>;
}

/**
 * Toggle switch for video privacy.
 * Private = unlisted (only people with the link can view, noindex).
 * Public = searchable (indexed by search engines, oEmbed available).
 * No password protection or link expiry in v1.
 */
export function PrivacyToggle({ videoId, initialIsPublic, onToggle }: PrivacyToggleProps) {
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
      <Switch
        label={isPublic ? "Public (searchable)" : "Private (unlisted)"}
        value={isPublic}
        isDisabled={loading}
        isLoading={loading}
        onChange={() => void handleToggle()}
      />

      <p className="text-xs text-[var(--color-text-secondary)]">
        {isPublic
          ? "This video is indexed by search engines and available via oEmbed auto-unfurl."
          : "Only people with the direct link can view this video. It will not appear in search results."}
      </p>
    </div>
  );
}
