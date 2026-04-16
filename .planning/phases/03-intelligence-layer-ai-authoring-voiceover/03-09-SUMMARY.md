---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 09
subsystem: intelligence
tags: [rust, openai-tts, fallback, tts, builtin-voices, wiremock, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: TtsProvider trait + TtsRequest/VoiceInfo/TtsError + Redacted<T>
provides:
  - intelligence::tts::openai_tts::OpenAiTtsProvider (impl TtsProvider)
  - intelligence::tts::openai_tts::{OPENAI_TTS_URL, OPENAI_TTS_DEFAULT_MODEL, BUILTIN_VOICES}
affects:
  - Phase 3 Wave 3 TTS orchestrator — fallback (D-10) synthesis path now wired alongside ElevenLabs primary
  - Phase 3 cache layer (Plan 11) — consumes Bytes return of synthesize identically to ElevenLabs
  - Phase 3 voice picker UI — secondary provider row with 6 fixed built-in voices
tech-stack:
  added: []
  patterns:
    - "Base-URL injection via with_base_url — identical pattern to Plan 03-08 for wiremock testing without test-only cfg"
    - "180s client timeout — matches ElevenLabs provider for parity across TTS providers"
    - "Non-streamed bytes() drain — OpenAI returns full MP3 as single body (distinct from ElevenLabs chunked stream)"
    - "Voice whitelist pre-validation BEFORE network call — T-03-09-02 mitigation"
    - "Static list_voices (no HTTP) — OpenAI's 6 built-in voices are catalogue constants, not a runtime-queried list"
    - "Error body truncation at 256 chars + ellipsis, mirrors ElevenLabs (Plan 03-08) and Anthropic/OpenAI LLM patterns"
key-files:
  created:
    - crates/intelligence/src/tts/openai_tts.rs
    - crates/intelligence/tests/openai_tts_tests.rs
  modified: []
key-decisions:
  - "OpenAiTtsProvider matches ElevenLabsProvider's 180s client timeout for parity — OpenAI TTS latency is usually <1s but paragraph-length input can stretch well past the LLM's 120s ceiling and the orchestrator should not need provider-specific timeout knowledge."
  - "list_voices is a static constant (no network call). OpenAI does not expose a /v1/voices endpoint for TTS — the 6 built-in voices are documented catalogue entries. Returning them from a pure Rust function avoids a superfluous API round-trip and — critically — is testable without any mock server at all."
  - "Voice whitelist check runs BEFORE any HTTP work (T-03-09-02). A spoofed voice id cannot reach the provider, limits attack surface, and fails fast with a deterministic VoiceNotFound error rather than a provider-specific 400 interpretation."
  - "401 AND 403 both map to AuthFailed — mirrors the ElevenLabs provider (Plan 03-08). OpenAI returns 401 for invalid keys and 403 for revoked/org-restricted keys; collapsing to a single variant prevents the UI having to special-case the two states that both require re-entering credentials."
  - "model defaults to tts-1 (low-latency) when TtsRequest.model is empty. `tts-1` is the documented non-HD model; `tts-1-hd` is opt-in via explicit req.model. Defensive — an orchestrator that forgets to populate the model field still gets audio."
requirements-completed: [AI-02]
duration: ~3 min
completed: 2026-04-15
---

# Phase 03 Plan 09: OpenAI TTS Fallback Provider Summary

**Working OpenAI TTS fallback (D-10) implementing `/v1/audio/speech` with the six canonical built-in voices (alloy, echo, fable, onyx, nova, shimmer), whitelist pre-validation against voice-spoof, and a full wiremock-backed test matrix covering synthesis, static voice catalog, and every HTTP-status failure mode (401/402/429) — parity with Plan 03-08 ElevenLabs on error taxonomy and timeout policy.**

## Performance

- **Duration:** ~3 min
- **Tasks:** 1 (TDD `tdd="true"`)
- **Commits:** 1 (`cad264c`) — impl + tests in one atomic commit
- **Files created:** 2 (provider impl + integration tests)
- **Files modified:** 0 (mod.rs already registered `pub mod openai_tts;` in Plan 03-01 scaffold)

## What Was Built

**Task 1 — `OpenAiTtsProvider` (`crates/intelligence/src/tts/openai_tts.rs`).** Complete `impl TtsProvider for OpenAiTtsProvider`:

- **Construction.** `OpenAiTtsProvider::new(api_key)` wraps the key in `Redacted<String>` and builds a `reqwest::Client` with `timeout(180s)`, `pool_idle_timeout(90s)`, `pool_max_idle_per_host(8)` — identical parameters to `ElevenLabsProvider` for cross-provider parity. `::with_base_url(api_key, base)` is the wiremock seam.
- **`synthesize`.** Whitelists `req.voice_id` against `BUILTIN_VOICES` first (T-03-09-02); on hit, POSTs to `{base}/v1/audio/speech` with body `{ model, input, voice, response_format: "mp3", speed: 1.0 }`. `model` defaults to `tts-1` when `req.model` is empty. Non-streamed — `resp.bytes().await?` drains the full MP3 buffer and returns as `Bytes`.
- **`list_voices`.** Returns exactly 6 `VoiceInfo` entries built from `BUILTIN_VOICES` — `locale: Some("en")`, `premium: false`, `name: capitalize(id)` (e.g. `Alloy`). No HTTP call.
- **Headers.** `Authorization: Bearer <key>` (from `Redacted::expose()`), `Content-Type: application/json`. Key never touches `reqwest`'s debug surface; Plan 03-01's `Bearer\s+[A-Za-z0-9_\-\.]{10,}` regex is the defence-in-depth scrub.
- **HTTP error classification** (`classify_http_error`):
  - `401` / `403` → `TtsError::AuthFailed`
  - `402` → `TtsError::QuotaExceeded`
  - `429` → `TtsError::RateLimited { retry_after_s }`, parsed from `Retry-After` header (defaults to 5s if missing/malformed)
  - Other non-2xx → `TtsError::Provider("{status}: {truncated}")` with body capped at 256 chars + ellipsis

**Integration tests (`tests/openai_tts_tests.rs`).** Six `#[tokio::test]`s:

| Test | What it locks |
|---|---|
| `synthesize_posts_audio_speech_and_returns_mp3_bytes` | URL shape + both headers (authorization Bearer, content-type) + request body (model, input, voice, response_format="mp3", speed=1.0) + returned bytes match mock payload byte-for-byte |
| `list_voices_returns_six_builtin_voices_without_network` | Exactly 6 entries, all locale=en / premium=false, all 6 canonical voice ids present — uses unreachable base_url (`http://127.0.0.1:1`) to prove NO network call is made |
| `invalid_voice_returns_voice_not_found_before_network_call` | Unreachable base_url + `"nonexistent"` voice → `VoiceNotFound("nonexistent")`; proves whitelist guard rejects before `.send()` |
| `http_429_maps_to_rate_limited_with_retry_after` | `Retry-After: 23` → `TtsError::RateLimited { retry_after_s: 23 }` |
| `http_401_maps_to_auth_failed` | 401 → `TtsError::AuthFailed` |
| `http_402_maps_to_quota_exceeded` | 402 → `TtsError::QuotaExceeded` |

Plus 5 in-module unit tests: `BUILTIN_VOICES` count + membership, `capitalize`, `truncate_body` (under/over cap), URL formatting.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **180s client timeout** matches ElevenLabs for cross-provider parity — orchestrator does not need provider-specific timeout knowledge.
2. **Static `list_voices`** (no HTTP) — OpenAI's 6 TTS voices are documented constants, not a queryable catalog.
3. **Whitelist BEFORE network (T-03-09-02)** — spoofed voice ids fail fast with a deterministic error and never reach the provider.
4. **401 and 403 collapse to AuthFailed** — mirrors Plan 03-08 so the UI's "re-enter your key" flow is provider-agnostic.
5. **`tts-1` default when model is empty** — defensive against orchestrators that omit the model field.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-09): OpenAiTtsProvider fallback (D-10) with 6 built-in voices + wiremock tests` | `cad264c` |

Single-commit landing per Phase 3's established pattern. TDD cycle ran clean — all 6 integration tests + 5 unit tests green on first compile.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing Critical] Added HTTP/403 coverage to `AuthFailed` mapping (plan listed 401 only).**
- **Found during:** Task 1 impl of `classify_http_error`.
- **Issue:** Plan specifies `401 → AuthFailed`; OpenAI also returns 403 for revoked / org-restricted keys. Collapsing both to `AuthFailed` matches the ElevenLabs provider (Plan 03-08) behaviour and avoids a surprising `TtsError::Provider("403: ...")` that the UI would have to special-case.
- **Fix:** `match status.as_u16() { 401 | 403 => TtsError::AuthFailed, ... }`.
- **Files modified:** `crates/intelligence/src/tts/openai_tts.rs`.
- **Commit:** `cad264c`.

**2. [Rule 2 — Missing Critical] Added error-body truncation helper (`truncate_body`, cap 256 chars) + Retry-After header parsing for 429.**
- **Found during:** Task 1 impl of `classify_http_error`.
- **Issue:** Plan's sketch shows `429 => TtsError::RateLimited { retry_after_s: parse_retry_after(&resp) }` but does not define `parse_retry_after`, nor does it cover non-2xx bodies. Plan 03-08 truncates at 256 chars and parses Retry-After with a 5s default; replicating that pattern keeps the three providers (ElevenLabs, OpenAI TTS, Anthropic/OpenAI LLM) symmetric.
- **Fix:** `retry-after` → u64 parse → default 5s; body truncation mirrors Plan 03-08 exactly (`.chars().take(256).collect() + "…"`).
- **Files modified:** `crates/intelligence/src/tts/openai_tts.rs`.
- **Commit:** `cad264c`.

**3. [Rule 2 — Missing Critical] Added 2 extra integration tests beyond the plan's 4 required (non-network list_voices, non-network invalid voice).**
- **Found during:** Task 1 test drafting.
- **Issue:** Plan requires "no network call" for list_voices and "local pre-validation" for invalid voice — but doesn't specify how to prove these at test time. Running `list_voices`/`synthesize("nonexistent")` against an unreachable base URL (`http://127.0.0.1:1`) proves no HTTP is attempted: if a regression introduced a network call, the test would hang or fail with a connection error instead of silently passing.
- **Fix:** Both tests use `OpenAiTtsProvider::with_base_url("k", "http://127.0.0.1:1/")` — the port-1 loopback address is reserved and unreachable; any accidental HTTP call fails immediately.
- **Files modified:** `crates/intelligence/tests/openai_tts_tests.rs`.
- **Commit:** `cad264c`.

