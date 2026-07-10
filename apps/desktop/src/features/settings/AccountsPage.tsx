import { invoke } from "@tauri-apps/api/core";
import { Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiKeyRow } from "./ApiKeyRow";
import { WebAccountPanel } from "./accounts-panel";
import AutoUpdaterSettings from "./auto-updater";
import { BrowserRow } from "./BrowserRow";

interface ProviderState {
  present: boolean;
  testStatus: "valid" | "invalid" | "rate_limited" | "untested";
}

const PROVIDERS = [
  { id: "anthropic", displayName: "Anthropic", group: "LLM" as const },
  { id: "openai", displayName: "OpenAI", group: "LLM" as const },
  { id: "elevenlabs", displayName: "ElevenLabs", group: "TTS" as const },
  { id: "openai_tts", displayName: "OpenAI TTS", group: "TTS" as const },
] as const;

export function AccountsPage() {
  const [providers, setProviders] = useState<Record<string, ProviderState>>({
    anthropic: { present: false, testStatus: "untested" },
    openai: { present: false, testStatus: "untested" },
    elevenlabs: { present: false, testStatus: "untested" },
    openai_tts: { present: false, testStatus: "untested" },
  });

  useEffect(() => {
    const checkAll = async () => {
      for (const p of PROVIDERS) {
        try {
          const present = await invoke<boolean>("key_get_presence", {
            provider: p.id,
          });
          setProviders((prev) => ({
            ...prev,
            [p.id]: { ...prev[p.id], present },
          }));
        } catch {
          // Keychain unavailable
        }
      }
    };
    checkAll();
  }, []);

  const handlePresenceChange = useCallback((providerId: string, present: boolean) => {
    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], present },
    }));
  }, []);

  const handleTestStatusChange = useCallback(
    (providerId: string, status: "valid" | "invalid" | "rate_limited" | "untested") => {
      setProviders((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId], testStatus: status },
      }));
    },
    [],
  );

  const llmProviders = PROVIDERS.filter((p) => p.group === "LLM");
  const ttsProviders = PROVIDERS.filter((p) => p.group === "TTS");

  return (
    <div
      data-testid="accounts-page"
      className="grid gap-x-12 gap-y-10 xl:grid-cols-[280px_minmax(0,1fr)]"
    >
      {/* --- Row 1: Web account --- */}
      <div className="pt-1">
        <h2 className="text-sm font-semibold text-[var(--color-fg-primary)]">Web account</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          Connect to upload videos and sync projects with the web companion.
        </p>
      </div>
      <div>
        <WebAccountPanel />
      </div>

      {/* Divider */}
      <div className="col-span-full h-px bg-[var(--color-border-subtle)]" />

      {/* --- Row 2: API keys --- */}
      <div className="pt-1">
        <h2 className="text-sm font-semibold text-[var(--color-fg-primary)]">API keys</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          Provider credentials for language models and voice synthesis.
        </p>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-[var(--color-success)]">
          <Lock size={11} />
          Stored in OS keychain
        </div>
      </div>
      <div className="space-y-6">
        {/* LLM providers */}
        <div>
          <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
            Language models
          </h3>
          <div className="space-y-2">
            {llmProviders.map((p) => (
              <ApiKeyRow
                key={p.id}
                providerId={p.id}
                displayName={p.displayName}
                present={providers[p.id]?.present ?? false}
                testStatus={providers[p.id]?.testStatus}
                onPresenceChange={(present) => handlePresenceChange(p.id, present)}
                onTestStatusChange={(status) => handleTestStatusChange(p.id, status)}
              />
            ))}
          </div>
        </div>

        {/* TTS providers */}
        <div>
          <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
            Voice services
          </h3>
          <div className="space-y-2">
            {ttsProviders.map((p) => (
              <ApiKeyRow
                key={p.id}
                providerId={p.id}
                displayName={p.displayName}
                present={providers[p.id]?.present ?? false}
                testStatus={providers[p.id]?.testStatus}
                onPresenceChange={(present) => handlePresenceChange(p.id, present)}
                onTestStatusChange={(status) => handleTestStatusChange(p.id, status)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="col-span-full h-px bg-[var(--color-border-subtle)]" />

      {/* --- Row 3: Updates --- */}
      <div className="pt-1">
        <h2 className="text-sm font-semibold text-[var(--color-fg-primary)]">Updates</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          Control when the app checks for new versions.
        </p>
      </div>
      <div>
        <AutoUpdaterSettings />
      </div>

      {/* Divider */}
      <div className="col-span-full h-px bg-[var(--color-border-subtle)]" />

      {/* --- Row 4: Automation --- */}
      <div className="pt-1">
        <h2 className="text-sm font-semibold text-[var(--color-fg-primary)]">Automation</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          Any Chromium-based browser works (Chrome, Brave, Edge, Arc, Chromium).
        </p>
      </div>
      <div>
        <BrowserRow />
      </div>
    </div>
  );
}
