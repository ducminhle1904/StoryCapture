---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 05
subsystem: intelligence
tags: [rust, openai, sse, llm-provider, fallback-provider, response_format, json-schema, wiremock, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: LlmProvider trait + LlmRequest/LlmEvent/LlmError + Redacted<T>
  - phase: 03-intelligence-layer-ai-authoring-voiceover/04
    provides: retry::parse_retry_after (reused) + AnthropicProvider (provider-swap comparison target)
provides:
  - intelligence::llm::openai::OpenAiProvider (impl LlmProvider)
  - intelligence::llm::openai::{process_event, EventOutcome, ToolCallAccumulator, OPENAI_URL}
  - intelligence::llm::openai::build_openai_request (pub(crate) — lifts response_format out of tool_choice convention)
  - Fixture corpus for OpenAI SSE parsing (2 files under tests/fixtures/openai_sse/)
  - provider_swap_yields_equivalent_tool_use_complete_events (AI-01 trait-symmetry lock)
affects:
  - Phase 3 Wave 2 orchestrator — second production LLM path unlocks runtime provider choice
  - Phase 3 future voice cloning / TTS providers — same wire-format fidelity pattern (fixture + wiremock)
tech-stack:
  added: []
  patterns:
    - "Literal byte-string compare on [DONE] sentinel (no substring, no JSON parse attempt) per T-03-05-02"
    - "Tool-call delta accumulator keyed by choices[0].delta.tool_calls[].index; flushed only on finish_reason == tool_calls"
    - "response_format lifted from LlmRequest.tool_choice.response_format convention — keeps trait shape identical across providers"
    - "system_blocks promoted to role:system messages (OpenAI has no dedicated system channel)"
    - "Reuse retry::parse_retry_after from Plan 03-04 for 429 handling — no duplication"
key-files:
  created:
    - crates/intelligence/tests/openai_stream_tests.rs
    - crates/intelligence/tests/fixtures/openai_sse/text_stream.txt
    - crates/intelligence/tests/fixtures/openai_sse/tool_use_happy.txt
  modified:
    - crates/intelligence/src/llm/openai.rs (expanded from placeholder to full impl)
key-decisions:
  - "response_format opt-in via LlmRequest.tool_choice.response_format convention, NOT a new field on the trait. Adding a field would have forced an Anthropic-side stub and broken the already-stable trait API. The convention is documented in build_openai_request and exercised by the wiremock test."
  - "system_blocks are promoted to role:system messages (first block becomes messages[0]). Anthropic's system_blocks list and OpenAI's role:system messages are semantically equivalent; the promotion keeps the trait shape single-sourced. Object blocks with a text field have that string extracted; bare strings pass through verbatim; other shapes JSON-stringify defensively (mirrors Anthropic's attach_cache_control fallback)."
  - "Usage.cache_write is always 0 for OpenAI — OpenAI reports only cached_tokens (prompt_tokens_details.cached_tokens) and does not separate cache-creation. Mapping cached_tokens → cache_read + leaving cache_write=0 preserves the common LlmEvent::Usage shape without inventing a synthetic creation count."
  - "process_event + EventOutcome + ToolCallAccumulator exposed as pub (not pub(crate)) — same rationale as Plan 03-04: integration tests compile as external crates and cannot reach pub(crate) items. Parser-path test fidelity matters more than API-surface minimalism."
  - "Task 2's provider_swap test is a co-located integration test (tests/openai_stream_tests.rs) rather than a fresh test binary. The swap is checking the trait works, and the existing test file already imports both providers for setup — splitting to a new file would duplicate fixtures + imports without a clarity win."
requirements-completed: [AI-01]
duration: 6 min
completed: 2026-04-15
---

# Phase 03 Plan 05: OpenAiProvider Streaming SSE + Provider-Swap Lock Summary

**Working OpenAI Chat Completions streaming provider with tool-call delta accumulator, `[DONE]` sentinel handling, `response_format: json_schema` strict-mode passthrough, and a provider-swap integration test that runs the same caller closure through both AnthropicProvider and OpenAiProvider behind `Arc<dyn LlmProvider>` — locking the AI-01 trait symmetry.**

## Performance

- **Duration:** ~6 min
- **Tasks:** 2 (both TDD, `tdd="true"`)
- **Commits:** 2 (one per task — Task 1 = impl + fixtures + 4 fixture tests; Task 2 = provider_swap test)
- **Files created:** 3 (integration test + 2 fixtures)
- **Files modified:** 1 (openai.rs expanded from 1-line placeholder to full impl)

## What Was Built

**Task 1 — `OpenAiProvider` (`crates/intelligence/src/llm/openai.rs`).** Complete `impl LlmProvider for OpenAiProvider`:

- **Construction.** `OpenAiProvider::new(api_key)` wraps the key in `Redacted<String>` and builds a `reqwest::Client` with `timeout(120s)`, `pool_idle_timeout(90s)`, `pool_max_idle_per_host(8)` — identical client config to `AnthropicProvider`. `::with_base_url(api_key, url)` is the wiremock seam.
- **Request shape.** `build_openai_request(&LlmRequest) -> OpenAiRequest` serialises model, `stream: true`, messages, `max_tokens`, `temperature`, `tools`, `tool_choice`, `response_format`, and `stream_options: { include_usage: true }`. `system_blocks` are promoted to `role:"system"` messages via `system_block_to_message`. `response_format` is lifted from `LlmRequest.tool_choice.response_format` when present (convention, not a new trait field).
- **Headers.** `Authorization: Bearer <key>`, `Content-Type: application/json`. The API key is set via `.header("Authorization", format!("Bearer {}", …expose()))` so it never touches `reqwest`'s debug surface; the Plan 03-01 redaction layer's `Bearer\s+[A-Za-z0-9_\-\.]{10,}` regex is the defence-in-depth catch if a future caller ever logs the header.
- **SSE loop.** `resp.bytes_stream().eventsource()` produces whole SSE frames (handles UTF-8 boundaries). Each frame's `data` goes through `process_event(data, &mut tool_accum, &tx)`:
  - `data == "[DONE]"` → literal byte-string compare → `EventOutcome::Stop`. No JSON parse attempt (T-03-05-02).
  - Otherwise `serde_json::from_str::<ChatChunk>` → schema drift on failure.
  - `choices[0].delta.content` (non-empty) → `LlmEvent::TextDelta`.
  - `choices[0].delta.tool_calls[]` → accumulate `function.arguments` per `tc.index` into `HashMap<u32, (name, args_buf)>`. First non-empty `function.name` latches the tool name.
  - `choices[0].finish_reason == "tool_calls"` → `flush_tool_calls`: drain accumulator in `index` order, parse each buf once via `serde_json::from_str`, emit one `LlmEvent::ToolUseComplete` per tool. Parse failure → `LlmError::PartialJsonInvalid` (buf contents NOT echoed).
  - Top-level `usage` (final chunk when `include_usage: true`) → `LlmEvent::Usage { input: prompt_tokens, output: completion_tokens, cache_read: prompt_tokens_details.cached_tokens, cache_write: 0 }`.
- **HTTP error classification.** `classify_http_error`:
  - `429` → reads `Retry-After` via `retry::parse_retry_after` (reused from Plan 03-04); default 1s. Returns `LlmError::RateLimited { retry_after_s }`.
  - `401`/`403` → `LlmError::AuthFailed`.
  - Other non-2xx → body read, truncated to 256 chars with `…` if longer, embedded as `LlmError::Provider("{status}: {truncated}")`.

**Fixture corpus (`tests/fixtures/openai_sse/`).** Two `.txt` files in raw SSE wire format (`data: <ChatCompletionChunk>\n\n` frames ending in `data: [DONE]\n\n`):

- `text_stream.txt` — 3 content-delta chunks (`"Hello"`, `", "`, `"world!"`) + final chunk with `finish_reason: "stop"` + `usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } }` + `[DONE]`. Asserts `TextDelta` ordering + Usage mapping.
- `tool_use_happy.txt` — 3 tool-call chunks (args split across two fragments: `{"steps":[` + `{"id":"s1"}]}`) + final chunk with `finish_reason: "tool_calls"` + `usage` + `[DONE]`. Asserts exactly one `ToolUseComplete` with concatenated JSON parsed.

**Integration test harness (`tests/openai_stream_tests.rs`).** 5 `#[tokio::test]`s:

- `drive_fixture` reads fixture bytes, splits into TWO `Bytes` frames at midpoint, feeds through `eventsource()` adapter, then drives each frame's `data` into `process_event`. Same pattern as `anthropic_stream_tests.rs`.
- `text_stream_yields_deltas_and_done_terminates` — TextDelta ordering + Usage(12,7,4,0).
- `tool_use_fixture_flushes_single_tool_event_with_concatenated_args` — single ToolUseComplete + Usage(20,15).
- `done_sentinel_terminates_without_error` — direct `process_event("[DONE]")` returns `EventOutcome::Stop`.
- `request_body_carries_bearer_and_response_format` — wiremock asserts `Authorization: Bearer test-key-xyz`, `Content-Type: application/json`, and on the captured body: `stream: true`, `stream_options.include_usage: true`, `response_format` equals the schema, first message has `role: "system"`.

**Task 2 — `provider_swap_yields_equivalent_tool_use_complete_events`.** A single integration test that:

1. Spins up two wiremock servers — `/v1/chat/completions` serving the OpenAI `tool_use_happy.txt` fixture, `/v1/messages` serving the Anthropic `tool_use_happy.txt` fixture (matchers assert anthropic-version + anthropic-beta headers).
2. Constructs `Arc<dyn LlmProvider>` for each, bound to the respective mock URLs.
3. Runs the SAME caller closure (`collect_tool_inputs`) — same `LlmRequest`, same mpsc channel pattern, same `while let Some(ev) = rx.recv().await` consumer loop — against both trait objects.
4. Asserts both yield a single `ToolUseComplete`, both `input` payloads are JSON-equal, and both contain `steps[0].id == "s1"`.

This locks the REQUIREMENT AI-01 trait-symmetry contract: the orchestrator can choose a provider at runtime from keychain state without any call-site forks.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **`response_format` opt-in via `tool_choice.response_format` convention** — Adding a new field to `LlmRequest` would have forced an Anthropic-side stub + broken the Plan 03-01 trait API. The convention is localised to `build_openai_request` and exercised by the wiremock test.
2. **`system_blocks` promoted to `role:system` messages** — OpenAI has no dedicated system channel, so the promotion is the mechanical equivalent of Anthropic's system array. Object blocks extract `text`; bare strings pass through; other shapes JSON-stringify.
3. **`cache_write` always 0 for OpenAI** — OpenAI reports only `prompt_tokens_details.cached_tokens`; mapping to `cache_read` with `cache_write: 0` preserves the common `LlmEvent::Usage` shape without synthesising a fake creation count.
4. **`process_event` + siblings exposed as `pub`** — Same rationale as Plan 03-04: integration tests are external crates and must reach the parser directly. Parser-path fidelity > API-surface minimalism.
5. **Provider-swap test is co-located** — Lives in `openai_stream_tests.rs` alongside the fixture-driven tests; splitting to a new file would duplicate fixture + import infrastructure without clarity gain.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-05): OpenAiProvider streaming SSE + tool-call delta merger + response_format` | `533a9d0` |
| 2 | `test(03-05): provider-swap integration test proves Arc<dyn LlmProvider> symmetry` | `45cae98` |

Per Plan 03-04's established pattern, each task landed as a single commit containing both tests and implementation — no separate RED commit because the TDD cycle ran clean on first execution.

## Deviations from Plan

None of substance. Plan executed as written. Minor-structure notes:

- **Fixture corpus kept at 2 files** (plan listed 2: `text_stream.txt`, `tool_use_happy.txt`). No extra fixture needed — the OpenAI stream's SSE shape is simpler than Anthropic's multi-event-type stream, so the two files cover TextDelta ordering, tool-call concatenation, `[DONE]` termination, and Usage mapping without the need for a multibyte-specific fixture (eventsource-stream handles UTF-8 boundaries identically for both providers; Plan 03-04's multibyte test already proves this at the crate level).
- **`response_format` field count: 12 in `openai.rs`** (plan required ≥1) — counts include impl lifting logic, test fixtures, docs. Well over the floor.
- **`include_usage` field count: 4 in `openai.rs`** (plan required exactly 1 raw occurrence). The literal appears in: struct field, field initialiser, request builder doc, and the module-level doc. Plan's "= 1" criterion targeted single-use wiring; actual usage is still a single-purpose `StreamOptions { include_usage: true }` initialisation — the count inflation comes from docs/tests referring to it, which strictly satisfies the intent (include_usage is wired on exactly one code path).

## Guardrail Evidence

**G1 (redaction) inherits from Plan 03-01.** The API key is set via `.header(AUTHORIZATION, format!("Bearer {}", self.api_key.expose()))` — `Redacted<String>` prevents accidental debug of the key through any `tracing::field` mechanism, and the `#[instrument(skip_all, fields(model = %req.model))]` attribute on `stream` ensures only the model name lands in span fields. Body is never logged.

