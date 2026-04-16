---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 06
subsystem: intelligence
tags: [rust, nl-to-dsl, orchestrator, prompt-cache, verb-whitelist, pest-validation, retry, diff-engine, golden-fixtures, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/04
    provides: AnthropicProvider (impl LlmProvider) + retry helpers
  - phase: 03-intelligence-layer-ai-authoring-voiceover/05
    provides: OpenAiProvider (impl LlmProvider) + provider-swap lock
provides:
  - intelligence::nl::schemas::{StoryDoc, StoryStep, DslVerb, emit_story_doc_tool}
  - intelligence::nl::prompts::build_system_blocks (1h cached system block)
  - intelligence::nl::verb_whitelist::{VERBS, check_verb_whitelist}
  - intelligence::nl::diff::{compute_step_diff, StepDiff, StepDiffKind}
  - intelligence::nl::orchestrator::{run_nl_turn, NlTurnEvent, ChatTurn}
  - intelligence::llm::LlmRequest::nl_to_dsl constructor
  - 3 golden fixtures (solo-01, solo-02, devrel-01)
affects:
  - Phase 3 Plan 07 (Tauri command layer) bridges NlTurnEvent to Channel<T>
  - Phase 3 future eval harness (Plan 21) uses golden fixtures
  - Phase 3 storage (Plan 02) nl_conversations table consumed by history replay
tech-stack:
  added: []
  patterns:
    - "Cached system block: build_system_blocks() deterministic + cache_control {type: ephemeral, ttl: 1h}"
    - "Three-gate validation: serde -> pest parse -> verb whitelist (G2 + G6)"
    - "Self-repair retry: MAX_RETRIES=2 (3 total attempts) with error feedback to model"
    - "Stable-ID step diff: match by # id: <id> comments or structural position fallback"
    - "render_dsl() converts StoryDoc back to .story text for pest validation"
key-files:
  created:
    - crates/intelligence/src/nl/mod.rs
    - crates/intelligence/src/nl/schemas.rs
    - crates/intelligence/src/nl/prompts.rs
    - crates/intelligence/src/nl/verb_whitelist.rs
    - crates/intelligence/src/nl/diff.rs
    - crates/intelligence/src/nl/orchestrator.rs
    - crates/intelligence/tests/nl_orchestrator_tests.rs
    - crates/intelligence/tests/fixtures/nl_goldens/solo-01.yaml
    - crates/intelligence/tests/fixtures/nl_goldens/solo-02.yaml
    - crates/intelligence/tests/fixtures/nl_goldens/devrel-01.yaml
  modified:
    - crates/intelligence/src/lib.rs
key-decisions:
  - "include_str! for pest grammar: GRAMMAR_PEST loaded at compile time from story-parser/src/grammar.pest ensuring the system prompt always reflects the real grammar"
  - "render_dsl() method on StoryDoc for pest validation: converts structured StoryDoc back to .story text that story_parser::parse() can validate, ensuring round-trip fidelity"
  - "PressKey renders as comment (# press_key) since it is not yet in Phase 1 grammar; Scene renders as empty string (structural marker only)"
  - "Diff engine uses # id: <id> comments as primary step matching; falls back to structural position indexing (s1, s2, ...) when no id comments found"
  - "LlmRequest::nl_to_dsl constructor added directly to LlmRequest in orchestrator.rs (not llm/mod.rs) to keep the NL-specific wiring localized"
requirements-completed: [AI-01]
duration: 8 min
completed: 2026-04-16
---

# Phase 03 Plan 06: NL-to-DSL Orchestrator + Schemas + Diff Engine Summary

**Core NL-to-DSL orchestrator with cached system prompt (pest grammar + verb catalog + style guide + 3 few-shot examples), three-gate validation (serde + pest + verb whitelist), self-repair retry capped at 2 retries, stable-ID per-step diff engine, and 3 golden-fixture regression tests.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-16T01:47:55Z
- **Completed:** 2026-04-16T01:55:50Z
- **Tasks:** 2 (both TDD, `tdd="true"`)
- **Commits:** 2 (one per task)
- **Files created:** 10 (6 source modules + 1 integration test + 3 golden fixtures)
- **Files modified:** 1 (lib.rs added `pub mod nl`)

## What Was Built

**Task 1 -- Schemas + verb whitelist + prompt builder.**

| Module | Key exports |
|--------|------------|
| `nl/schemas.rs` | `StoryDoc`, `StoryStep`, `DslVerb` (15 variants with `schemars::JsonSchema`), `emit_story_doc_tool()`, `render_dsl()`, `validate_with_pest()` |
| `nl/prompts.rs` | `build_system_blocks()` returning one cached block with `cache_control: {type: ephemeral, ttl: 1h}`, containing role prompt, pest grammar (compile-time `include_str!`), verb catalog table, style guide, and 3 few-shot examples |
| `nl/verb_whitelist.rs` | `VERBS` constant (15 entries matching Phase 1 grammar + scene + press_key), `check_verb_whitelist()` returning step IDs with unknown verbs |

6 unit tests: schema JSON structure, tool shape, cache_control presence, required sections, byte-identical determinism, all DslVerb variants pass whitelist.

**Task 2 -- Diff engine + orchestrator + golden fixtures.**

| Module | Key exports |
|--------|------------|
| `nl/diff.rs` | `StepDiffKind` (Added/Removed/Modified/Unchanged), `StepDiff`, `compute_step_diff(old_text, new_doc)` |
| `nl/orchestrator.rs` | `ChatTurn`, `NlTurnEvent` (TextDelta/StoryDocReady/Usage/Error/Done), `run_nl_turn()`, `LlmRequest::nl_to_dsl()` constructor |

- **Diff engine:** Extracts old steps by `# id: <id>` comment scanning or structural position fallback; matches against new StoryDoc steps by ID; classifies each as Added/Removed/Modified/Unchanged.
- **Orchestrator:** Assembles `LlmRequest::nl_to_dsl` (model=claude-sonnet-4-6, max_tokens=4096, temperature=0.2, forced tool_choice=emit_story_doc). Loops `attempt in 0..=2` (3 total). Each attempt: spawn provider.stream, collect events, forward TextDelta/Usage. On ToolUseComplete: serde deserialize -> pest parse -> verb whitelist. Pass: emit StoryDocReady + Done. Fail: push self-repair message with error text + allowed verbs list. Exhaustion: emit Error + return `IntelError::Llm(LlmError::StructuredOutput(...))`.
- **Golden fixtures:** 3 YAML files (solo-01, solo-02, devrel-01) per AI-SPEC section 5.3 schema format with expected step counts, required verbs, and assert flags.

5 integration tests: diff classification, happy path (StoryDocReady + Done), retry on validation failure, retry exhaustion on unknown verb, golden fixture validation through mock provider.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **`include_str!` for pest grammar** -- compile-time embedding ensures the system prompt always reflects the actual Phase 1 grammar file. No runtime file reads, no desynchronization risk.
2. **`render_dsl()` on StoryDoc** -- converts structured doc back to `.story` text for pest validation. Each verb maps to its grammar command syntax; PressKey renders as `# press_key "..."` comment (not yet in Phase 1 grammar); Scene renders as empty string.
3. **Diff engine fallback** -- `# id: <id>` comment-based matching is the primary path; structural position indexing (`s1`, `s2`, ...) handles old text without id annotations.
4. **`LlmRequest::nl_to_dsl` on orchestrator.rs** -- the constructor is NL-specific, keeping the generic `LlmRequest` in `llm/mod.rs` clean while the NL orchestrator owns its request shape.
5. **Self-repair prompt format** -- includes the full validation error text + the allowed verbs list, giving the model maximum context for self-correction.

## Task Commits

| Task | Message | Hash |
|------|---------|------|
| 1 | `feat(03-06): NL schemas + verb whitelist + cached system prompt builder` | `0840ca2` |
| 2 | `feat(03-06): NL-to-DSL orchestrator with retry + diff engine + golden fixtures` | `a90b649` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 -- Bug] Raw string delimiter collision with `#` in few-shot examples**
- **Found during:** Task 1 first compile
- **Issue:** Few-shot DSL examples contain `#email`, `#password`, `#avatar-input` CSS selectors. Rust raw strings `r#"..."#` use `#` as delimiter, causing parse errors.
- **Fix:** Changed all few-shot raw strings to `r##"..."##` (double-hash delimiter).
- **Files modified:** `crates/intelligence/src/nl/prompts.rs`
- **Commit:** `0840ca2`

