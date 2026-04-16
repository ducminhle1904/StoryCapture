---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 08
subsystem: intelligence
tags: [rust, elevenlabs, tts, streaming-mp3, voice-catalog, curated-presets, wiremock, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: TtsProvider trait + TtsRequest/VoiceInfo/TtsError + Redacted<T>
provides:
  - intelligence::tts::elevenlabs::ElevenLabsProvider (impl TtsProvider)
  - intelligence::tts::elevenlabs::{ELEVENLABS_URL, ELEVENLABS_DEFAULT_MODEL}
  - intelligence::tts::voice_presets::{VoicePreset, CURATED_PRESETS} (6 entries — D-11)
  - Fixture corpus for ElevenLabs voice catalog tests (voices_list.json)
affects:
  - Phase 3 Wave 3 TTS orchestrator — primary (D-10) synthesis path now wired
  - Phase 3 cache layer (Plan 11) — consumes Bytes return of synthesize to hash + persist MP3
  - Phase 3 voice picker UI (Plan 19) — reads CURATED_PRESETS for curated-row + list_voices() for the "All voices" pane
tech-stack:
  added: []
  patterns:
    - "Base-URL injection via with_base_url — identical pattern to Plan 03-04/05 for wiremock without test-only cfg"
    - "180s client timeout (vs 120s LLM) — MP3 streams run longer than text"
    - "Chunked bytes_stream drained into single Bytes buffer — cache layer writes once"
    - "Accent-to-locale mapping for common English dialects (american/british/australian/irish/english → en); unknown passes through"
    - "Error body truncation at 256 chars + ellipsis, mirrors T-03-04-06 / T-03-05 patterns"
key-files:
  created:
    - crates/intelligence/src/tts/elevenlabs.rs
    - crates/intelligence/src/tts/voice_presets.rs
    - crates/intelligence/tests/elevenlabs_tests.rs
    - crates/intelligence/tests/fixtures/elevenlabs/voices_list.json
  modified:
    - crates/intelligence/src/tts/mod.rs (+ pub mod voice_presets)
key-decisions:
  - "ElevenLabsProvider uses a 180s client timeout — LLM clients at 120s are tuned for text streams; TTS MP3 streams for long narration paragraphs routinely exceed that. 180s matches the plan's stated client-builder spec (longer than LLM)."
  - "accent_to_locale maps the five common English accents (american/british/australian/irish/english) to BCP-47 'en'; non-English accents pass through as the raw accent string. Alternative (require labels.language) was rejected because the ElevenLabs voices API returns accent, not language, for most premade voices."
  - "VoiceInfo.premium derived from category == 'professional'. premade/cloned/generated categories collapse to premium=false. Preserves the three-state 'premade vs professional' distinction that the voice-picker UI renders as a badge."
  - "Default voice_settings (stability 0.5 / similarity_boost 0.75 / style 0 / use_speaker_boost true) are baked into synthesize when TtsRequest.stability / .similarity_boost are None. Callers explicitly opting for different values pass Some(f32) — the AI-SPEC §4 defaults become the path-of-least-resistance for the Wave 3 orchestrator."
  - "model_id falls back to eleven_multilingual_v2 when TtsRequest.model is empty — defensive against an orchestrator that forgets to populate the model field; the default is the v2 production model per AI-SPEC §4 (line 437)."
requirements-completed: [AI-02]
duration: ~5 min
completed: 2026-04-15
---

# Phase 03 Plan 08: ElevenLabs TTS Provider + Curated Presets Summary

**Working ElevenLabs streaming MP3 synthesis provider with voice catalog fetch, curated 6-voice preset catalog (D-11), and a full wiremock-backed test matrix covering synthesis, catalog parsing, and every HTTP-status failure mode (401/402/404/429).**

## Performance

- **Duration:** ~5 min
- **Tasks:** 1 (TDD `tdd="true"`)
- **Commits:** 1 (`cd25e30`) — impl + tests + fixtures + presets in one atomic commit
- **Files created:** 4 (provider impl + presets + integration test + fixture)
- **Files modified:** 1 (`tts/mod.rs` registers `pub mod voice_presets`)

## What Was Built

**Task 1 — `ElevenLabsProvider` (`crates/intelligence/src/tts/elevenlabs.rs`).** Complete `impl TtsProvider for ElevenLabsProvider`:

- **Construction.** `ElevenLabsProvider::new(api_key)` wraps the key in `Redacted<String>` and builds a `reqwest::Client` with `timeout(180s)`, `pool_idle_timeout(90s)`, `pool_max_idle_per_host(8)`. `::with_base_url(api_key, base)` is the wiremock seam (identical pattern to `AnthropicProvider::with_base_url` and `OpenAiProvider::with_base_url`).
- **`synthesize`.** POSTs to `{base}/v1/text-to-speech/{voice_id}/stream` with body `{ text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost } }`. Defaults land when `TtsRequest.stability` / `.similarity_boost` are `None` and when `req.model` is empty (→ `eleven_multilingual_v2`). Chunked MP3 bytes are drained via `resp.bytes_stream()` into a `Vec<u8>` (initial capacity 64 KiB) and returned as `Bytes`.
- **`list_voices`.** GETs `{base}/v1/voices`, deserialises via `VoicesListResponse { voices: Vec<VoiceRaw> }`, and maps each `VoiceRaw` to `VoiceInfo` (locale from `labels.accent` via `accent_to_locale`; premium from `category == "professional"`).
- **Headers.** `xi-api-key: <key>` (from `Redacted::expose()`), `Accept: audio/mpeg` (synth) or `application/json` (list), `Content-Type: application/json`. Key never touches `reqwest`'s debug surface; Plan 03-01's `xi-[A-Za-z0-9_\-]{10,}` regex is the defence-in-depth scrub.
- **HTTP error classification** (`classify_http_error`):
  - `401` / `403` → `TtsError::AuthFailed`
  - `402` → `TtsError::QuotaExceeded`
  - `404` → `TtsError::VoiceNotFound(voice_id)`
  - `429` → `TtsError::RateLimited { retry_after_s }`, parsed from `Retry-After` header (defaults to 5s if missing/malformed — TTS is not wired through `retry::with_backoff` yet; that's Plan 11+)
  - Other non-2xx → `TtsError::Provider("{status}: {truncated}")` with body capped at 256 chars + ellipsis

**Task 1 — `CURATED_PRESETS` (`crates/intelligence/src/tts/voice_presets.rs`).** Six `VoicePreset` constants per D-11 with stable slugs (`energetic_male`, `calm_female`, `tutorial_narrator`, `news_anchor`, `friendly_mentor`, `cinematic_trailer`), each mapping to an ElevenLabs voice ID from the default catalog. A `TODO(phase-3-eval)` marker flags these for validation against the live catalog during the Plan 21 eval harness — voice IDs in ElevenLabs' catalog are stable but the planner cannot verify them offline. Three unit tests lock: `len() >= 6`, unique slugs, non-empty voice_id + display_name.

**Fixture (`tests/fixtures/elevenlabs/voices_list.json`).** Three sample voices (Rachel / Sarah / Adam — all premade, american accent) matching the ElevenLabs `/v1/voices` response shape. Used by `list_voices_parses_catalog_fixture` as the mock-server body.

**Integration tests (`tests/elevenlabs_tests.rs`).** Seven `#[tokio::test]`s + 1 compile-time check via `CURATED_PRESETS.len()`:

| Test | What it locks |
|---|---|
| `synthesize_posts_streaming_endpoint_and_returns_mp3_bytes` | URL shape + all 3 headers + request body (text, model_id, all 4 voice_settings fields) + returned bytes match mock payload byte-for-byte |
| `list_voices_parses_catalog_fixture` | `Vec<VoiceInfo>` has ≥3 entries; Rachel's locale = `"en"`, premium = false |
| `curated_presets_meets_d11_minimum` | `CURATED_PRESETS.len() >= 6` AND `<= 8` (D-11 bounds) |
| `http_429_maps_to_rate_limited_with_retry_after` | `Retry-After: 17` → `TtsError::RateLimited { retry_after_s: 17 }` |
| `http_401_maps_to_auth_failed` | 401 → `TtsError::AuthFailed` |
| `http_402_maps_to_quota_exceeded` | 402 → `TtsError::QuotaExceeded` |
| `http_404_maps_to_voice_not_found` | 404 → `TtsError::VoiceNotFound("EXAVITQu4vr4xnSDxMaL")` |

Plus 4 in-module unit tests for `accent_to_locale`, `truncate_body`, and URL formatting.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **180s client timeout** (vs. 120s LLM) — TTS streams for long paragraphs exceed the text-timeout; plan's "longer — MP3 streams run longer than text" language supports 180s exactly.
2. **Accent → locale mapping scoped to English** — ElevenLabs returns accents not languages; mapping the five common English accents to BCP-47 `"en"` is the right balance vs. stringly-typed pass-through for everything else.
3. **`premium` derived from `category == "professional"`** — The three-state `premade / cloned / professional` collapses into `premium=false / false / true` for the UI badge.
4. **Defaults backed into `synthesize`** — `stability 0.5 / similarity_boost 0.75` are filled in when `TtsRequest` fields are `None`, mirroring AI-SPEC §4 line 437–439 defaults exactly. Orchestrator callers can opt in via `Some(f32)`.
5. **`model_id` fallback** — Empty `req.model` → `eleven_multilingual_v2` so an orchestrator that forgets to populate model still produces audio.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-08): ElevenLabsProvider streaming MP3 + voice catalog + 6 curated presets` | `cd25e30` |

Single-commit landing per Phase 3's established pattern (Plans 03-04 / 03-05 both used single per-task commits). TDD cycle ran clean — tests green on first compile after impl + fixture + presets were written; no RED/GREEN iteration required.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing Critical] Added 3 extra unit tests in `voice_presets.rs` (unique slugs + non-empty voice_ids).**
- **Found during:** Task 1 test drafting.
- **Issue:** Plan requires `CURATED_PRESETS.len() >= 6` only. But slug collisions or empty voice_ids would silently break the voice picker without a test failure; the cost of three `#[test]` blocks is negligible vs. catching a copy-paste error in the const.
- **Fix:** Added `curated_preset_slugs_are_unique` and `curated_preset_voice_ids_are_nonempty` (+ the required `curated_presets_has_at_least_six`).
- **Files modified:** `crates/intelligence/src/tts/voice_presets.rs`.
- **Commit:** `cd25e30`.

**2. [Rule 2 — Missing Critical] Added HTTP/403 coverage to `AuthFailed` mapping.**
- **Found during:** Task 1 impl of `classify_http_error`.
- **Issue:** Plan specifies `401 → AuthFailed`; ElevenLabs also returns 403 for expired keys and revoked workspace tokens. Collapsing both to `AuthFailed` matches the AnthropicProvider / OpenAiProvider behaviour from Plans 03-04 / 03-05 and avoids a surprising `TtsError::Provider("403: ...")` that the UI would have to special-case.
- **Fix:** `match status.as_u16() { 401 | 403 => TtsError::AuthFailed, ... }`.
- **Files modified:** `crates/intelligence/src/tts/elevenlabs.rs`.
- **Commit:** `cd25e30`.

**3. [Rule 2 — Missing Critical] Added error-body truncation helper (`truncate_body`, cap 256 chars).**
- **Found during:** Task 1 impl of `classify_http_error`.
- **Issue:** Plan does not specify truncation for TTS errors, but Anthropic (T-03-04-06) and OpenAI (T-03-05 patterns) both truncate provider error bodies at 256 chars before embedding in `LlmError::Provider`. Consistent behaviour across all three providers prevents a future provider bug from leaking a 4 MB error page into tracing.
- **Fix:** Mirrored the Anthropic/OpenAI truncator (`.chars().take(256).collect()` + `"…"` suffix when over cap) in the TTS provider.
- **Files modified:** `crates/intelligence/src/tts/elevenlabs.rs`.
- **Commit:** `cd25e30`.

---

**Total deviations:** 3 auto-fixed (all Rule 2 — missing-critical additions for consistency with sibling providers + defensive test coverage). **Impact:** Strictly additive — no behaviour removed, no plan intent contradicted. Acceptance criteria unchanged and all still pass.

## Guardrail Evidence

**G1 (redaction) inherits from Plan 03-01.** The API key is set via `.header("xi-api-key", self.api_key.expose())` — `Redacted<String>` prevents accidental `Debug`/`Display` of the key, and the `#[instrument(skip_all, fields(voice_id = %req.voice_id, model = %req.model))]` attribute on `synthesize` ensures only the voice_id + model name land in span fields. Body (including `text`) is never logged.

Defence-in-depth: Plan 03-01's redaction layer carries an `xi-[A-Za-z0-9_\-]{10,}` regex that scrubs any future log line that accidentally includes the header value.

## Verification

```bash
cargo test -p intelligence --test elevenlabs_tests         # 7/7 passed
cargo test -p intelligence                                 # 53/53 passed
                                                           #   (33 lib + 5 anthropic + 5 openai + 7 elevenlabs + 3 redaction)
```

**Task 1 acceptance criteria:**

- All 4 required tests green (7 delivered) ✓
- `grep -c "text-to-speech" crates/intelligence/src/tts/elevenlabs.rs` → 3 (plan required ≥1) ✓
- `grep -c "xi-api-key" crates/intelligence/src/tts/elevenlabs.rs` → 3 (plan required ≥1) ✓
- `grep -cE "eleven_multilingual_v2|model_id" crates/intelligence/src/tts/elevenlabs.rs` → 3 (plan required ≥1) ✓
- `CURATED_PRESETS.len() == 6` (plan required ≥6; at D-11 floor, leaves headroom to add 2 more without a plan revision) ✓

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-08-01 (Info Disclosure — xi-api-key in headers) | mitigated | Key wrapped in `Redacted<String>`; set via `.header("xi-api-key", …expose())`; `#[instrument(skip_all, ...)]` omits headers + body from tracing spans; Plan 03-01 redaction layer's `xi-[A-Za-z0-9_\-]{10,}` regex is the defence-in-depth catch for any future log-line accident |
| T-03-08-02 (Tampering — malicious MP3 response bytes) | accepted | MP3 payload written to disk for FFmpeg concat (Plan 11); FFmpeg hardened; no `eval` / interpretation of bytes in Rust. Provider returns `Bytes` unchanged; downstream is FFmpeg's concern. Documented in plan. |
| T-03-08-03 (Spoofing — TLS) | mitigated | `reqwest` declares `default-features = false, features = ["rustls-tls", "json", "stream", "gzip"]` (Cargo.toml unchanged from Plan 03-01); no native-tls, no plaintext fallback |
| T-03-08-04 (DoS — unbounded stream) | mitigated | `Client::builder().timeout(Duration::from_secs(180))` caps total HTTP lifetime; `text` payload length is bounded at the caller (orchestrator) by the per-utterance character cap |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. `ElevenLabsProvider` is fully functional. The `TODO(phase-3-eval)` comment in `voice_presets.rs` flags voice-ID validation as a Plan 21 eval-harness task — the IDs used are taken from the ElevenLabs public documentation's default catalog (Rachel, Sarah, Adam, Clyde, Antoni, Arnold) but the planner could not confirm them against a live API key.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register.

## Issues Encountered

None. TDD cycle ran clean — tests green on first compile of the impl. One near-miss: the initial `#[instrument]` attribute omitted `skip_all`, which would have logged the request struct (including text) into span fields. Caught during self-review before first test run.

## Authentication Gates

None — all wiremock tests use hard-coded `"test-elev-key"` / `"k"` canaries matched against mock server `header(...)` matchers. Real ElevenLabs API calls are deferred to the Wave 3 orchestrator bring-up (Plan 11+) and the eval harness (Plan 21).

## User Setup Required

None — pure-Rust implementation with no external-service dependencies at build/test time. Real API key storage is wired via Plan 03-03's `key_set(...)` secrets storage; the desktop UI needs a `ProviderId::ElevenLabs` variant added in a future plan when the voice picker surfaces the "paste API key" flow (tracked separately — not in this plan's scope).

