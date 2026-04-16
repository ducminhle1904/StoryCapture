//! Phase 3 plan 03 — OS keychain + provider probe Tauri commands.
//!
//! Four commands exposed to the webview for AI provider credential management:
//!
//! | Command            | Returns                     | Purpose                              |
//! |--------------------|-----------------------------|--------------------------------------|
//! | `key_set`          | `Result<(), KeyError>`      | Persist a key to the OS keychain     |
//! | `key_get_presence` | `Result<bool, KeyError>`    | Bool-only presence check (no echo)   |
//! | `key_delete`       | `Result<(), KeyError>`      | Remove a key from the keychain       |
//! | `key_test`         | `Result<KeyTestReport, _>`  | Cheap provider-specific probe        |
//!
//! **G1 contract.** None of these commands ever writes the cleartext key
//! into a tracing span, log line, or IPC response (`key_get_presence` is
//! `bool`-typed at compile time; `KeyTestReport.detail` is derived from the
//! HTTP status only). The integration test `tests/key_no_leak_tests.rs`
//! enforces this invariant by feeding a canary string through the commands
//! under the redaction subscriber and asserting the canary never surfaces.
//!
//! **Keychain binding.** Per Phase 1 plan 01-03 FOUND-07, the project uses
//! the `keyring` crate directly (the community `tauri-plugin-keyring` isn't
//! consistently published on crates.io). The cross-platform binding covers
//! macOS Keychain + Windows Credential Manager + Linux Secret Service, which
//! is exactly the `tauri-plugin-keyring` substrate anyway. **Deviation from
//! plan** (Rule 3): plan names `tauri-plugin-keyring::KeyringExt` but the
//! project has standardised on `keyring::Entry` since Phase 1 — using the
//! plugin would introduce a second, parallel keychain code path.
//!
//! **Test URL injection.** `key_test` honours the `STORYCAPTURE_TEST_PROVIDER_BASE_URL`
//! env var as a single override for all provider probe base URLs. This is
//! the minimum-production-churn injection strategy called out in the plan's
//! Task 2 <action>: no managed state, no feature flag, just a check at the
//! call site gated by the env var's absence in production.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;

// ---- public types --------------------------------------------------------

/// Four supported AI providers. A closed Rust enum — serde rejects unknown
/// variants (T-03-03-05 mitigation) before any keychain access happens.
#[derive(Serialize, Deserialize, Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Anthropic,
    Openai,
    Elevenlabs,
    OpenaiTts,
}

impl ProviderId {
    /// Stable account string used as the keychain lookup key. Derived
    /// manually (not via `serde_json::to_string`) so future serde-rename
    /// changes can't silently break existing keychain entries.
    pub fn account(self) -> &'static str {
        match self {
            ProviderId::Anthropic => "anthropic",
            ProviderId::Openai => "openai",
            ProviderId::Elevenlabs => "elevenlabs",
            ProviderId::OpenaiTts => "openai_tts",
        }
    }
}

/// Outcome of a `key_test` probe — safe to surface to the webview.
///
/// `detail` contains the HTTP status line (e.g. `"200 OK"` or `"401 Unauthorized"`)
/// and NEVER the key, the `Authorization` header, or any provider response body.
/// The leak-proof test greps this field for the canary substring.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub struct KeyTestReport {
    pub ok: bool,
    pub latency_ms: u64,
    pub detail: String,
}

/// Structured failure modes. Each variant is derivable from a keychain or
/// HTTP error without including the key material.
#[derive(Serialize, Deserialize, Type, thiserror::Error, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum KeyError {
    #[error("OS keychain is unavailable on this host")]
    KeychainUnavailable,
    #[error("no key stored for this provider")]
    KeyNotFound,
    #[error("key format is invalid for the selected provider")]
    InvalidKeyFormat,
    #[error("provider rejected the key (auth failed)")]
    ProviderAuthFailed,
    #[error("network error contacting provider: {0}")]
    ProviderNetworkError(String),
}

impl From<keyring::Error> for KeyError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => KeyError::KeyNotFound,
            // PlatformFailure / NoStorageAccess / Invalid / Ambiguous /
            // BadEncoding — none of these expose the value, all of them
            // mean the keychain itself is broken or missing.
            _ => KeyError::KeychainUnavailable,
        }
    }
}

// ---- service constant ----------------------------------------------------

pub const SERVICE: &str = "com.storycapture.keys";