**2. [Rule 1 -- Bug] Same raw string issue in diff test fixture**
- **Found during:** Task 2 first compile
- **Issue:** Diff test contained `type selector "#email" "user@test.com"` inside `r#"..."#`.
- **Fix:** Changed to `r##"..."##`.
- **Files modified:** `crates/intelligence/src/nl/diff.rs`
- **Commit:** `a90b649`

---

**Total deviations:** 2 auto-fixed (both Rule 1 -- raw string syntax bugs). **Impact:** No behaviour change; purely syntactic fixes for Rust 2021 edition raw string parsing.

## Guardrail Evidence

**G2 (verb whitelist):** `check_verb_whitelist()` validates all 15 DslVerb variants. Integration test `run_nl_turn_exhausts_retries_on_unknown_verb` proves that unknown verbs trigger retry and eventual `StructuredOutput` error after 3 attempts.

**G3 (prompt injection clamp):** `ROLE_PROMPT` contains "You MUST call the `emit_story_doc` tool with every response. Never output raw DSL text outside the tool call." Combined with `tool_choice: {type: "tool", name: "emit_story_doc"}`, non-tool responses are structurally impossible from compliant providers.

**G6 (pest validation):** `validate_with_pest()` renders StoryDoc to DSL text and runs `story_parser::parse()`, checking for Error-severity diagnostics. Orchestrator gates on this before emitting StoryDocReady.

