import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lock } from "lucide-react";
import { ApiKeyRow } from "./ApiKeyRow";
import { WebAccountPanel } from "./accounts-panel";

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

  const handlePresenceChange = useCallback(
    (providerId: string, present: boolean) => {
      setProviders((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId], present },
      }));
    },
    [],
  );

  const handleTestStatusChange = useCallback(
    (
      providerId: string,
      status: "valid" | "invalid" | "rate_limited" | "untested",
    ) => {
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
    <div data-testid="accounts-page" className="space-y-8">
      {/* Web account */}
      <section>
        <h2 className="text-base font-semibold text-[var(--color-fg-primary)]">
          Web account
        </h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Connect to sync projects and upload videos.
        </p>
        <div className="mt-4">
          <WebAccountPanel />
        </div>
      </section>

      <div className="h-px bg-[var(--color-border-subtle)]" />

      {/* API keys */}
      <section>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-fg-primary)]">
              API keys
            </h2>
            <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
              Keys are stored in your OS keychain and never leave the device.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-success)]">
            <Lock size={12} />
            OS keychain
          </div>
        </div>

        {/* LLM */}
        <div className="mt-6">
          <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
            Language models
          </h3>
          <div className="mt-3 space-y-2">
            {llmProviders.map((p) => (
              <ApiKeyRow
                key={p.id}
                providerId={p.id}
                displayName={p.displayName}
                present={providers[p.id]?.present ?? false}
                testStatus={providers[p.id]?.testStatus}
                onPresenceChange={(present) =>
                  handlePresenceChange(p.id, present)
                }
                onTestStatusChange={(status) =>
                  handleTestStatusChange(p.id, status)
                }
              />
            ))}
          </div>
        </div>

        {/* TTS */}
        <div className="mt-6">
          <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
            Voice services
          </h3>
          <div className="mt-3 space-y-2">
            {ttsProviders.map((p) => (
              <ApiKeyRow
                key={p.id}
                providerId={p.id}
                displayName={p.displayName}
                present={providers[p.id]?.present ?? false}
                testStatus={providers[p.id]?.testStatus}
                onPresenceChange={(present) =>
                  handlePresenceChange(p.id, present)
                }
                onTestStatusChange={(status) =>
                  handleTestStatusChange(p.id, status)
                }
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
