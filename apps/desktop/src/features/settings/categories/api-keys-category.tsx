import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lock, Info } from "lucide-react";

import { ApiKeyRow } from "../ApiKeyRow";
import { WebAccountPanel } from "../accounts-panel";
import { SettingsPanel } from "../settings-row";

interface ProviderState {
  present: boolean;
  testStatus: "valid" | "invalid" | "rate_limited" | "untested";
}

const PROVIDERS = [
  { id: "anthropic", displayName: "Anthropic", group: "LLM" as const, sub: "DSL assist, lint suggestions" },
  { id: "openai", displayName: "OpenAI", group: "LLM" as const, sub: "Narration transcripts, scene summaries" },
  { id: "elevenlabs", displayName: "ElevenLabs", group: "TTS" as const, sub: "Voice synthesis for narrate() directives" },
  { id: "openai_tts", displayName: "OpenAI TTS", group: "TTS" as const, sub: "Backup voice provider" },
] as const;

// Wired: reuses the existing keychain-backed ApiKeyRow from AccountsPage.
export function ApiKeysCategory() {
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
    (providerId: string, status: ProviderState["testStatus"]) => {
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
    <SettingsPanel
      title="API keys"
      desc="Keys are stored in the OS keychain (Keychain on macOS, Credential Manager on Windows). StoryCapture never sends them to its own servers."
    >
      <div className="mb-5">
        <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--sc-text-4)]">
          Web account
        </h3>
        <WebAccountPanel />
      </div>

      <div className="mb-4 flex items-center gap-1.5 text-xs text-[var(--sc-text-3)]">
        <Lock size={11} />
        Stored in OS keychain
      </div>

      <div className="space-y-6">
        <div>
          <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--sc-text-4)]">
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

        <div>
          <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--sc-text-4)]">
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

      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: "oklch(0.78 0.14 var(--sc-accent-h) / 0.08)",
          border: "1px solid oklch(0.78 0.14 var(--sc-accent-h) / 0.2)",
          borderRadius: "var(--sc-r-md)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          fontSize: 12,
          color: "var(--sc-text-2)",
        }}
      >
        <Info size={14} style={{ color: "var(--sc-accent-400)", marginTop: 1 }} />
        <div>
          Keys stay on this device. Team-wide BYOK sharing arrives with the web
          companion workspace plan.
        </div>
      </div>
    </SettingsPanel>
  );
}