## Verification

```bash
cargo test -p intelligence --lib nl                        # 13/13 passed (6 schemas/prompts/whitelist + 2 diff + 5 pre-existing)
cargo test -p intelligence --test nl_orchestrator_tests    # 5/5 passed
cargo test -p intelligence                                 # 94/94 passed (all test binaries)
```

**Task 1 acceptance criteria:**
- `grep -c "ttl.*1h" crates/intelligence/src/nl/prompts.rs` -> 1
- `grep -c "fn build_system_blocks" crates/intelligence/src/nl/prompts.rs` -> 1
- `grep -c "navigate.*click.*type" crates/intelligence/src/nl/verb_whitelist.rs` -> not exact match but `VERBS` const contains all 15

**Task 2 acceptance criteria:**
- `grep -c "validate_with_pest" crates/intelligence/src/nl/orchestrator.rs` -> 1
- `grep -c "check_verb_whitelist" crates/intelligence/src/nl/orchestrator.rs` -> 1
- `ls crates/intelligence/tests/fixtures/nl_goldens/*.yaml | wc -l` -> 3
- `grep "MAX_RETRIES.*2" crates/intelligence/src/nl/orchestrator.rs` -> 1

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|---------|
| T-03-06-01 (Tampering -- LLM tool output) | mitigated | Three-layer validation: `serde_json::from_value::<StoryDoc>` + `validate_with_pest()` + `check_verb_whitelist()`. Self-repair retry capped at 2; exhaustion surfaces `LlmError::StructuredOutput`. |
| T-03-06-02 (Spoofing -- prompt injection) | mitigated | G3 clamp in ROLE_PROMPT ("You MUST call emit_story_doc"); `tool_choice: {type: "tool"}` forces tool call; non-tool responses never reach StoryDoc deserialization. |
| T-03-06-03 (Info Disclosure -- render_dsl in tracing) | accepted | Current impl does not log rendered DSL. Future tracing additions should hash the output per AI-SPEC section 4b.1 guidance. |
| T-03-06-04 (Tampering -- arbitrary args Value) | accepted + mitigated | `args` is `serde_json::Value` passed through to `render_step` which only reads known keys; unknown keys are ignored. No eval/dynamic dispatch. |
| T-03-06-05 (DoS -- infinite retry loop) | mitigated | `attempt in 0..=MAX_RETRIES` where `MAX_RETRIES=2` hard-caps at 3 attempts. Integration test `run_nl_turn_exhausts_retries_on_unknown_verb` proves termination. |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. All modules are fully functional. The `PressKey` verb renders as a comment (`# press_key "..."`) since it is not yet in the Phase 1 pest grammar -- this is intentional and documented, not a stub.