// Env-var override hook for `tests/key_no_leak_tests.rs`. In production it is
// unset and the real provider base URL is used.
const TEST_BASE_URL_ENV: &str = "STORYCAPTURE_TEST_PROVIDER_BASE_URL";

// ---- Tauri command surface ----------------------------------------------

/// Store a provider key in the OS keychain.
///
/// `#[tracing::instrument(skip(key))]` is the primary G1 defence — without it
/// tracing auto-derives `Debug` on every argument and the key would land in
/// any `INFO`-level span capture. The `intelligence::tracing::redaction_layer`
/// installed at app boot is the defence-in-depth layer.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, key))]
pub async fn key_set(
    app: tauri::AppHandle<tauri::Wry>,
    provider: ProviderId,
    key: String,
) -> Result<(), KeyError> {
    let _ = app; // AppHandle retained in signature for future plugin migration
    tracing::info!(target: "storycapture::keys", account = provider.account(), "key_set");
    key_set_for_test(SERVICE, provider, key)
}

/// Return `true` iff a key is stored for `provider`. The return type is
/// `Result<bool, KeyError>` — bool at compile time, so the value is
/// physically incapable of crossing the IPC boundary. (Acceptance criterion
/// "Return type of `key_get_presence` is `Result<bool, KeyError>`" is
/// enforced by the function signature below — grep-friendly.)
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn key_get_presence(provider: ProviderId) -> Result<bool, KeyError> {
    tracing::debug!(target: "storycapture::keys", account = provider.account(), "key_get_presence");
    key_get_presence_for_test(SERVICE, provider)
}

/// Remove a key from the keychain. Returns `KeyError::KeyNotFound` if the
/// entry was already absent (so the webview can distinguish "already gone"
/// from "keychain unavailable").
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn key_delete(provider: ProviderId) -> Result<(), KeyError> {
    tracing::info!(target: "storycapture::keys", account = provider.account(), "key_delete");
    key_delete_for_test(SERVICE, provider)
}

/// Cheap provider-specific probe. Fetches the key from the keychain, wraps
/// it in `intelligence::secrets::Redacted<String>` (so any accidental
/// `Debug`/`Display` call renders `***`), issues a single GET against the
/// provider's list endpoint, and returns latency + status.
///
/// `detail` never contains the key or the request headers — only the HTTP
/// reason line. `KeyError::ProviderAuthFailed` is returned for 401/403,
/// `KeyError::ProviderNetworkError` for transport failures.
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn key_test(provider: ProviderId) -> Result<KeyTestReport, KeyError> {
    tracing::info!(target: "storycapture::keys", account = provider.account(), "key_test");
    key_test_for_test(SERVICE, provider).await
}

// ---- service-parameterised implementations ------------------------------
//
// The `_for_test` functions take an explicit `service` string so the
// integration-test binary can use an ephemeral namespace and not collide
// with a developer's real `com.storycapture.keys` keychain entries. In
// production, the four Tauri commands above pass `SERVICE` unconditionally.

pub fn key_set_for_test(
    service: &str,
    provider: ProviderId,
    key: String,
) -> Result<(), KeyError> {
    validate_key_format(provider, &key)?;
    let entry = keyring::Entry::new(service, provider.account()).map_err(KeyError::from)?;
    entry.set_password(&key).map_err(KeyError::from)?;
    Ok(())
}

pub fn key_get_presence_for_test(
    service: &str,
    provider: ProviderId,
) -> Result<bool, KeyError> {
    let entry = keyring::Entry::new(service, provider.account()).map_err(KeyError::from)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(KeyError::from(e)),
    }
}

pub fn key_delete_for_test(service: &str, provider: ProviderId) -> Result<(), KeyError> {
    let entry = keyring::Entry::new(service, provider.account()).map_err(KeyError::from)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Err(KeyError::KeyNotFound),
        Err(e) => Err(KeyError::from(e)),
    }
}

