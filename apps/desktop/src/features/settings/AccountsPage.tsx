/**
 * Settings -> Accounts page.
 *
 * Single column, max-width 720px centered layout.
 * Header: "Cai dat tai khoan" + keychain callout badge.
 * Two sections: LLM (Anthropic, OpenAI) + TTS (ElevenLabs, OpenAI TTS).
 * Empty state: "Chua co API key nao" + explanation copy.
 *
 * data-testid="accounts-page"
 */

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

  // On mount: check presence of all keys
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
          // Keychain unavailable -- leave as absent
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
  const allAbsent = Object.values(providers).every((p) => !p.present);
  const connectedCount = Object.values(providers).filter((p) => p.present).length;

  return (
    <div data-testid="accounts-page" className="space-y-8">
      <div className="max-w-2xl">
        <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
          Credentials
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-[var(--color-fg-primary)]">
          Accounts and providers
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-fg-secondary)]">
          Configure model providers, voice services, and the optional web account
          from one surface.
        </p>
        <div
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-success)]/25 bg-[var(--color-success)]/12 px-3 py-1 text-sm text-[var(--color-success)]"
          id="keychain-docs"
          aria-describedby="keychain-docs"
        >
          <Lock className="h-3.5 w-3.5" />
          <span>{"Lưu trong OS Keychain"}</span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
            Connected providers
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tracking-[-0.04em] text-[var(--color-fg-primary)]">
            {connectedCount}
          </div>
        </div>
        <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
            LLM services
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
            Anthropic, OpenAI
          </div>
        </div>
        <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
            Voice services
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
            ElevenLabs, OpenAI TTS
          </div>
        </div>
      </div>

      <section className="mb-8">
        <WebAccountPanel />
      </section>

      {allAbsent && (
        <div className="mb-6 rounded-[var(--radius-2xl)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-400)] p-6 text-center">
          <p className="text-sm font-medium text-[var(--color-fg-primary)]">
            No API keys connected yet
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Keys are stored in your machine keychain and never written into a
            project file.
          </p>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="brand-panel rounded-[var(--radius-2xl)] px-5 py-5">
          <h2 className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
            LLM providers
          </h2>
          <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-secondary)]">
            Anthropic and OpenAI power natural language mode, planning, and
            assistant workflows.
          </p>
          <div className="mt-5 space-y-2">
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
        </section>

        <section className="brand-panel rounded-[var(--radius-2xl)] px-5 py-5">
          <h2 className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
            Voice providers
          </h2>
          <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-secondary)]">
            ElevenLabs and OpenAI TTS drive preview voice, script generation, and
            voiceover clips.
          </p>
          <div className="mt-5 space-y-2">
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
        </section>
      </div>
    </div>
  );
}