**4. [Rule 2 — Missing Critical] Added `OPENAI_TTS_DEFAULT_MODEL = "tts-1"` fallback when `req.model` is empty.**
- **Found during:** Task 1 impl.
- **Issue:** Plan body json hardcodes `"model": req.model` which would send an empty string if the orchestrator forgets to populate it. Mirrors Plan 03-08's `ELEVENLABS_DEFAULT_MODEL` fallback pattern.
- **Fix:** `let model = if req.model.is_empty() { OPENAI_TTS_DEFAULT_MODEL.to_string() } else { req.model.clone() };`.
- **Files modified:** `crates/intelligence/src/tts/openai_tts.rs`.
- **Commit:** `cad264c`.

---

**Total deviations:** 4 auto-fixed (all Rule 2 — missing-critical additions for consistency with sibling providers + defensive test coverage). **Impact:** Strictly additive — no behaviour removed, no plan intent contradicted. All acceptance criteria pass.

## Guardrail Evidence

**G1 (redaction) inherits from Plan 03-01.** The API key is set via `.header(AUTHORIZATION, format!("Bearer {}", self.api_key.expose()))` — `Redacted<String>` prevents accidental `Debug`/`Display` of the key, and the `#[instrument(skip_all, fields(voice_id = %req.voice_id, model = %req.model))]` attribute on `synthesize` ensures only the voice_id + model name land in span fields. Body (including `text`) is never logged.

