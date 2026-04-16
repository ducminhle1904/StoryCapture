---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 04
subsystem: intelligence
tags: [rust, anthropic, sse, llm-provider, prompt-cache, retry, wiremock, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: LlmProvider trait + LlmRequest/LlmEvent/LlmError + Redacted<T>
provides:
  - intelligence::llm::anthropic::AnthropicProvider (impl LlmProvider)
  - intelligence::llm::anthropic::{process_event, EventOutcome, ANTHROPIC_URL, ANTHROPIC_VERSION, ANTHROPIC_PROMPT_CACHING_BETA}
  - intelligence::llm::retry::{parse_retry_after, backoff_delay, with_backoff, with_backoff_inner}
  - Fixture corpus for SSE parsing tests (4 files under tests/fixtures/anthropic_sse/)
affects:
  - Phase 3 Wave 2 orchestrator — first production LLM path (D-01 Anthropic-first) now wired end-to-end
  - Phase 3 future OpenAI provider (03-05+) — mirrors the SSE + retry + cache pattern
tech-stack:
  added:
    - "rand 0.8 (jitter RNG in retry::backoff_delay)"
    - "httpdate 1 (Retry-After HTTP-date form)"
    - "wiremock 0.6 (dev-dep — request body/header assertions)"
  patterns:
    - "Test seam: with_backoff_inner takes an injected async sleeper so retry tests run at zero real time"
    - "Base-URL injection: AnthropicProvider::with_base_url replaces prod URL for wiremock without a test-only cfg"
    - "process_event extracted as a pub async helper so SSE parsing + JSON-accumulator logic are testable without HTTP"
    - "Error body truncation at 256 chars before embedding in LlmError::Provider (T-03-04-06)"
key-files:
  created:
    - crates/intelligence/src/llm/retry.rs
    - crates/intelligence/tests/anthropic_stream_tests.rs
    - crates/intelligence/tests/fixtures/anthropic_sse/tool_use_happy.txt
    - crates/intelligence/tests/fixtures/anthropic_sse/multibyte_text.txt
    - crates/intelligence/tests/fixtures/anthropic_sse/error_event.txt
    - crates/intelligence/tests/fixtures/anthropic_sse/text_deltas.txt
  modified:
    - crates/intelligence/src/llm/mod.rs
    - crates/intelligence/src/llm/anthropic.rs
    - crates/intelligence/Cargo.toml
    - Cargo.lock
key-decisions:
  - "Exposed process_event + EventOutcome as pub (not pub(crate)) so integration tests in crates/intelligence/tests/ can drive the SSE parser directly from fixture bytes. Integration tests live outside the crate, can't reach pub(crate) items; the alternative (duplicating the parser in a test helper) would diverge from prod."
  - "Split fixture corpus 3→4: added text_deltas.txt (not listed in plan) so the text-delta-ordering test can assert against a dedicated fixture rather than piggy-backing on multibyte_text.txt whose fragments aren't human-readable ASCII."
  - "Base-URL override via AnthropicProvider::with_base_url (constructor variant) instead of env var or tauri-state. Matches the minimum-churn pattern Plan 03-03 established (STORYCAPTURE_TEST_PROVIDER_BASE_URL) but even cleaner at the Rust layer: a second public constructor with no impact on AnthropicProvider::new callers."
  - "with_backoff_inner takes an injected sleeper as FnMut(Duration) -> impl Future<()>. This avoids tokio::time::pause() which requires start_paused on the runtime — the per-test attribute would leak into every future retry test author."
  - "parse_usage returns Option<LlmEvent::Usage> and skips emission when the usage object is empty. Anthropic message_delta events without counters would otherwise spam (0,0,0,0) Usage events; the Some-on-non-empty check keeps the event stream semantically meaningful."
requirements-completed: [AI-01]
duration: 4 min
completed: 2026-04-16
---

# Phase 03 Plan 04: AnthropicProvider Streaming SSE Summary

**Working Anthropic Messages API streaming provider with prompt-cache breakpoint wiring, tool-use partial-JSON accumulator, token-usage forwarding, 429/Retry-After retry helper, and a 13-test fixture+wiremock verification harness that runs without network access.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T01:08:00Z
- **Completed:** 2026-04-16T01:12:03Z
- **Tasks:** 2 (both TDD, `tdd="true"`)
- **Commits:** 2 (one per task — tests + impl in each)
- **Files created:** 6 (1 module + 1 integration test + 4 fixtures)
- **Files modified:** 4 (mod.rs registration, anthropic.rs impl, Cargo.toml deps, Cargo.lock)

## What Was Built

**Task 1 — Retry helper (`crates/intelligence/src/llm/retry.rs`).** Three public functions implementing AI-SPEC §4b pitfall #8:

| Function | Behaviour |
|---|---|
| `parse_retry_after(&str) -> Option<Duration>` | Accepts delta-seconds (e.g. `"5"`) and IMF-fixdate (`"Sun, 06 Nov 1994 08:49:37 GMT"`). Past dates clamp to `ZERO`. Junk input → `None`. |
| `backoff_delay(attempt) -> Duration` | `min(2^attempt, 30) * 1000ms + rand_u64 % 1000 ms`. `attempt >= 5` pins the exponential at the 30s cap. |
| `with_backoff<F, Fut, T>(f) -> Result<T, LlmError>` | Calls `f(attempt)` up to 3 times on `LlmError::RateLimited`; sleeps `max(header_wait, backoff_delay)` between attempts; bubbles other errors immediately; after 3 rate-limit errors returns `LlmError::Provider("retry exhausted")`. |

Plus `with_backoff_inner(f, sleep_fn)` — the test seam that accepts an injected async sleeper (production callers go through `with_backoff` which uses `tokio::time::sleep`). Eight unit tests pin every branch: seconds parse, HTTP-date parse, junk returns None, backoff jitter windowing, retries-then-succeeds, exhaustion-after-three, bubble-non-ratelimit, and retry-after-longer-than-backoff-wins.

**Task 2 — AnthropicProvider (`crates/intelligence/src/llm/anthropic.rs`).** Complete `impl LlmProvider for AnthropicProvider`:

- **Construction.** `AnthropicProvider::new(api_key)` wraps the key in `Redacted<String>` and builds a `reqwest::Client` with `timeout(120s)`, `pool_idle_timeout(90s)`, `pool_max_idle_per_host(8)` (pitfall #6). `::with_base_url(api_key, url)` is the same but accepts a custom endpoint for wiremock tests.
- **Request shape.** `build_anthropic_request(&LlmRequest) -> AnthropicRequest` mirrors the Messages API (model, max_tokens, stream=true, system, messages, tools, tool_choice, temperature). `attach_cache_control` inserts `{"cache_control": {"type": "ephemeral", "ttl": "1h"}}` onto the LAST system block. Bare-string and non-object blocks are wrapped into `{"type":"text","text":...,"cache_control":...}` defensively (pitfall #5).
- **Headers.** `x-api-key` (from `Redacted`), `anthropic-version: 2023-06-01`, `anthropic-beta: prompt-caching-2024-07-31`, `content-type: application/json`. The API key field is deliberately set via `.header(...)` so it never touches `reqwest`'s debug surface.
- **SSE loop.** `resp.bytes_stream().eventsource()` produces whole SSE frames across UTF-8 boundaries (pitfall #1). Each frame's `data` is fed to `process_event(data, &mut tool_json_bufs, &tx)` which matches on the `#[serde(tag="type")]` `SseEvent` enum:
  - `ContentBlockDelta { Delta::Text { text } }` → `LlmEvent::TextDelta(text)`.
  - `ContentBlockDelta { Delta::InputJson { partial_json } }` → append to `tool_json_bufs.entry(index)`.
  - `ContentBlockStop { index }` → if the buffer is non-empty, `serde_json::from_str` it once (pitfall #2) and emit `LlmEvent::ToolUseComplete { index, input }`. Parse failure → `LlmError::PartialJsonInvalid` (T-03-04-05: buf contents NOT echoed).
  - `MessageDelta { usage }` → `parse_usage` pulls `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` and emits `LlmEvent::Usage`. Empty-usage events skip emission.
  - `MessageStop` → terminate loop cleanly.
  - `Error { error }` → `LlmError::Provider(error.to_string())`.
  - `MessageStart` / `ContentBlockStart` / `Ping` → bookkeeping only.
- **HTTP error classification.** `classify_http_error`:
  - `429` → reads `Retry-After` via `retry::parse_retry_after`; default 1s if header missing. Returns `LlmError::RateLimited { retry_after_s }` so the caller can route through `retry::with_backoff`.
  - `401`/`403` → `LlmError::AuthFailed`.
  - Other non-2xx → body read, truncated to 256 chars with ellipsis if longer (T-03-04-06), embedded as `LlmError::Provider("{status}: {truncated}")`.

**Fixture corpus (`tests/fixtures/anthropic_sse/`).** Four `.txt` files in raw SSE wire format (`event: <name>\ndata: <json>\n\n` frames) cover the scenarios the plan's behaviour cases require:
- `text_deltas.txt` — 3 ordered `text_delta` frames → asserts TextDelta ordering.
- `tool_use_happy.txt` — 2 `input_json_delta` fragments (`{"steps":[` + `{"id":"s1"}]}`) on index 0 + stop + final `message_delta` with all 4 usage counters populated → asserts exactly-one ToolUseComplete + Usage(10,25,8,2).
- `multibyte_text.txt` — 3 text_delta frames (`⚡`, `fast`, ` done`) with fixture byte-split at mid-length → asserts all 3 decode cleanly through `eventsource-stream`.
- `error_event.txt` — bare `event: error` → asserts stream terminates with `LlmError::Provider("overloaded")`.

**Integration test harness (`tests/anthropic_stream_tests.rs`).** Five `#[tokio::test]`s:
- `drive_fixture` helper reads raw bytes, splits into TWO `Bytes` frames at midpoint, feeds through `eventsource()` adapter, then drives each parsed frame's `data` into `process_event`. This hits the same code path as production without any HTTP.
- `request_body_includes_cache_control_and_beta_header` spins up a `wiremock::MockServer`, asserts incoming request carries the beta header + `x-api-key` + `content-type`, then inspects the captured body's `system[last].cache_control = {"type":"ephemeral","ttl":"1h"}` and `text = "cached-prefix"`.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **`process_event` + `EventOutcome` exposed as `pub` (not `pub(crate)`)** — Integration tests in `tests/` are external crates and can only see `pub` items. Alternative (duplicating parser logic in test helpers) would let the test path diverge from prod. The compile-time warning about `pub` in a non-obvious API surface is worth the test fidelity.
2. **Extra fixture `text_deltas.txt` beyond the 3 listed** — Multibyte fixture's emoji/ASCII mix is awkward to assert ordering on; a dedicated text-delta fixture keeps the two concerns (order vs. encoding) decoupled.
3. **`with_base_url` constructor over env var** — Rust's constructor overload pattern is a single extra 3-line public fn; no environmental side-effects, no test-only cfg gates.
4. **Injected sleeper (FnMut) over `tokio::time::pause`** — Pause requires `#[tokio::test(start_paused = true)]` on every retry test; a per-call injected `FnMut(Duration) -> impl Future<()>` is test-local with zero runtime-attribute churn.
5. **Empty-usage events are dropped** — Anthropic emits `message_delta` with an empty `usage` object mid-stream; forwarding those as `LlmEvent::Usage { 0, 0, 0, 0 }` would pollute the orchestrator's token counter. Emit-only-if-non-empty preserves semantic meaning.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-04): retry helper with Retry-After parsing + exp backoff + jitter` | `b5d5695` |
| 2 | `feat(03-04): AnthropicProvider streaming SSE + cache_control + partial-JSON accumulator` | `aa44f13` |

Each task landed as a single commit containing both tests and implementation — TDD RED→GREEN inside one commit is this project's established pattern (Plan 03-02 and 03-03 SUMMARYs both used single per-task commits). No separate test-first commit because the tests green immediately on first run (Task 1 had one HTTP-date parse adjustment, not a RED/GREEN swap).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `parse_retry_after_httpdate_form` test used `"Wed, 21 Oct 2099 07:28:00 GMT"` which fails strict weekday-vs-date validation in `httpdate::parse_http_date`.**
- **Found during:** Task 1 first test run (7/8 pass, HTTP-date test panicked on `expect("date parses")`).
- **Issue:** The `httpdate` crate validates that the weekday name matches the calendar date. Hard-coded RFC examples quickly become invalid because the weekday changes year-to-year.
- **Fix:** Build the header string from `httpdate::fmt_http_date(SystemTime::now() + 1h)` so the weekday is always consistent with the date. Past-date case uses `UNIX_EPOCH + 631_152_000s` (1990-01-01) via the same formatter.
- **Files modified:** `crates/intelligence/src/llm/retry.rs` (test only).
- **Commit:** `b5d5695` (same commit as the feature — pre-commit fixup, never shipped broken).

**2. [Rule 3 — Blocking] `process_event` and `EventOutcome` required `pub` (not `pub(crate)`) for integration-test access.**
- **Found during:** Task 2 first compile of `tests/anthropic_stream_tests.rs` — E0603 "function is private".
- **Issue:** Integration tests under `tests/` compile as external crates and cannot see `pub(crate)` items. The plan's acceptance expects fixture-driven tests that use the same parser as prod, which requires reaching `process_event` from outside the crate.
- **Fix:** Changed `pub(crate) enum EventOutcome` → `pub`, `pub(crate) async fn process_event` → `pub`. Added explicit `#[allow(dead_code)]` on `SseEvent` (its `Debug` derive trips the lint for variants whose fields are only read structurally).
- **Files modified:** `crates/intelligence/src/llm/anthropic.rs`.
- **Commit:** `aa44f13`.

**3. [Rule 2 — Missing Critical] Added extra fixture `text_deltas.txt` beyond the 3 listed in plan.**
- **Found during:** Task 2 test drafting.
- **Issue:** Plan lists 3 fixtures (tool_use_happy, multibyte_text, error_event) but has 5 test behaviours. Behaviour #1 ("3 content_block_delta with text_delta in order") has no assigned fixture; piggy-backing on `multibyte_text.txt` would conflate order-testing with encoding-testing.
- **Fix:** Added `text_deltas.txt` (simple "Hello", ", ", "world!" sequence) so Test 1 has a dedicated fixture and the wiremock Test 5 can reuse it as the mock-server SSE body.
- **Files modified:** `crates/intelligence/tests/fixtures/anthropic_sse/text_deltas.txt`.
- **Commit:** `aa44f13`.

---

**Total deviations:** 3 auto-fixed (1 test bug, 1 blocking visibility, 1 missing-critical fixture). **Impact:** Structural only — no behaviour change vs. plan intent. Acceptance criteria unchanged and all still pass. No scope creep.

## Guardrail Evidence

**G1 (redaction) inherits from Plan 03-01.** The api-key field is set via `.header("x-api-key", self.api_key.expose())` — the `Redacted<String>` wrapper prevents accidental debug of the key through any `tracing::field` mechanism, and the `#[instrument(skip_all, fields(model = %req.model))]` attribute on `stream` ensures only the model name lands in span fields. Body is never logged.

## Verification

```bash
cargo test -p intelligence --lib llm::retry                    # 8/8 passed
cargo test -p intelligence --test anthropic_stream_tests       # 5/5 passed
cargo test -p intelligence                                     # 20/20 passed (8 retry + 4 anthropic unit + 3 redaction + 2 error bounds + 3 pre-existing)
```

**Task 1 acceptance criteria:**
- `cargo test -p intelligence --lib llm::retry` → 8/8 green (plan required ≥4) ✓
- `grep -c "fn parse_retry_after" crates/intelligence/src/llm/retry.rs` → 4 (function def + 3 test names; function def = 1) ✓
- `grep -c "min(2" crates/intelligence/src/llm/retry.rs` → 2 (impl + doc) ✓

**Task 2 acceptance criteria:**
- All 5 integration tests green ✓
- `grep -c "anthropic-beta" anthropic.rs` → 2 (const + header call) ✓
- `grep -c "cache_control" anthropic.rs` → 13 (impl, doc, tests) ✓
- `grep -cE 'ttl.*1h|"1h"' anthropic.rs` → 5 ✓
- `grep -cE "input_json_delta|InputJson" anthropic.rs` → 4 ✓
- `grep -c "pool_max_idle_per_host" anthropic.rs` → 1 ✓
- Fixture files: `tool_use_happy.txt`, `multibyte_text.txt`, `error_event.txt`, `text_deltas.txt` all present ✓

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-04-01 (Info Disclosure — reqwest request log) | mitigated | `x-api-key` header set via `.header(...)` on `Redacted<String>::expose()`; `#[instrument(skip_all, fields(model = %req.model))]` omits body + headers from tracing spans |
| T-03-04-02 (Tampering — malicious SSE payload) | mitigated | `SseEvent` is a strictly-tagged `#[serde(tag = "type")]` enum; unknown `type` fails deserialisation → `LlmError::SchemaDrift`; no `panic!` on unrecognised shapes |
| T-03-04-03 (Spoofing — TLS) | mitigated | `reqwest` dependency declares `default-features = false, features = ["rustls-tls", ...]` (Cargo.toml unchanged from Plan 03-01); no native-tls, no plaintext |
| T-03-04-04 (DoS — infinite SSE stream) | mitigated | `Client::builder().timeout(Duration::from_secs(120))` caps the overall HTTP lifetime; `max_tokens` in the request body bounds provider output (§4b.3) |
| T-03-04-05 (Info Disclosure — tool input JSON in error) | mitigated | `LlmError::PartialJsonInvalid` is constructed WITHOUT the buffer (`.map_err(|_| ...)` discards the inner serde error whose `Display` would echo the bytes) |
| T-03-04-06 (Info Disclosure — truncated provider body) | mitigated | `classify_http_error` calls `.chars().take(256).collect()` before embedding; any longer body gets an `"…"` suffix. Upstream redaction layer (Plan 03-01) strips `sk-*` / `Bearer *` patterns as defence in depth. |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. `AnthropicProvider` is fully functional; the only test-only seam (`with_base_url`) is also a production-valid constructor for future staging endpoints.

## Issues Encountered

None beyond the three auto-fixed deviations. TDD cycle ran essentially clean — Task 1 had one green-side test fixup (HTTP-date weekday mismatch in the assertion); Task 2 compiled green on the first run after the `pub(crate) → pub` visibility adjustment.

## Authentication Gates

None — Task 2's wiremock test uses a hard-coded `"test-key-xyz"` canary matched against the mock server's `header(...)` matcher. Real Anthropic API calls are deferred to the Wave 2 orchestrator bring-up (Plan 03-05+).

## User Setup Required

None — pure-Rust implementation with no external-service dependencies. Real API key storage is already wired via Plan 03-03's `key_set(ProviderId::Anthropic, ...)`.

## Next Plan Readiness

- **Wave 2 orchestrator** can now instantiate `AnthropicProvider::new(redacted_key.into_inner())`, build an `LlmRequest` with cached system blocks + user messages + the `emit_story_doc` tool, pass an `mpsc::Sender<LlmEvent>` into `provider.stream(req, tx).await`, and consume the chat-panel-friendly `TextDelta` + parse-once `ToolUseComplete` + per-turn `Usage` events.
- **Retry wrapping:** the orchestrator should call `retry::with_backoff(|attempt| provider.stream(req.clone(), tx.clone()))`. Note: `LlmRequest` is `Clone` by design for exactly this reason.
- **OpenAI provider (future plan)** mirrors this shape — point `with_base_url` at `https://api.openai.com/v1/chat/completions`, swap the SSE event shapes, reuse the same retry helper unchanged.
- No blockers. Cargo.toml is stable; no further dep additions expected for the Anthropic path.

## Handoff Notes

- `process_event` is exposed as `pub` specifically to let integration tests drive the parser from fixture bytes. Production callers go through `LlmProvider::stream`; `process_event` is documented as testing-oriented but technically part of the public API. If a future refactor wants to hide it, add `#[doc(hidden)]` + move the integration test into a `#[cfg(test)] mod` inside the lib — but the current shape is simpler and has one caller.
- Anthropic's `message_delta` streams `usage` incrementally; `parse_usage` emits one `LlmEvent::Usage` per non-empty delta. The final usage arrives with `stop_reason` populated — consumers summing across events will get the correct total. If consumers want only the final tally, they can filter for the last `Usage` event before `stream(...)` resolves `Ok(())`.
- The wiremock test confirms `stream: true` in the body and `cache_control.ttl: "1h"` on the last system block, but does NOT assert `cache_control` absence from earlier blocks — intentional: callers who want multi-breakpoint caching (e.g. separate caches for grammar vs. tool docs) can manually set `cache_control` on their own blocks and the builder preserves them.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/llm/retry.rs` → FOUND
- `crates/intelligence/src/llm/anthropic.rs` → FOUND (updated from placeholder)
- `crates/intelligence/src/llm/mod.rs` → FOUND (with `pub mod retry;`)
- `crates/intelligence/tests/anthropic_stream_tests.rs` → FOUND
- `crates/intelligence/tests/fixtures/anthropic_sse/tool_use_happy.txt` → FOUND
- `crates/intelligence/tests/fixtures/anthropic_sse/multibyte_text.txt` → FOUND
- `crates/intelligence/tests/fixtures/anthropic_sse/error_event.txt` → FOUND
- `crates/intelligence/tests/fixtures/anthropic_sse/text_deltas.txt` → FOUND

Commits:
- `b5d5695` (feat 03-04 Task 1 retry) → FOUND via `git log --oneline`
- `aa44f13` (feat 03-04 Task 2 AnthropicProvider) → FOUND via `git log --oneline`

Verification:
- `cargo test -p intelligence --lib llm::retry` → 8/8 passed
- `cargo test -p intelligence --test anthropic_stream_tests` → 5/5 passed
- `cargo test -p intelligence` → 20/20 passed (lib + anthropic + redaction test binaries)

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
