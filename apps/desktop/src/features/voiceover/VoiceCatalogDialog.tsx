/**
 * Voice catalog dialog.
 *
 * Presents the voice library as a proper application modal with:
 * - selected-voice context in the header
 * - full voice list by default
 * - locale filtering
 * - distinct loading / missing-provider / empty-library / no-match states
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "@base-ui/react/dialog";
import { useNavigate } from "react-router-dom";
import { AudioLines, RefreshCw, Sparkles, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { ScButton as Button } from "@storycapture/ui";
import {
  dialogBackdropMotionClassName,
  dialogCenteredPopupMotionClassName,
  dialogViewportClassName,
} from "@/components/ui/dialog-motion";
import { useVoiceoverStore, type VoicePreset } from "./voiceoverStore";
import { VoicePresetCard } from "./VoicePresetCard";

interface VoiceInfo {
  id: string;
  name: string;
  locale: string | null;
  premium: boolean;
}

export interface VoiceCatalogDialogProps {
  projectId: string;
}

const MAX_FEATURED = 2;

export function VoiceCatalogDialog({ projectId }: VoiceCatalogDialogProps) {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const {
    catalogOpen,
    filter,
    selectedPreset,
    setCatalogOpen,
    setFilter,
    setSelectedPreset,
  } = useVoiceoverStore();

  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const loadVoices = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke<VoiceInfo[]>("tts_voice_list", { provider: "elevenlabs" })
      .then((result) => {
        setVoices(result);
        setLoading(false);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("API key") || msg.includes("NoApiKey")) {
          setError("no_api_key");
        } else {
          setError(msg);
        }
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!catalogOpen) return;
    loadVoices();
  }, [catalogOpen, loadVoices]);

  const filteredVoices = useMemo(() => {
    return voices.filter((voice) => {
      if (filter.locale && voice.locale !== filter.locale) return false;
      if (filter.premium !== undefined && voice.premium !== filter.premium) {
        return false;
      }
      return true;
    });
  }, [filter, voices]);

  const presets: (VoicePreset & { locale?: string })[] = useMemo(() => {
    let featuredCount = 0;
    return filteredVoices.map((voice) => {
      const isFeatured = featuredCount < MAX_FEATURED && !voice.premium;
      if (isFeatured) featuredCount++;

      return {
        id: voice.id,
        name: voice.name,
        locale: voice.locale ?? undefined,
        premium: voice.premium,
        provider: "elevenlabs" as const,
        featured: isFeatured,
      };
    });
  }, [filteredVoices]);

  const locales = useMemo(() => {
    const unique = new Set<string>();
    voices.forEach((voice) => {
      if (voice.locale) unique.add(voice.locale);
    });
    return Array.from(unique).sort();
  }, [voices]);

  const handlePreview = useCallback(
    async (preset: VoicePreset) => {
      setPlayingId(preset.id);
      try {
        const result = await invoke<{
          file_path: string;
          audio_duration_ms: number;
          cost_usd: number;
          cache_hit: boolean;
        }>("tts_generate", {
          projectId,
          stepId: "preview",
          scriptText: "This is a sample narration.",
          provider: preset.provider,
          voiceId: preset.id,
          model:
            preset.provider === "elevenlabs"
              ? "eleven_multilingual_v2"
              : "tts-1",
        });

        const audio = new Audio(result.file_path);
        audio.onerror = () => setPlayingId(null);
        audio.onended = () => setPlayingId(null);
        await audio.play();
      } catch {
        setPlayingId(null);
      }
    },
    [projectId],
  );

  const handleSelect = useCallback(
    (preset: VoicePreset) => {
      setSelectedPreset(preset);
      setCatalogOpen(false);
    },
    [setCatalogOpen, setSelectedPreset],
  );

  const dialogSize = "max-w-[920px] max-h-[760px]";
  const hasFilters = Boolean(filter.locale) || filter.premium !== undefined;
  const noVoicesYet = !loading && !error && voices.length === 0;

  return (
    <Dialog.Root open={catalogOpen} onOpenChange={setCatalogOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={`fixed inset-0 z-50 bg-[var(--color-fg-primary)/56] backdrop-blur-md ${dialogBackdropMotionClassName}`}
        />
        <Dialog.Viewport className={dialogViewportClassName}>
          <Dialog.Popup
            data-testid="voice-catalog"
            className={`${dialogSize} flex h-[min(84vh,760px)] w-[min(92vw,920px)] flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-default)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)] ${dialogCenteredPopupMotionClassName}`}
            aria-label="Voice catalog"
          >
            <motion.div
              className="relative overflow-hidden border-b border-[var(--color-border-subtle)] px-6 py-5"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.2, delay: reduceMotion ? 0 : 0.03 }}
            >
              <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_15%_0%,rgba(245,78,0,0.10),transparent_42%),linear-gradient(90deg,rgba(245,78,0,0.05),transparent_48%)]" />
              <div className="relative flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                    <AudioLines className="h-3.5 w-3.5" />
                    Voice library
                  </div>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[var(--color-fg-primary)]">
                    Choose voice
                  </h2>
                  <p className="font-serif mt-2 max-w-lg text-sm leading-6 text-[var(--color-fg-secondary)]">
                    Pick a voice that fits the pace and tone of this story.
                  </p>
                </div>
                <Dialog.Close
                  render={
                    <button
                      type="button"
                      aria-label="Close"
                    />
                  }
                  className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-2 text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
                >
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>

              <div className="relative mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                <div className="rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                    Selection
                  </div>
                  <div className="mt-2 truncate text-sm font-medium text-[var(--color-fg-primary)]">
                    {selectedPreset ? selectedPreset.name : "No voice selected"}
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-fg-secondary)]">
                    {selectedPreset?.locale ??
                      "Choose one to start rendering takes."}
                  </div>
                </div>

                <div className="rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                    Library
                  </div>
                  <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                    {loading ? "Loading..." : `${voices.length} available`}
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-fg-secondary)]">
                    Full library
                  </div>
                </div>
              </div>
            </motion.div>

            <motion.div
              className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] px-6 py-3"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.18, delay: reduceMotion ? 0 : 0.06 }}
            >
              <div
                role="radiogroup"
                aria-label="Locale filter"
                className="flex flex-wrap gap-2"
              >
                <motion.label
                  layout
                  className={`relative cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    !filter.locale
                      ? "text-[var(--color-fg-primary)]"
                      : "bg-[var(--color-surface-100)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
                  }`}
                  whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                >
                  {!filter.locale ? (
                    <motion.span
                      layoutId="voice-filter-pill"
                      className="absolute inset-0 rounded-full bg-[var(--color-surface-300)]"
                      transition={
                        reduceMotion
                          ? { duration: 0.12 }
                          : { type: "spring", stiffness: 380, damping: 32 }
                      }
                    />
                  ) : null}
                  <input
                    type="radio"
                    name="locale-filter"
                    value=""
                    checked={!filter.locale}
                    onChange={() => setFilter({ ...filter, locale: undefined })}
                    className="sr-only"
                    aria-label="All"
                  />
                  <span className="relative z-10">All</span>
                </motion.label>
                {locales.map((locale) => (
                  <motion.label
                    key={locale}
                    layout
                    className={`relative cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      filter.locale === locale
                        ? "text-[var(--color-fg-primary)]"
                        : "bg-[var(--color-surface-100)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
                    }`}
                    whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                  >
                    {filter.locale === locale ? (
                      <motion.span
                        layoutId="voice-filter-pill"
                        className="absolute inset-0 rounded-full bg-[var(--color-surface-300)]"
                        transition={
                          reduceMotion
                            ? { duration: 0.12 }
                            : { type: "spring", stiffness: 380, damping: 32 }
                        }
                      />
                    ) : null}
                    <input
                      type="radio"
                      name="locale-filter"
                      value={locale}
                      checked={filter.locale === locale}
                      onChange={() => setFilter({ ...filter, locale: locale })}
                      className="sr-only"
                      aria-label={locale}
                    />
                    <span className="relative z-10">{locale}</span>
                  </motion.label>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {hasFilters ? (
                  <Button variant="ghost" size="sm" onClick={() => setFilter({})}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
            </motion.div>

            <motion.div
              className="flex-1 overflow-y-auto px-6 py-5"
              initial={reduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.2, delay: reduceMotion ? 0 : 0.09 }}
            >
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      key={`voice-skeleton-${index}`}
                      className="animate-pulse rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-4"
                    >
                      <div className="h-4 w-32 rounded bg-[var(--color-surface-300)]" />
                      <div className="mt-3 h-3 w-24 rounded bg-[var(--color-surface-300)]" />
                    </div>
                  ))}
                </div>
              ) : null}

              {!loading && error === "no_api_key" ? (
                <div className="flex h-full min-h-[280px] items-center justify-center">
                  <div className="max-w-md text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-200)] text-[var(--color-fg-secondary)]">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <h3 className="mt-5 text-lg font-semibold text-[var(--color-fg-primary)]">
                      Connect a provider first
                    </h3>
                    <p className="font-serif mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
                      Add an ElevenLabs or OpenAI API key in Settings to browse
                      and preview voices.
                    </p>
                    <div className="mt-5 flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCatalogOpen(false);
                          navigate("/settings");
                        }}
                      >
                        Open settings
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {!loading && !error && noVoicesYet ? (
                <div className="flex h-full min-h-[280px] items-center justify-center">
                  <div className="max-w-md text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-200)] text-[var(--color-fg-secondary)]">
                      <AudioLines className="h-5 w-5" />
                    </div>
                    <h3 className="mt-5 text-lg font-semibold text-[var(--color-fg-primary)]">
                      No voices yet
                    </h3>
                    <p className="font-serif mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
                      This account does not have any available voices right now.
                      Try refreshing, or check the provider configuration.
                    </p>
                    <div className="mt-5 flex items-center justify-center gap-2">
                      <Button variant="outline" size="sm" onClick={loadVoices}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCatalogOpen(false);
                          navigate("/settings");
                        }}
                      >
                        Settings
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {!loading && !error && !noVoicesYet && filteredVoices.length === 0 ? (
                <div className="flex h-full min-h-[280px] items-center justify-center">
                  <div className="max-w-md text-center">
                    <h3 className="text-lg font-semibold text-[var(--color-fg-primary)]">
                      Nothing matches these filters
                    </h3>
                    <p className="font-serif mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
                      Try another locale or clear the current filter set.
                    </p>
                    <div className="mt-5 flex items-center justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFilter({})}
                      >
                        Clear filters
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {!loading && !error && !noVoicesYet && filteredVoices.length > 0 ? (
                <motion.div
                  className="space-y-3"
                  role="listbox"
                  aria-label="Voice presets"
                  initial={reduceMotion ? false : "hidden"}
                  animate="visible"
                  variants={{
                    hidden: {},
                    visible: {
                      transition: {
                        staggerChildren: reduceMotion ? 0 : 0.035,
                      },
                    },
                  }}
                >
                  {presets.map((preset) => (
                    <VoicePresetCard
                      key={preset.id}
                      preset={preset}
                      featured={preset.featured}
                      onPreview={handlePreview}
                      onSelect={handleSelect}
                      playing={playingId === preset.id}
                      selected={selectedPreset?.id === preset.id}
                    />
                  ))}
                </motion.div>
              ) : null}
            </motion.div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
