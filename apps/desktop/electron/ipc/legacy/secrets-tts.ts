import { safeStorage } from "electron";
import { readJson, writeJson } from "../json-store";
import type { ProviderId, SecretStore, VoiceInfoDto } from "./shared";
import { secretStorePath } from "./web";

export function providerId(raw: unknown): ProviderId {
  const value = String(raw);
  if (
    value === "anthropic" ||
    value === "openai" ||
    value === "elevenlabs" ||
    value === "openai_tts"
  ) {
    return value;
  }
  throw new Error(`unknown provider: ${value}`);
}

export function validateKeyFormat(key: string): void {
  if (!key || key.trim() !== key) {
    throw new Error("key format is invalid for the selected provider");
  }
}

export function assertSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable on this host");
  }
}

export async function readSecretStore(): Promise<SecretStore> {
  return readJson<SecretStore>(secretStorePath(), { version: 1, keys: {} });
}

export async function writeSecretStore(store: SecretStore): Promise<void> {
  await writeJson(secretStorePath(), { version: 1, keys: store.keys ?? {} });
}

export async function keySet(provider: ProviderId, key: string): Promise<void> {
  validateKeyFormat(key);
  assertSafeStorage();
  const store = await readSecretStore();
  store.keys[provider] = safeStorage.encryptString(key).toString("base64");
  await writeSecretStore(store);
}

export async function keyGet(provider: ProviderId): Promise<string | null> {
  assertSafeStorage();
  const encrypted = (await readSecretStore()).keys[provider];
  if (!encrypted) return null;
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

export async function keyGetPresence(provider: ProviderId): Promise<boolean> {
  return (await keyGet(provider)) != null;
}

export async function keyDelete(provider: ProviderId): Promise<void> {
  const store = await readSecretStore();
  if (!store.keys[provider]) throw new Error("no key stored for this provider");
  delete store.keys[provider];
  await writeSecretStore(store);
}

export function providerProbe(provider: ProviderId) {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        header: "x-api-key",
        value: (key: string) => key,
      };
    case "elevenlabs":
      return {
        url: "https://api.elevenlabs.io/v1/voices",
        header: "xi-api-key",
        value: (key: string) => key,
      };
    case "openai":
    case "openai_tts":
      return {
        url: "https://api.openai.com/v1/models",
        header: "Authorization",
        value: (key: string) => `Bearer ${key}`,
      };
  }
}

export async function keyTest(provider: ProviderId) {
  const key = await keyGet(provider);
  if (!key) throw new Error("no key stored for this provider");
  const probe = providerProbe(provider);
  const started = Date.now();
  try {
    const response = await fetch(probe.url, {
      method: "GET",
      headers: { [probe.header]: probe.value(key) },
      signal: AbortSignal.timeout(10_000),
    });
    const detail = `${response.status} ${response.statusText}`.trim();
    if (response.status === 401 || response.status === 403) {
      throw new Error("provider rejected the key");
    }
    return {
      ok: response.ok,
      latency_ms: Date.now() - started,
      detail,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "provider rejected the key") throw error;
    throw new Error(
      `network error contacting provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function providerDisplayName(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "elevenlabs":
      return "ElevenLabs";
    case "openai_tts":
      return "OpenAI TTS";
  }
}

export async function assertProviderKey(provider: ProviderId): Promise<string> {
  const key = await keyGet(provider);
  if (!key) {
    throw new Error(`NoApiKey: no API key stored for ${providerDisplayName(provider)}`);
  }
  return key;
}

export async function nlProviderUnavailable(rawProvider: unknown): Promise<never> {
  const provider = providerId(rawProvider ?? "anthropic");
  await assertProviderKey(provider);
  throw new Error(
    `Provider: Electron ${providerDisplayName(provider)} chat is not implemented yet`,
  );
}

export async function ttsProviderUnavailable(rawProvider: unknown): Promise<never> {
  const provider = providerId(rawProvider);
  await assertProviderKey(provider);
  throw new Error(
    `Provider: Electron ${providerDisplayName(provider)} speech synthesis is not implemented yet`,
  );
}

export async function listTtsVoices(rawProvider: unknown): Promise<VoiceInfoDto[]> {
  const provider = providerId(rawProvider);
  if (provider === "openai_tts") {
    return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((id) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      locale: "en",
      premium: false,
    }));
  }
  if (provider !== "elevenlabs") {
    throw new Error(`Provider: ${providerDisplayName(provider)} is not a TTS provider`);
  }
  await assertProviderKey(provider);
  throw new Error("Provider: Electron ElevenLabs voice catalog is not implemented yet");
}

export function emptySessionRollup() {
  return {
    turn_count: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    avg_first_token_ms: null,
  };
}

export function numericDuration(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
}

export function ttsApplySyncWithoutCachedClips(rawTimings: unknown) {
  const stepTimings = Array.isArray(rawTimings) ? rawTimings : [];
  return {
    adjusted_steps: stepTimings.map((raw) => {
      const timing = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const duration = numericDuration(timing.original_duration_ms);
      return {
        step_id: String(timing.step_id ?? ""),
        new_duration_ms: duration,
        freeze_frame_extension_ms: 0,
        silence_padding_ms: 0,
        clip_start_ms: 0,
        drift_ms: 0,
      };
    }),
    duck_events: [],
  };
}
