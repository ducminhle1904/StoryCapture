/**
 * Settings -> Accounts page (Plan 03-20, Task 1).
 *
 * Single column, max-width 720px centered layout.
 * Header: "Cai dat tai khoan" + keychain callout badge.
 * Two sections: LLM (Anthropic, OpenAI) + TTS (ElevenLabs, OpenAI TTS).
 * Empty state: "Chua co API key nao" + explanation copy.
 *
 * data-testid="accounts-page"
 */

import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";
import { ApiKeyRow } from "./ApiKeyRow";

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

  return (
    <div
      data-testid="accounts-page"
      className="mx-auto max-w-[720px] px-6 py-8"
    >
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {"C\u00e0i \u0111\u1eb7t t\u00e0i kho\u1ea3n"}
        </h1>
        <div
          className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-sm text-green-800"
          id="keychain-docs"
          aria-describedby="keychain-docs"
        >
          <Lock className="h-3.5 w-3.5" />
          <span>{"🔒 Lưu trong OS Keychain"}</span>
        </div>
      </div>

      {/* Empty state */}
      {allAbsent && (
        <div className="mb-6 rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center">
          <p className="text-sm font-medium text-[var(--color-fg)]">
            {"Ch\u01b0a c\u00f3 API key n\u00e0o"}
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {"API key \u0111\u01b0\u1ee3c l\u01b0u v\u00e0o Keychain m\u00e1y b\u1ea1n, kh\u00f4ng g\u1eedi l\u00ean server."}
          </p>
        </div>
      )}

      {/* LLM section */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
          LLM
        </h2>
        <div className="space-y-2">
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

      {/* TTS section */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
          TTS
        </h2>
        <div className="space-y-2">
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
  );
}
