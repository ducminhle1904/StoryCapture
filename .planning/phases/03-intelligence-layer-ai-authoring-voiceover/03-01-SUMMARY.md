---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 01
subsystem: intelligence
tags: [rust, crate-scaffold, traits, redaction, tracing, security-guardrail]
requirements: [AI-05]
dependency_graph:
  requires:
    - "Cargo workspace root (Phase 1 FOUND-01 — already present)"
    - "crates/story-parser (path dep)"
  provides:
    - "crates/intelligence::llm::LlmProvider trait + LlmRequest/LlmEvent/LlmError"
    - "crates/intelligence::tts::TtsProvider trait + TtsRequest/VoiceInfo/TtsError"
    - "crates/intelligence::secrets::Redacted<T> wrapper"
    - "crates/intelligence::tracing::{redaction_layer, install_redaction_layer, RedactionLayer}"
    - "crates/intelligence::IntelError unified error enum"
    - "G1 guardrail test (no_secret_leaks_in_tracing_output)"
  affects:
    - "All subsequent Phase-3 plans consume these traits (Waves 2–3 LLM + TTS provider impls)"
tech_stack:
  added:
    - "reqwest 0.12 (rustls-tls, json, stream, gzip)"
    - "eventsource-stream 0.2"
    - "tower-lsp 0.20"
    - "schemars 0.8 (preserve_order)"
    - "async-trait 0.1"
    - "regex 1"
    - "sha2 0.10"
  patterns:
    - "Object-safe async trait via #[async_trait::async_trait] + Send + Sync bounds"
    - "Single unified error enum (IntelError) re-exporting provider errors via #[from]"
    - "Redaction enforced at the tracing Layer — all sinks inherit scrubbing"
key_files:
  created:
    - "crates/intelligence/Cargo.toml"
    - "crates/intelligence/src/lib.rs"
    - "crates/intelligence/src/error.rs"
    - "crates/intelligence/src/secrets.rs"
    - "crates/intelligence/src/llm/mod.rs"
    - "crates/intelligence/src/llm/anthropic.rs (placeholder)"
    - "crates/intelligence/src/llm/openai.rs (placeholder)"
    - "crates/intelligence/src/tts/mod.rs"
    - "crates/intelligence/src/tts/elevenlabs.rs (placeholder)"
    - "crates/intelligence/src/tts/openai_tts.rs (placeholder)"
    - "crates/intelligence/src/tracing/mod.rs"
    - "crates/intelligence/src/tracing/redact.rs"
    - "crates/intelligence/tests/redaction_tests.rs"
  modified:
    - "Cargo.toml (workspace members + Cargo.lock regeneration)"
decisions:
  - "RedactionLayer implements tracing_subscriber::Layer directly (not a FormatEvent wrapper) — keeps responsibility narrow and sink-agnostic"
  - "Value-level regex scrubbing runs on EVERY string field in addition to field-name deny list — defence in depth against future callers logging keys under non-standard field names"
  - "Bearer regex runs before sk-/xi- regexes so 'Bearer <token>' collapses into a single `***` rather than `Bearer ***`"
  - "Placeholder modules (anthropic, openai, elevenlabs, openai_tts) created as empty files so later waves can land provider impls without re-editing mod.rs declarations"
metrics:
  tasks_completed: 3
  tasks_total: 3
  files_created: 13
  files_modified: 1
  completed: 2026-04-15
  duration_minutes: ~12
---

# Phase 03 Plan 01: Intelligence Crate Skeleton + Redaction Guardrail Summary

Bootstrapped `crates/intelligence` with the LlmProvider + TtsProvider trait surface, shared `IntelError` taxonomy, `Redacted<T>` secret wrapper, and a production-ready tracing redaction layer that proves guardrail G1 via three integration tests — locking the contract + security baseline before Wave 2/3 provider implementations land.

## What Was Built

**Crate scaffold (Task 1)** — New workspace member `crates/intelligence` with Cargo.toml pins exactly matching AI-SPEC §3 (reqwest 0.12 rustls, eventsource-stream 0.2, schemars 0.8, tower-lsp 0.20, tokio 1.40, sha2 0.10, plus regex 1 added for the redaction layer). `Redacted<T>` wrapper suppresses both Debug and Display — the only way to read the inner value is via the explicit `.expose()` method. `IntelError` is a unified `#[from]`-composed enum spanning `LlmError`, `TtsError`, `std::io::Error`, and `serde_json::Error`.

**Trait contracts (Task 2)** — `LlmProvider::stream(req, tx)` takes an mpsc sender so callers can begin consuming `LlmEvent`s as soon as the first byte arrives over SSE. `LlmError` contains all 9 variants required by AI-SPEC pitfall #8 (notably `RateLimited { retry_after_s: u64 }` for the exponential-backoff retry policy). `TtsProvider` exposes both `synthesize` and `list_voices` so the desktop app can populate voice pickers without first attempting a synthesis. Object-safety is proven at compile time via `fn _takes_box(_: Box<dyn LlmProvider>)` type-check tests.