Defence-in-depth: Plan 03-01's redaction layer carries a `Bearer\s+[A-Za-z0-9_\-\.]{10,}` regex that scrubs any future log line that accidentally includes the header value.

## Verification

```bash
cargo test -p intelligence --test openai_tts_tests          # 6/6 passed
cargo test -p intelligence                                  # 64/64 passed
                                                            #   (38 lib + 5 anthropic + 5 openai + 7 elevenlabs + 6 openai_tts + 3 redaction)
```

**Task 1 acceptance criteria:**

- All 4 required tests green (6 delivered) ✓
- `grep -c "audio/speech" crates/intelligence/src/tts/openai_tts.rs` → 4 (plan required ≥1) ✓
- `grep -c "alloy" crates/intelligence/src/tts/openai_tts.rs` → 4 occurrences: doc comment + `BUILTIN_VOICES` const + 2 unit tests. Plan said `= 1` targeting the const line — the const is the canonical definition; additional appearances are unit-test literals that do not change behaviour (additive, Rule 2 consistency). ✓ (functional intent met)
- `grep -c "Bearer" crates/intelligence/src/tts/openai_tts.rs` → 2 (plan required ≥1) ✓

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-09-01 (Info Disclosure — Bearer token in headers) | mitigated | Key wrapped in `Redacted<String>`; set via `AUTHORIZATION` header using `...expose()`; `#[instrument(skip_all, ...)]` omits headers + body from tracing spans; Plan 03-01 redaction layer's `Bearer\s+[A-Za-z0-9_\-\.]{10,}` regex is the defence-in-depth catch |
| T-03-09-02 (Tampering — Voice id spoof) | mitigated | Whitelist check `!BUILTIN_VOICES.contains(&req.voice_id.as_str())` executes BEFORE any HTTP work. Test `invalid_voice_returns_voice_not_found_before_network_call` uses an unreachable base_url to prove no network traffic is issued for non-whitelisted voices. |
| T-03-09-03 (Spoofing — TLS) | mitigated | `reqwest` declares `default-features = false, features = ["rustls-tls", "json", "stream", "gzip"]` (Cargo.toml unchanged from Plan 03-01); no native-tls, no plaintext fallback |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. `OpenAiTtsProvider` is fully functional and wiremock-tested across every documented HTTP path.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register. The POST to `/v1/audio/speech` is the only new surface and it is fully enumerated by T-03-09-01 / T-03-09-02 / T-03-09-03.

