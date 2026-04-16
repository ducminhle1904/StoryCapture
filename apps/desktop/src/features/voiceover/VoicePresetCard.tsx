/**
 * Voice preset card component.
 *
 * Displays voice name, locale flag, premium/featured badges,
 * and "Nghe thu" preview button with conic-gradient ring animation.
 */

import { useState, useCallback } from "react";
import type { VoicePreset } from "./voiceoverStore";

export interface VoicePresetCardProps {
  preset: VoicePreset & { locale?: string };
  featured?: boolean;
  onPreview: (preset: VoicePreset) => Promise<void>;
  onSelect: (preset: VoicePreset) => void;
  playing?: boolean;
}

export function VoicePresetCard({
  preset,
  featured,
  onPreview,
  onSelect,
  playing: externalPlaying,
}: VoicePresetCardProps) {
  const [localPlaying, setLocalPlaying] = useState(false);
  const isPlaying = externalPlaying ?? localPlaying;

  const handlePreview = useCallback(async () => {
    setLocalPlaying(true);
    try {
      await onPreview(preset);
    } catch {
      // Audio decode errors handled silently
    } finally {
      setLocalPlaying(false);
    }
  }, [preset, onPreview]);

  const handleSelect = useCallback(() => {
    onSelect(preset);
  }, [preset, onSelect]);

  return (
    <div
      data-testid="voice-preset-card"
      className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 transition-colors hover:border-[var(--foreground)]/20 cursor-pointer"
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSelect();
        if (e.key === " ") {
          e.preventDefault();
          handlePreview();
        }
      }}
      tabIndex={0}
      role="option"
      aria-selected={false}
    >
      {/* Voice name + badges */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[var(--foreground)]">
          {preset.name}
        </span>
        {preset.premium && (
          <span className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--warning)]">
            Premium
          </span>
        )}
        {featured && (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
            Featured
          </span>
        )}
      </div>

      {/* Locale flag */}
      {preset.locale && (
        <span className="text-xs text-[var(--muted-foreground)]">
          {preset.locale}
        </span>
      )}

      {/* Preview button with rotating ring */}
      <div className="relative mt-1 inline-flex items-center">
        {isPlaying && (
          <div
            className="absolute -inset-1 rounded-full animate-spin"
            style={{
              background:
                "conic-gradient(from 0deg, var(--accent), transparent 60%, var(--accent))",
              animationDuration: "2.4s",
              animationTimingFunction: "linear",
            }}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          className="relative z-10 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          onClick={(e) => {
            e.stopPropagation();
            handlePreview();
          }}
          aria-pressed={isPlaying}
          aria-label={`Nghe th\u1EED gi\u1ECDng ${preset.name}, ng\u00f4n ng\u1EEF ${preset.locale ?? "unknown"}`}
        >
          {`Nghe th\u1EED`}
        </button>
      </div>
    </div>
  );
}