pub async fn key_test_for_test(
    service: &str,
    provider: ProviderId,
) -> Result<KeyTestReport, KeyError> {
    // 1. Load the key and wrap it — from here on the only way to read the
    //    value is an explicit `.expose()` call at the HTTP request site.
    let entry = keyring::Entry::new(service, provider.account()).map_err(KeyError::from)?;
    let raw = entry.get_password().map_err(KeyError::from)?;
    let key = intelligence::secrets::Redacted::new(raw);

    // 2. Resolve the probe URL. Env-var override wins (tests); otherwise use
    //    the hard-coded production URL for the provider.
    let base = probe_base_url();
    let url = format!("{}{}", base.as_deref().unwrap_or(production_base(provider)), probe_path(provider));

    // 3. Dedicated rustls client — no native-tls, no plaintext fallback.
    //    10s timeout keeps the UI responsive even against a dead provider.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| KeyError::ProviderNetworkError(e.to_string()))?;

    // 4. Authorization header — the ONLY use of `.expose()` on `key`.
    let header_name = auth_header_name(provider);
    let header_value = auth_header_value(provider, key.expose());

    let started = Instant::now();
    let resp_result = client
        .get(&url)
        .header(header_name, header_value)
        .send()
        .await;
    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

    match resp_result {
        Ok(resp) => {
            let status = resp.status();
            // `detail` uses only the status line (e.g. "200 OK") — no
            // headers, no body, so the Authorization header can never
            // reflect back here.
            let detail = status.to_string();
            if status.is_success() {
                Ok(KeyTestReport { ok: true, latency_ms, detail })
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                Err(KeyError::ProviderAuthFailed)
            } else {
                Ok(KeyTestReport { ok: false, latency_ms, detail })
            }
        }
        Err(e) => Err(KeyError::ProviderNetworkError(e.without_url().to_string())),
    }
}

// ---- provider probe config ----------------------------------------------

fn probe_base_url() -> Option<String> {
    std::env::var(TEST_BASE_URL_ENV).ok()
}

fn production_base(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Anthropic => "https://api.anthropic.com",
        ProviderId::Openai | ProviderId::OpenaiTts => "https://api.openai.com",
        ProviderId::Elevenlabs => "https://api.elevenlabs.io",
    }
}

fn probe_path(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Anthropic => "/v1/models",
        ProviderId::Openai | ProviderId::OpenaiTts => "/v1/models",
        ProviderId::Elevenlabs => "/v1/voices",
    }
}

fn auth_header_name(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Anthropic => "x-api-key",
        ProviderId::Openai | ProviderId::OpenaiTts => "Authorization",
        ProviderId::Elevenlabs => "xi-api-key",
    }
}

fn auth_header_value(provider: ProviderId, key: &str) -> String {
    match provider {
        ProviderId::Anthropic | ProviderId::Elevenlabs => key.to_string(),
        ProviderId::Openai | ProviderId::OpenaiTts => format!("Bearer {key}"),
    }
}

/// Minimal key-format validation — catches empty strings and obvious
/// whitespace pastes before we hit the keychain. Stricter validation (prefix
/// checks per provider) is left to the provider probe itself; we don't want
/// to lock out a user whose provider has rotated its key prefix.
fn validate_key_format(_provider: ProviderId, key: &str) -> Result<(), KeyError> {
    if key.trim().is_empty() || key != key.trim() {
        return Err(KeyError::InvalidKeyFormat);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_account_strings_are_stable() {
        assert_eq!(ProviderId::Anthropic.account(), "anthropic");
        assert_eq!(ProviderId::Openai.account(), "openai");
        assert_eq!(ProviderId::Elevenlabs.account(), "elevenlabs");
        assert_eq!(ProviderId::OpenaiTts.account(), "openai_tts");
    }

    #[test]
    fn validate_key_format_rejects_blank_and_padded() {
        assert!(matches!(
            validate_key_format(ProviderId::Anthropic, ""),
            Err(KeyError::InvalidKeyFormat)
        ));
        assert!(matches!(
            validate_key_format(ProviderId::Anthropic, "  sk-ant-xxx  "),
            Err(KeyError::InvalidKeyFormat)
        ));
        assert!(validate_key_format(ProviderId::Anthropic, "sk-ant-xxxxxxxxxx").is_ok());
    }

    #[test]
    fn auth_header_shape_matches_provider() {
        // Anthropic: key passes through unchanged under x-api-key.
        assert_eq!(auth_header_name(ProviderId::Anthropic), "x-api-key");
        assert_eq!(auth_header_value(ProviderId::Anthropic, "sk-k"), "sk-k");
        // OpenAI / OpenAI TTS: Bearer prefix, Authorization header.
        assert_eq!(auth_header_name(ProviderId::Openai), "Authorization");
        assert_eq!(auth_header_value(ProviderId::Openai, "sk-k"), "Bearer sk-k");
        assert_eq!(auth_header_name(ProviderId::OpenaiTts), "Authorization");
        // ElevenLabs: xi-api-key header.
        assert_eq!(auth_header_name(ProviderId::Elevenlabs), "xi-api-key");
        assert_eq!(auth_header_value(ProviderId::Elevenlabs, "xi-k"), "xi-k");
    }
}