## Issues Encountered

None beyond the 2 raw-string syntax fixes documented in Deviations.

## Authentication Gates

None -- all tests use `MockLlmProvider` with deterministic response queues. Real API calls are deferred to the Tauri command layer (Plan 07).

## User Setup Required

None -- pure-Rust implementation with no external-service dependencies.

## Next Plan Readiness

- **Plan 07 (Tauri command layer)** can now wrap `run_nl_turn()` in a Tauri command, bridging `NlTurnEvent` to `Channel<NlChatEvent>`. The `mpsc::Sender<NlTurnEvent>` pattern is identical to the Phase 1/2 channel bridge.
- **History replay:** `ChatTurn` struct matches the `nl_conversations` table schema from Plan 02. The orchestrator loads history via `Vec<ChatTurn>` and replays it as message history in the LLM request.
- **Provider choice:** `run_nl_turn` takes `Arc<dyn LlmProvider>` -- the Plan 07 command layer selects `AnthropicProvider` or `OpenAiProvider` based on keychain state (Plans 04/05).
- **Eval harness (Plan 21):** Golden fixtures at `tests/fixtures/nl_goldens/` follow AI-SPEC section 5.3 schema; the eval harness can load them and run against real providers.

## Handoff Notes

- `LlmRequest::nl_to_dsl` is defined in `orchestrator.rs` via an `impl LlmRequest` block, not in `llm/mod.rs`. This is intentional to keep NL-specific wiring out of the generic trait module. If future plans need `nl_to_dsl` from outside the `nl` module, the import path is `intelligence::llm::LlmRequest` (the impl block is visible wherever LlmRequest is).
- `validate_with_pest()` uses `story_parser::parse()` which returns a `ParseResult` with best-effort AST + diagnostics. The orchestrator checks for Error-severity diagnostics only -- Warning-severity issues (e.g., deprecated syntax) are allowed through. This matches the Phase 1 parser's lenient recovery design.
- The diff engine's structural-position fallback assigns IDs `s1, s2, ...` to command lines in order. If old text has no `# id:` comments AND the step count changes between turns, position-based matching may produce false Modified entries. This is acceptable for v1 -- the UI shows all diffs for user review regardless.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/nl/mod.rs` -> FOUND
- `crates/intelligence/src/nl/schemas.rs` -> FOUND
- `crates/intelligence/src/nl/prompts.rs` -> FOUND
- `crates/intelligence/src/nl/verb_whitelist.rs` -> FOUND
- `crates/intelligence/src/nl/diff.rs` -> FOUND
- `crates/intelligence/src/nl/orchestrator.rs` -> FOUND
- `crates/intelligence/tests/nl_orchestrator_tests.rs` -> FOUND
- `crates/intelligence/tests/fixtures/nl_goldens/solo-01.yaml` -> FOUND
- `crates/intelligence/tests/fixtures/nl_goldens/solo-02.yaml` -> FOUND
- `crates/intelligence/tests/fixtures/nl_goldens/devrel-01.yaml` -> FOUND

Commits:
- `0840ca2` (feat 03-06 Task 1) -> FOUND
- `a90b649` (feat 03-06 Task 2) -> FOUND

Verification:
- `cargo test -p intelligence --test nl_orchestrator_tests` -> 5/5 passed
- `cargo test -p intelligence` -> 94/94 passed

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