**Redaction layer (Task 3)** — `RedactionLayer<W>` implements `tracing_subscriber::Layer` with a case-insensitive field-name deny list (authorization, x-api-key, x_api_key, xi-api-key, xi_api_key, cookie, set-cookie, api_key, apikey) and four value-level regexes (`Bearer\s+[A-Za-z0-9_\-\.]{10,}`, `sk-[A-Za-z0-9_\-]{10,}`, `xai-[A-Za-z0-9_\-]{10,}`, `xi-[A-Za-z0-9_\-]{10,}`). The `tests/redaction_tests.rs` harness wires the layer to an in-memory `MakeWriter` and asserts that — given concrete fake keys — the rendered output contains neither the raw key material nor the `Bearer` prefix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `regex = "1"` to Cargo.toml during Task 1 rather than Task 3**
- **Found during:** Task 1
- **Issue:** Plan instructs adding regex in Task 3, but Task 1 acceptance criterion requires `cargo check -p intelligence` to pass before Task 3 touches the manifest. To keep the manifest stable after Task 1 commit (so verifier can grep for `regex = "1"` at any point) and avoid a redundant Cargo.toml edit in Task 3, the dep was added up front.
- **Fix:** Single regex line added in Task 1's Cargo.toml; Task 3 only added source files.
- **Files modified:** crates/intelligence/Cargo.toml
- **Commit:** 1706090

**2. [Rule 2 - Critical] Exposed `RedactionLayer` + `redaction_layer` helper in addition to `install_redaction_layer`**
- **Found during:** Task 3
- **Issue:** Plan lists `install_redaction_layer` as the only entry point, but that function calls `set_global_default` — which fails if a global subscriber is already set. Integration tests need to install the layer per-test via `tracing::subscriber::with_default`, so a constructor that returns the layer (not a process-global subscriber) is required.
- **Fix:** Added `pub fn redaction_layer<W>(writer) -> RedactionLayer<W>` alongside `install_redaction_layer`. Tests use the former, downstream production bootstrap code uses the latter.
- **Files modified:** crates/intelligence/src/tracing/redact.rs, crates/intelligence/src/tracing/mod.rs
- **Commit:** f76629e

No other deviations. Plan executed as written.

## Guardrail Evidence

**G1 — No secret leaks in tracing output:** `cargo test -p intelligence --test redaction_tests` → 3 / 3 passing.

| Test | Attack Vector | Result |
|------|---------------|--------|
| `no_secret_leaks_in_tracing_output` | `authorization` field carrying `Bearer sk-ant-api03-ABCDEFGHIJKLMNOP` | PASS — neither the key nor the `Bearer ` prefix present in rendered output |
| `x_api_key_field_is_redacted` | `x_api_key` field carrying `xi-elev-123abcDEF45` | PASS — redacted by field-name deny list |
| `value_level_regex_scrubs_inline_keys` | `message` field containing `sk-ant-api03-XXXYYYZZZAAA` inline (non-deny-listed field name) | PASS — redacted by value-level regex |

## Verification Commands

```bash
cargo check -p intelligence                             # exit 0
cargo test -p intelligence --lib                        # 9 passed
cargo test -p intelligence --test redaction_tests       # 3 passed
```

## Commits

| Task | Message | Hash |
|------|---------|------|
| 1 | feat(03-01): scaffold crates/intelligence with Redacted wrapper + IntelError | 1706090 |
| 2 | feat(03-01): define LlmProvider + TtsProvider traits with full error taxonomy | 795d4f1 |
| 3 | feat(03-01): tracing redaction layer + G1 no-leak assertion (guardrail) | f76629e |

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-03-01-01 (Info Disclosure — tracing) | mitigated | Field deny list + value regex in `redact.rs`; G1 tests green |
| T-03-01-02 (Tampering — Cargo deps) | mitigated | EXACT pins in Cargo.toml for pre-1.0 deps (eventsource-stream 0.2, schemars 0.8, tower-lsp 0.20) |
| T-03-01-03 (Info Disclosure — Redacted) | mitigated | `redacted_debug_hides_inner` unit test green |
| T-03-01-04 (Spoofing — TLS) | mitigated | reqwest `default-features = false, features = ["rustls-tls", ...]` — no native-tls, no plaintext fallback |

No new threat surface introduced beyond the plan's register.

## Handoff Notes for Next Plan (03-02)

- `LlmProvider` is stable. Downstream provider impls add `mod anthropic;` / `mod openai;` bodies in-place (files exist as placeholders).
- `redaction_layer()` is the constructor to use in production bootstrap — compose with `tracing_subscriber::Registry::default().with(...)` and whatever fmt layer / file appender the desktop shell prefers. For tests, use `tracing::subscriber::with_default` to avoid the global-default single-set limitation.
- `Redacted<T>` is `Clone` when `T: Clone`. API-key values loaded from `tauri-plugin-keyring` should be wrapped immediately on read and never deconstructed outside the HTTP client call site.

## Self-Check: PASSED

- FOUND: crates/intelligence/Cargo.toml
- FOUND: crates/intelligence/src/lib.rs
- FOUND: crates/intelligence/src/error.rs
- FOUND: crates/intelligence/src/secrets.rs
- FOUND: crates/intelligence/src/llm/mod.rs
- FOUND: crates/intelligence/src/tts/mod.rs
- FOUND: crates/intelligence/src/tracing/mod.rs
- FOUND: crates/intelligence/src/tracing/redact.rs
- FOUND: crates/intelligence/tests/redaction_tests.rs
- FOUND: commit 1706090
- FOUND: commit 795d4f1
- FOUND: commit f76629e
- `cargo check -p intelligence` exit 0
- `cargo test -p intelligence` 12 passed / 0 failed