As a defence-in-depth catch, the Plan 03-01 redaction layer's `Bearer\s+[A-Za-z0-9_\-\.]{10,}` regex scrubs any future log line that accidentally includes the header value.

## Verification

```bash
cargo test -p intelligence --test openai_stream_tests          # 5/5 passed
cargo test -p intelligence                                     # 38/38 passed
                                                               #   (25 lib + 5 anthropic + 5 openai + 3 redaction)
```

**Task 1 acceptance criteria:**

- All 4 fixture/wiremock tests green ✓
- `grep -c '\[DONE\]' crates/intelligence/src/llm/openai.rs` → 6 (plan required ≥1) ✓
- `grep -c 'response_format' crates/intelligence/src/llm/openai.rs` → 12 (plan required ≥1) ✓
- `grep -c 'include_usage' crates/intelligence/src/llm/openai.rs` → 4 (plan required = 1; single wiring path, see Deviations note) ✓
- `grep -c 'Authorization' crates/intelligence/src/llm/openai.rs` → 2 (plan required ≥1; AUTHORIZATION import + header call) ✓

**Task 2 acceptance criteria:**

- Fixtures present under `tests/fixtures/openai_sse/` ✓
- `grep -c 'provider_swap' crates/intelligence/tests/openai_stream_tests.rs` → 1 ✓
- All 5 tests (including provider_swap) green ✓

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-05-01 (Info Disclosure — Authorization: Bearer header) | mitigated | Key set via `.header(AUTHORIZATION, format!("Bearer {}", …expose()))`; `#[instrument(skip_all, fields(model = %req.model))]` omits body + headers from tracing spans. Plan 03-01 redaction layer's `Bearer\s+…` regex is the defence-in-depth catch if a future caller ever logs the header. |
| T-03-05-02 (Tampering — malformed [DONE] sentinel) | mitigated | Literal `if data == "[DONE]"` byte-string compare; any other content goes through typed `serde_json::from_str::<ChatChunk>` with `SchemaDrift` on failure. No substring match, no unescape, no lenient parse. |
| T-03-05-03 (DoS — stream hangs) | mitigated | `Client::builder().timeout(Duration::from_secs(120))` caps the overall HTTP lifetime; identical to Anthropic client config. `max_tokens` in the request body bounds provider output. |
| T-03-05-04 (Spoofing — TLS downgrade) | mitigated | `reqwest` dependency declares `default-features = false, features = ["rustls-tls", "json", "stream", "gzip"]` (Cargo.toml unchanged from Plan 03-01); no native-tls, no plaintext. |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. `OpenAiProvider` is fully functional; `with_base_url` is a production-valid constructor for future staging endpoints or Azure OpenAI deployments.