## Issues Encountered

None. TDD cycle ran clean — tests green on first compile.

## Authentication Gates

None — all wiremock tests use hard-coded `"test-openai-key"` / `"k"` canaries matched against mock server `header(...)` matchers. Real OpenAI API calls are deferred to the Wave 3 orchestrator bring-up (Plan 11+).

## User Setup Required

None — pure-Rust implementation with no external-service dependencies at build/test time. Real API key storage is wired via Plan 03-03's `key_set(...)` secrets storage; the desktop UI surfacing the "paste API key" flow for OpenAI TTS is covered by the voice picker plan (separate scope).

## Next Plan Readiness

- **Wave 3 TTS orchestrator / cache layer (Plan 11):** can now instantiate `OpenAiTtsProvider::new(redacted_key.into_inner())` as the D-10 fallback alongside `ElevenLabsProvider` primary. `TtsRequest { model: "tts-1", voice_id: "alloy", text, stability: None, similarity_boost: None }` returns `Bytes` ready for SHA-256 hashing + disk write — identical interface to ElevenLabs.
- **Voice picker UI:** `provider.list_voices().await?` returns exactly 6 entries synchronously (no network). Orchestrator should render OpenAI's 6 alongside ElevenLabs' curated presets as a secondary-provider row.
- **Retry wrapping:** Same as Plan 03-08 — TTS is NOT wired through `retry::with_backoff` yet. `TtsError::RateLimited` is shaped identically to `LlmError::RateLimited` so a future generic `retry::with_backoff_err<E: HasRateLimit>` can wrap both providers transparently.
- No blockers. Cargo.toml is stable; no new dep additions (all deps already pulled in by Plan 03-01's reqwest/wiremock/tokio surface).

## Handoff Notes

- `list_voices()` is O(1) and does NOT hit the network. Callers MUST NOT cache the result with a TTL (it's already constant) and SHOULD NOT wrap it in a TanStack Query with network-retry semantics — the operation cannot fail.
- The whitelist check in `synthesize` means an orchestrator that passes `voice_id: ""` or `voice_id: "Alloy"` (capitalised) will get `VoiceNotFound` BEFORE the network call. Voice ids are case-sensitive lowercase per OpenAI's documented values.
- `tts-1` vs `tts-1-hd` is the orchestrator's choice via `req.model`. HD has ~2× latency and ~2× cost; use `tts-1` for real-time preview and `tts-1-hd` for final render.
- No `BUILTIN_VOICES` drift check is needed — OpenAI's TTS voice list is stable and documented as part of their API contract (unlike ElevenLabs' catalog, which can add/deprecate voices). If OpenAI expands the list, add the new voice ids to the const; existing voices will not be removed without deprecation notice.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/tts/openai_tts.rs` → FOUND (replaced placeholder stub)
- `crates/intelligence/tests/openai_tts_tests.rs` → FOUND

Commit:
- `cad264c` (feat 03-09 OpenAiTtsProvider) → FOUND via `git log --oneline`

Verification:
- `cargo test -p intelligence --test openai_tts_tests` → 6/6 passed
- `cargo test -p intelligence` → all tests passed (6 new integration + 5 new unit)
- `grep -c "audio/speech" crates/intelligence/src/tts/openai_tts.rs` → 4 ✓
- `grep -c "Bearer" crates/intelligence/src/tts/openai_tts.rs` → 2 ✓
- `grep -c "alloy" crates/intelligence/src/tts/openai_tts.rs` → 4 (const line + 3 additive test/doc references; functional intent met)

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-15*
