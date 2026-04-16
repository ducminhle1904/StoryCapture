---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 10
subsystem: intelligence
tags: [rust, tts, auto-script, llm, narration, d-12, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/04
    provides: AnthropicProvider (LlmProvider impl)
  - phase: 03-intelligence-layer-ai-authoring-voiceover/06
    provides: StoryDoc + StoryStep schemas
provides:
  - intelligence::tts::script::generate_narration_script
  - intelligence::tts::script::{NarrationDraft, NarrationBatch, NarrationItem}
  - Per-step narration with word-count enforcement (<=80 words) and ElevenLabs cost estimate
affects:
  - Phase 3 Wave 3 TTS orchestrator (Plan 11) — narration text feeds into TtsRequest.text
  - Phase 3 script-review UI (Plan 19) — NarrationDraft vec displayed for user editing before TTS synthesis
  - Phase 3 eval harness (Plan 21) — script quality can be measured against golden fixtures
tech-stack:
  added: []
  patterns:
    - "LLM tool-use via emit_narrations tool with forced tool_choice — identical pattern to NL orchestrator's emit_story_doc"
    - "Sentence-boundary truncation at 80 words — prevents TTS overruns (T-03-10-02)"
    - "ElevenLabs cost estimate baked into draft — user sees cost before committing to synthesis"
    - "Faithfulness heuristic logs warnings for hallucinated content (T-03-10-01) but does not reject — user is the final gate"
key-files:
  created:
    - crates/intelligence/src/tts/script.rs
    - crates/intelligence/tests/tts_script_tests.rs
    - crates/intelligence/tests/fixtures/script_goldens/basic.yaml
    - crates/intelligence/tests/snapshots/tts_script_tests__basic_login_narration.snap
  modified:
    - crates/intelligence/src/tts/mod.rs
    - crates/intelligence/Cargo.toml
key-decisions:
  - "temperature=0.4 and max_tokens=256/step per AI-SPEC S4 Model Configuration row for TTS auto-script (D-12). Bounded total max_tokens at 8192 to prevent runaway on large stories."
  - "ElevenLabs cost rate ($0.30/1K chars) used as default estimate since ElevenLabs is the primary TTS provider per D-10. Cost is per-character, not per-word, matching ElevenLabs billing."
  - "Sentence-boundary truncation preferred over hard word-cut — finds the last sentence-ending punctuation (.!?) within the 80-word limit for natural-sounding narration."
  - "Faithfulness check is a soft heuristic (log warning, do not fail) because the user reviews per-step text before committing to TTS synthesis (Plan 11 UI gate). Hard rejection would frustrate users for edge cases."
  - "Missing steps from LLM batch get fallback narration using the step label — degraded but non-empty, so TTS pipeline always has text for every step."
requirements-completed: [AI-02]
duration: ~5 min
completed: 2026-04-16
---

# Phase 03 Plan 10: TTS Auto-Script Generator (D-12) Summary

**LLM-powered per-step narration generator that takes a StoryDoc and emits NarrationDraft vectors with word-count enforcement (<=80 words at sentence boundary), ElevenLabs cost estimation ($0.30/1K chars), faithfulness heuristic for hallucination detection, and fallback narration for missing steps.**

## Performance

- **Duration:** ~5 min
- **Tasks:** 1 (TDD `tdd="true"`)
- **Commits:** 3 (`27eeb33` RED, `ee4eeac` GREEN, `6e8b277` chore)
- **Files created:** 4 (script.rs, test file, golden fixture, insta snapshot)
- **Files modified:** 2 (tts/mod.rs, Cargo.toml)

## What Was Built

**Task 1 — `generate_narration_script` (`crates/intelligence/src/tts/script.rs`).** Complete auto-script generator implementing D-12:

- **`NarrationDraft`** struct with `step_id`, `text` (<=80 words), `word_count`, `cost_estimate_usd`.
- **`NarrationBatch` / `NarrationItem`** — tool-use output schema with `JsonSchema` derive for the `emit_narrations` tool definition.
- **`generate_narration_script(provider, story, brand_tone)`** — builds an `LlmRequest` with:
  - System prompt as cached ephemeral block (5m cache_control) instructing the LLM to emit one narration per step via tool-use
  - User message containing story title, per-step context (id, verb, args, label), and brand tone
  - `tool_choice = {type: "tool", name: "emit_narrations"}` for forced structured output
  - `temperature = 0.4`, `max_tokens = 256 * step_count` (capped at 8192)
- **Post-processing pipeline:**
  1. Deserialize `NarrationBatch` from tool-use output
  2. Drop unknown step_ids (log warning)
  3. Synthesize fallback narration (step label) for missing steps
  4. Truncate text at sentence boundary if > 80 words
  5. Compute `word_count` and `cost_estimate_usd` (chars * $0.30 / 1000)
  6. Run faithfulness heuristic (log warning for suspicious terms not in DSL)
- **`truncate_at_sentence_boundary`** — finds the last `.` / `!` / `?` within the word limit for natural truncation; falls back to hard word-cut if no sentence boundary found.
- **`check_faithfulness`** — simple heuristic checking for suspicious terms (pricing, oauth, 2fa, billing, etc.) not present in the story's steps/args/title. Logs warning but does not reject — user is the final review gate.

**Module registration:** `pub mod script;` added to `crates/intelligence/src/tts/mod.rs`.

**Cargo.toml:** `insta` dev-dependency updated to include `json` feature for `assert_json_snapshot!`.

**Golden fixture (`tests/fixtures/script_goldens/basic.yaml`).** Three-step login flow (navigate, type, click) with expected count=3, max_words_per_step=80, and forbidden_phrases for hallucination detection.

**Integration tests (`tests/tts_script_tests.rs`).** Seven `#[tokio::test]`s:

| Test | What it locks |
|---|---|
| `happy_path_returns_3_narration_drafts_with_matching_step_ids` | 3-step story → 3 drafts with matching IDs, non-empty text, word_count <= 80, positive cost |
| `text_over_80_words_is_truncated_at_sentence_boundary` | ~100-word input → truncated <= 80 words, word_count matches actual word count |
| `cost_estimate_matches_elevenlabs_pricing` | 150-char text → cost ≈ 0.045 (150 * 0.30 / 1000) |
| `faithfulness_check_flags_hallucinated_content` | Narration with "pricing page", "OAuth", "2FA" → succeeds (does not reject), text preserved |
| `golden_basic_login_snapshot` | Insta JSON snapshot locks exact output shape for 3-step login fixture |
| `unknown_step_ids_dropped_missing_steps_get_fallback` | Unknown IDs dropped; missing steps get label as fallback text |
| `prompt_includes_step_context` | Prompt contains verb/label/args/brand-tone; temperature=0.4; tool_choice forces emit_narrations |

Plus 4 in-module unit tests: `truncate_short_text_unchanged`, `truncate_at_sentence_boundary_works`, `cost_estimate_constant_is_elevenlabs_rate`, `max_tokens_per_step_is_256`.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **temperature=0.4 + max_tokens=256/step** — exact AI-SPEC S4 values for TTS auto-script (D-12).
2. **ElevenLabs cost rate as default** — primary TTS provider per D-10; cost estimate uses $0.30/1K chars.
3. **Sentence-boundary truncation** — natural-sounding cuts at `.` / `!` / `?` rather than mid-sentence word break.
4. **Soft faithfulness check** — warnings only, no rejection; user reviews in Plan 11 UI before TTS synthesis.
5. **Label fallback for missing steps** — degraded but non-empty narration ensures TTS pipeline always has text.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 (RED) | `test(03-10): add failing tests for TTS auto-script generator (D-12)` | `27eeb33` |
| 1 (GREEN) | `feat(03-10): TTS auto-script generator (D-12) with per-step narration + cost estimate` | `ee4eeac` |
| 1 (chore) | `chore(03-10): update Cargo.lock for insta json feature` | `6e8b277` |

TDD cycle: RED committed failing tests (module did not exist), GREEN committed full implementation + snapshot acceptance. Chore committed Cargo.lock update from insta json feature addition.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `insta` json feature to Cargo.toml dev-dependencies.**
- **Found during:** Task 1 RED phase (snapshot test compilation).
- **Issue:** Plan requires `insta` golden snapshot test with `assert_json_snapshot!`, but the existing `insta = "1"` dep lacks the `json` feature needed for JSON snapshot macros.
- **Fix:** Updated to `insta = { version = "1", features = ["json"] }`.
- **Files modified:** `crates/intelligence/Cargo.toml`, `Cargo.lock`.
- **Commit:** `ee4eeac`, `6e8b277`.

**2. [Rule 2 - Missing Critical] Added 2 extra tests beyond plan's 5 (unknown_step_ids + prompt_context).**
- **Found during:** Task 1 test drafting.
- **Issue:** Plan specifies 5 test cases but the critical behaviors of unknown-step-id dropping and prompt content verification are testable and important for regression safety.
- **Fix:** Added `unknown_step_ids_dropped_missing_steps_get_fallback` and `prompt_includes_step_context` tests.
- **Files modified:** `crates/intelligence/tests/tts_script_tests.rs`.
- **Commit:** `27eeb33`.

---

**Total deviations:** 2 auto-fixed (both Rule 2 — missing-critical). **Impact:** Strictly additive. All plan acceptance criteria pass unchanged.

## Verification

```bash
cargo test -p intelligence --test tts_script_tests     # 7/7 passed
cargo test -p intelligence --lib                       # 56/56 passed
cargo test -p intelligence                             # all passed
```

**Task 1 acceptance criteria:**

- All 5+ tests green (7 delivered) - PASS
- `grep -c "256" crates/intelligence/src/tts/script.rs` -> 3 (>= 1) - PASS
- `grep -c "0.4\|0_4" crates/intelligence/src/tts/script.rs` -> 1 (>= 1) - PASS
- `grep -c "0.30" crates/intelligence/src/tts/script.rs` -> 3 (>= 1) - PASS
- Fixture `basic.yaml` exists - PASS

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-10-01 (Tampering - Hallucinated narration) | mitigated | `check_faithfulness` heuristic flags suspicious terms not in DSL; unknown step_ids dropped; user reviews per-step text before TTS synthesis (Plan 11 UI gate) |
| T-03-10-02 (DoS - Output overrun max_tokens) | mitigated | `truncate_at_sentence_boundary` enforces <= 80 words in Rust; `max_tokens` cap in LLM request (256/step, bounded at 8192) |
| T-03-10-03 (Info Disclosure - Prompt containing user PII) | accepted + flagged | Same data will be sent to LLM anyway for DSL generation; user already consented via provider-transparency modal (G9, Plan 20). No new disclosure here. |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. `generate_narration_script` is fully functional with mock-testable LLM integration.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register.

## Issues Encountered

None beyond the auto-fixed deviations. TDD cycle ran clean: RED tests failed to compile (expected — `tts::script` module did not exist); GREEN tests all passed on first run after implementation.

## Authentication Gates

None — all tests use mock `LlmProvider` implementations. Real LLM API calls are deferred to the Wave 3 orchestrator bring-up (Plan 11+).

## User Setup Required

None — pure-Rust implementation with no external-service dependencies at build/test time.

## Next Plan Readiness

- **Wave 3 TTS orchestrator (Plan 11):** can call `generate_narration_script(provider, &story, brand_tone)` to get `Vec<NarrationDraft>`, then feed each `draft.text` into `TtsRequest.text` for ElevenLabs/OpenAI synthesis.
- **Script review UI (Plan 19):** renders `Vec<NarrationDraft>` in a per-step editor; user edits `text` before committing to TTS synthesis.
- **Eval harness (Plan 21):** golden fixture `basic.yaml` + insta snapshot provides baseline for script quality regression testing.
- No blockers. No new dependencies added.

## Handoff Notes

- `generate_narration_script` takes `Arc<dyn LlmProvider>` — the same trait used by the NL-to-DSL orchestrator. Callers can share a single `AnthropicProvider` instance.
- The cost estimate uses ElevenLabs pricing by default. If the orchestrator knows the user will use OpenAI TTS, it should recalculate: `chars * 0.015 / 1000` for tts-1 or `chars * 0.030 / 1000` for tts-1-hd.
- `check_faithfulness` is a best-effort heuristic with a hardcoded suspicious-term list. It catches obvious hallucinations but not subtle ones. The user review step in Plan 11 is the primary defense.
- `truncate_at_sentence_boundary` prefers sentence endings but falls back to hard word-cut. If the LLM consistently produces narrations > 80 words, consider lowering `max_tokens` or adding explicit word-count constraint to the prompt.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/tts/script.rs` -> FOUND
- `crates/intelligence/src/tts/mod.rs` -> FOUND (with `pub mod script;`)
- `crates/intelligence/tests/tts_script_tests.rs` -> FOUND
- `crates/intelligence/tests/fixtures/script_goldens/basic.yaml` -> FOUND
- `crates/intelligence/tests/snapshots/tts_script_tests__basic_login_narration.snap` -> FOUND

Commits:
- `27eeb33` (test RED) -> FOUND
- `ee4eeac` (feat GREEN) -> FOUND
- `6e8b277` (chore Cargo.lock) -> FOUND

Verification:
- `cargo test -p intelligence --test tts_script_tests` -> 7/7 passed
- `cargo test -p intelligence --lib` -> 56/56 passed

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