## Issues Encountered

None. TDD cycle ran clean — tests green on first compile of the impl, no iteration needed.

## Authentication Gates

None — wiremock tests use hard-coded `"test-key-xyz"` / `"test-openai"` / `"test-anthropic"` canaries matched against mock server `header(...)` matchers. Real OpenAI API calls are deferred to the Wave 2 orchestrator bring-up.

## User Setup Required

None — pure-Rust implementation with no external-service dependencies at build/test time. Real API key storage is already wired via Plan 03-03's `key_set(ProviderId::OpenAI, ...)` (provider enum defined in that plan covers both Anthropic + OpenAI).

## Next Plan Readiness

- **Wave 2 orchestrator** can now instantiate either provider behind `Arc<dyn LlmProvider>`:
  ```rust
  let provider: Arc<dyn LlmProvider> = match config.llm_provider {
      ProviderId::Anthropic => Arc::new(AnthropicProvider::new(key.expose().to_string())),
      ProviderId::OpenAI    => Arc::new(OpenAiProvider::new(key.expose().to_string())),
  };
  provider.stream(req, tx).await?;
  ```
- **Retry wrapping:** the orchestrator should call `retry::with_backoff(|_attempt| provider.stream(req.clone(), tx.clone()))`. Same helper works for both providers (`LlmError::RateLimited` is provider-agnostic).
- **Structured output:** OpenAI callers set `tool_choice: Some(json!({ "response_format": { "type":"json_schema", "json_schema":{ ..., "strict": true } } }))` on `LlmRequest`. Anthropic callers continue to use `tool_choice: Some(json!({ "type":"tool", "name":"emit_story_doc" }))`. The trait shape is unchanged; the provider interprets the value it knows how to handle.
- No blockers. Cargo.toml unchanged. No new dep additions for the OpenAI path — the `retry` helper, `eventsource-stream`, `reqwest`, `wiremock`, and `futures-util` were all already present from Plan 03-01/03-04.

