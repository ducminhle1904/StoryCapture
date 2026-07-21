/**
 * Voice preset row for the catalog dialog.
 *
 * Keeps the surface calm: clear metadata on the left, explicit actions on the right.
 */

import { useCallback, useState } from "react";
import { Check, Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { ScButton as Button } from "@storycapture/ui";
import type { VoicePreset } from "./voiceoverStore";

export interface VoicePresetCardProps {
  preset: VoicePreset & { locale?: string };
  featured?: boolean;
  onPreview: (preset: VoicePreset) => Promise<void>;
  onSelect: (preset: VoicePreset) => void;
  playing?: boolean;
  selected?: boolean;
}

export function VoicePresetCard({
  preset,
  featured,
  onPreview,
  onSelect,
  playing: externalPlaying,
  selected = false,
}: VoicePresetCardProps) {
  const [localPlaying, setLocalPlaying] = useState(false);
  const reduceMotion = useReducedMotion();
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
  }, [onPreview, preset]);

  const handleSelect = useCallback(() => {
    onSelect(preset);
  }, [onSelect, preset]);

  return (
    <motion.div
      data-testid="voice-preset-card"
      className={`group flex items-center justify-between gap-4 rounded-[var(--radius-xl)] border px-4 py-4 transition-colors ${
        selected
          ? "border-[var(--color-accent-primary)]/40 bg-[var(--color-accent-primary)]/8"
          : "border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-200)]"
      }`}
      variants={{
        hidden: reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: reduceMotion ? 0.12 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      whileHover={selected || reduceMotion ? undefined : { y: -1 }}
      whileTap={reduceMotion ? undefined : { scale: 0.995 }}
      onClick={!selected ? handleSelect : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSelect();
        if (e.key === " ") {
          e.preventDefault();
          handlePreview();
        }
      }}
      tabIndex={0}
      role="option"
      aria-selected={selected}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--foreground)]">
            {preset.name}
          </span>
          {selected ? (
            <span className="rounded-full bg-[var(--color-accent-primary)]/12 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-primary)]">
              Selected
            </span>
          ) : null}
          {preset.premium ? (
            <span className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--warning)]">
              Premium
            </span>
          ) : null}
          {featured && !selected ? (
            <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
              Featured
            </span>
          ) : null}
        </div>

        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span>{preset.locale ?? "Global"}</span>
          <span className="text-[var(--border)]">/</span>
          <span>{preset.provider === "elevenlabs" ? "ElevenLabs" : "OpenAI"}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            void handlePreview();
          }}
          aria-pressed={isPlaying}
          aria-label={`Preview voice ${preset.name}, locale ${preset.locale ?? "unknown"}`}
        >
          <Play className="h-3.5 w-3.5" />
          {isPlaying ? "Playing" : "Preview"}
        </Button>
        <Button
          variant={selected ? "outline" : "default"}
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            handleSelect();
          }}
          disabled={selected}
          aria-label={selected ? `${preset.name} selected` : `Choose ${preset.name}`}
        >
          {selected ? <Check className="h-3.5 w-3.5" /> : null}
          {selected ? "Selected" : "Choose"}
        </Button>
      </div>
    </motion.div>
  );
}
