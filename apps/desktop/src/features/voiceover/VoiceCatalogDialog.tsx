/**
 * Voice catalog modal dialog (Plan 03-19).
 *
 * Two modes:
 * - Curated (default): 720x560, shows curated presets
 * - Expanded: 960x720, shows full provider catalog with search
 *
 * Empty states:
 * - No API key: "Chua ket noi provider TTS" + Settings link
 * - No matches: "Khong co giong nao khop"
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
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

/** Max featured badges per accent rule #6 */
const MAX_FEATURED = 2;

export function VoiceCatalogDialog({ projectId }: VoiceCatalogDialogProps) {
  const {
    catalogOpen,
    catalogMode,
    filter,
    setCatalogOpen,
    setCatalogMode,
    setFilter,
    setSelectedPreset,
  } = useVoiceoverStore();

  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  // Load voices on mount
  useEffect(() => {
    if (!catalogOpen) return;
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
  }, [catalogOpen]);

  // Filter voices
  const filteredVoices = useMemo(() => {
    return voices.filter((v) => {
      if (filter.locale && v.locale !== filter.locale) return false;
      if (filter.premium !== undefined && v.premium !== filter.premium)
        return false;
      return true;
    });
  }, [voices, filter]);

  // Build presets from VoiceInfo
  const presets: (VoicePreset & { locale?: string })[] = useMemo(() => {
    let featuredCount = 0;
    return filteredVoices.map((v) => {
      const isFeatured = featuredCount < MAX_FEATURED && !v.premium;
      if (isFeatured) featuredCount++;
      return {
        id: v.id,
        name: v.name,
        locale: v.locale ?? undefined,
        premium: v.premium,
        provider: "elevenlabs" as const,
        featured: isFeatured,
      };
    });
  }, [filteredVoices]);

  // Available locale chips
  const locales = useMemo(() => {
    const set = new Set<string>();
    voices.forEach((v) => {
      if (v.locale) set.add(v.locale);
    });
    return Array.from(set).sort();
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
        audio.onerror = () => {
          // T-03-19-01: sandboxed audio decode failure
          setPlayingId(null);
        };
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
    [setSelectedPreset, setCatalogOpen],
  );

  const handleExpandToggle = useCallback(() => {
    setCatalogMode(catalogMode === "curated" ? "expanded" : "curated");
  }, [catalogMode, setCatalogMode]);

  if (!catalogOpen) return null;

  const isExpanded = catalogMode === "expanded";
  const dialogSize = isExpanded
    ? "max-w-[960px] max-h-[720px]"
    : "max-w-[720px] max-h-[560px]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => setCatalogOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setCatalogOpen(false);
      }}
    >
      <div
        data-testid="voice-catalog"
        className={`${dialogSize} w-[90vw] h-[90vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--background)] shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Voice catalog"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-8 py-4">
          <h2 className="text-xl font-semibold text-[var(--foreground)]">
            {`Ch\u1ECDn gi\u1ECDng`}
          </h2>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            onClick={() => setCatalogOpen(false)}
            aria-label="Close"
          >
            {"\u2715"}
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-8 py-3">
          <div role="radiogroup" aria-label="Locale filter" className="flex gap-2">
            <label
              className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                !filter.locale
                  ? "bg-[var(--foreground)]/10 text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              <input
                type="radio"
                name="locale-filter"
                value=""
                checked={!filter.locale}
                onChange={() => setFilter({ ...filter, locale: undefined })}
                className="sr-only"
                aria-label="All"
              />
              {"T\u1EA5t c\u1EA3"}
            </label>
            {locales.map((loc) => (
              <label
                key={loc}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter.locale === loc
                    ? "bg-[var(--foreground)]/10 text-[var(--foreground)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                <input
                  type="radio"
                  name="locale-filter"
                  value={loc}
                  checked={filter.locale === loc}
                  onChange={() => setFilter({ ...filter, locale: loc })}
                  className="sr-only"
                  aria-label={loc}
                />
                {loc}
              </label>
            ))}
          </div>

          <div className="ml-auto">
            <button
              type="button"
              className="text-sm text-[var(--accent)] hover:underline"
              onClick={handleExpandToggle}
            >
              {isExpanded
                ? `Thu g\u1ECDn`
                : `Xem t\u1EA5t c\u1EA3 gi\u1ECDng`}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="text-sm text-[var(--muted-foreground)]">
                {"\u0110ang t\u1EA3i..."}
              </div>
            </div>
          )}

          {!loading && error === "no_api_key" && (
            <div className="flex flex-col items-center gap-4 py-12">
              <p className="text-sm text-[var(--muted-foreground)]">
                {`Ch\u01b0a k\u1EBFt n\u1ED1i provider TTS`}
              </p>
              <p className="text-xs text-[var(--muted-foreground)]">
                {`Th\u00eam API key ElevenLabs ho\u1EB7c OpenAI trong Settings \u2192 Accounts \u0111\u1EC3 nghe v\u00e0 ch\u1ECDn gi\u1ECDng.`}
              </p>
              <button
                type="button"
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90"
              >
                {`M\u1EDF Settings`}
              </button>
            </div>
          )}

          {!loading && !error && filteredVoices.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12">
              <p className="text-sm text-[var(--muted-foreground)]">
                {`Kh\u00f4ng c\u00f3 gi\u1ECDng n\u00e0o kh\u1EDbp`}
              </p>
              <p className="text-xs text-[var(--muted-foreground)]">
                {`Th\u1EED \u0111\u1ED5i locale ho\u1EB7c xo\u00e1 b\u1ED9 l\u1ECDc premium.`}
              </p>
            </div>
          )}

          {!loading && !error && filteredVoices.length > 0 && (
            <div
              className={`grid gap-6 ${
                isExpanded
                  ? "grid-cols-2 lg:grid-cols-3"
                  : "grid-cols-2 lg:grid-cols-3"
              }`}
              role="listbox"
              aria-label="Voice presets"
            >
              {presets.map((preset) => (
                <VoicePresetCard
                  key={preset.id}
                  preset={preset}
                  featured={preset.featured}
                  onPreview={handlePreview}
                  onSelect={handleSelect}
                  playing={playingId === preset.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