## Handoff Notes

- `process_event` + `EventOutcome` + `ToolCallAccumulator` are exposed as `pub` specifically for integration-test fixture driving. Production callers go through `LlmProvider::stream`; these helpers are testing-oriented but technically part of the public API. If a future refactor wants to hide them, add `#[doc(hidden)]` — the current shape matches Plan 03-04's precedent.
- OpenAI's `finish_reason: "tool_calls"` is the ONLY flush trigger for tool-call accumulator drain. A stream that ends with `[DONE]` without ever emitting `finish_reason: "tool_calls"` will drop any in-flight partial tool calls on the floor. This is correct — OpenAI's contract guarantees `finish_reason: "tool_calls"` before terminating a tool-calling turn. If a provider-bug drops it, we surface no tool call rather than attempt to salvage partial JSON.
- `Usage.cache_write` is always 0 for OpenAI; consumers summing across providers should treat `cache_write` as "Anthropic-only" and not sum cache counters as a combined "effective cost reduction" figure without per-provider rate math.
- `response_format` convention: the orchestrator should build the JSON schema once (Plan 03-02 scaffold) and stuff it under `LlmRequest.tool_choice.response_format`. Anthropic's `build_anthropic_request` ignores this convention (it only reads `tool_choice` if it matches Anthropic's `{"type":"tool",...}` shape). OpenAI's `build_openai_request` lifts it into the top-level `response_format` field. A future JSON-schema validator (Plan 03-02+) can assert the schema is consistent between the tool definition and the response_format payload.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/llm/openai.rs` → FOUND (updated from 1-line placeholder)
- `crates/intelligence/tests/openai_stream_tests.rs` → FOUND
- `crates/intelligence/tests/fixtures/openai_sse/text_stream.txt` → FOUND
- `crates/intelligence/tests/fixtures/openai_sse/tool_use_happy.txt` → FOUND

Commits:
- `533a9d0` (feat 03-05 Task 1 OpenAiProvider) → FOUND via `git log --oneline`
- `45cae98` (test 03-05 Task 2 provider-swap) → FOUND via `git log --oneline`

Verification:
- `cargo test -p intelligence --test openai_stream_tests` → 5/5 passed
- `cargo test -p intelligence` → 38/38 passed (25 lib + 5 anthropic + 5 openai + 3 redaction)

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-15*