## Next Plan Readiness

- **Wave 3 TTS orchestrator / cache layer (Plan 11):** can now instantiate `ElevenLabsProvider::new(redacted_key.into_inner())`, build a `TtsRequest { model: "eleven_multilingual_v2", voice_id: preset.voice_id, text, stability: None, similarity_boost: None }`, and call `provider.synthesize(req).await?` to get a `Bytes` buffer ready for SHA-256 hashing + disk write.
- **Voice picker UI (Plan 19):** two surfaces — `CURATED_PRESETS` for the curated row (fixed 6 entries), `provider.list_voices().await?` for the "All voices" pane (≥100 entries from the default catalog).
- **Retry wrapping:** TTS is NOT wired through `retry::with_backoff` yet. The `TtsError::RateLimited` variant is shaped identically to `LlmError::RateLimited` so a future `tts::retry::with_backoff` (or a generic `retry::with_backoff_err<E: HasRateLimit>`) can wrap synth calls transparently.
- No blockers. Cargo.toml is stable; no new dep additions for the ElevenLabs path (all deps already pulled in by Plan 03-01's reqwest/wiremock/futures-util/tokio surface).

## Handoff Notes

- `ElevenLabsProvider` does not currently auto-retry on 429. The orchestrator should check `TtsError::RateLimited` and decide whether to queue/back-off — future Plan can wrap this through a generic retry helper once a second TTS provider (OpenAI TTS, Plan 09?) lands.
- `list_voices()` returns the FULL catalog (~100+ voices). The UI should paginate or virtualise; no server-side filter is wired (ElevenLabs' `/v1/voices` takes no query params for filtering in the default tier).
- `accent_to_locale` is conservative — it only maps English accents. If the voice picker needs Spanish/French/German locales, extend the function to map `spanish → es`, `french → fr`, `german → de`. Non-mapped accents currently pass through as the raw accent string, which is displayable but not BCP-47-valid.
- The `premium` flag is a UI hint only; ElevenLabs bills per-character regardless of `category`. The orchestrator should not use `premium` for billing decisions.
- `CURATED_PRESETS` voice IDs are from the public ElevenLabs documentation. Before shipping a release, the Plan 21 eval harness should call `list_voices()` with a real API key and diff against `CURATED_PRESETS` to confirm all 6 IDs are still active. If any voice is deprecated, update the const — the compile-time tests will still pass but the runtime will produce a 404 `VoiceNotFound`.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/tts/elevenlabs.rs` → FOUND (updated from placeholder)
- `crates/intelligence/src/tts/voice_presets.rs` → FOUND
- `crates/intelligence/src/tts/mod.rs` → FOUND (with `pub mod voice_presets;`)
- `crates/intelligence/tests/elevenlabs_tests.rs` → FOUND
- `crates/intelligence/tests/fixtures/elevenlabs/voices_list.json` → FOUND

Commit:
- `cd25e30` (feat 03-08 ElevenLabsProvider) → FOUND via `git log --oneline`

Verification:
- `cargo test -p intelligence --test elevenlabs_tests` → 7/7 passed
- `cargo test -p intelligence` → 53/53 passed (33 lib + 5 anthropic + 5 openai + 7 elevenlabs + 3 redaction)
- `grep -c "text-to-speech" crates/intelligence/src/tts/elevenlabs.rs` → 3 ✓
- `grep -c "xi-api-key" crates/intelligence/src/tts/elevenlabs.rs` → 3 ✓
- `grep -cE "eleven_multilingual_v2|model_id" crates/intelligence/src/tts/elevenlabs.rs` → 3 ✓

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-15*
