import { invoke } from "@tauri-apps/api/core";
import { Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiKeyRow } from "../ApiKeyRow";
import { SettingsPanel } from "../settings-row";

interface ProviderState {
  present: boolean;
  testStatus: "valid" | "invalid" | "rate_limited" | "untested";
}

const PROVIDERS = [
  { id: "openai", displayName: "OpenAI", sub: "Narration transcripts, scene summaries" },
  { id: "anthropic", displayName: "Anthropic", sub: "DSL assist, lint suggestions" },
  { id: "elevenlabs", displayName: "ElevenLabs", sub: "Voice synthesis for narrate() directives" },
  { id: "openai_tts", displayName: "OpenAI TTS", sub: "Backup voice provider" },
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

  const handlePresenceChange = useCallback((providerId: string, present: boolean) => {
    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], present },
    }));
  }, []);

  const handleTestStatusChange = useCallback(
    (providerId: string, status: ProviderState["testStatus"]) => {
      setProviders((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId], testStatus: status },
      }));
    },
    [],
  );

  return (
    <SettingsPanel
      title="API keys"
      desc="Keys are stored in the OS keychain (Keychain on macOS, Credential Manager on Windows). StoryCapture never sends them to its own servers."
    >
      <div className="space-y-2">
        {PROVIDERS.map((p) => (
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

      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)",
          borderRadius: "var(--radius-element)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          fontSize: 12,
          color: "var(--color-text-secondary)",
        }}
      >
        <Info size={14} style={{ color: "var(--color-accent)", marginTop: 1 }} />
        <div>
          <b style={{ color: "var(--color-text-accent)" }}>Team BYOK</b> &mdash; workspace admins
          can share keys scoped by scene type. Keys stay on this device; team-wide sharing arrives
          with the web companion workspace plan.
        </div>
      </div>
    </SettingsPanel>
  );
}
