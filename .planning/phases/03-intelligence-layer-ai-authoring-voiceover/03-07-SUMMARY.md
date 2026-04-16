---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 07
subsystem: tauri-ipc
tags: [rust, tauri-commands, nl-to-dsl, ipc, channel, cost-metrics, cancel, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/06
    provides: run_nl_turn + NlTurnEvent + ChatTurn + StoryDoc
  - phase: 03-intelligence-layer-ai-authoring-voiceover/03
    provides: ProviderId + keychain read pattern
  - phase: 03-intelligence-layer-ai-authoring-voiceover/02
    provides: nl_conversations + llm_turn_metrics tables + storage::phase3 accessors
provides:
  - commands::nl::nl_chat_send (Tauri command, Channel<NlChatEvent>)
  - commands::nl::nl_cancel (abort in-flight NL turn)
  - commands::nl::nl_diff_apply (apply approved steps, render .story text)
  - commands::nl::nl_diff_reject (drop cached doc)
  - commands::nl::nl_regen_step (single-step regen with targeted prompt)
  - commands::nl::nl_load_history (load conversation from project.sqlite)
  - commands::nl::compute_cost (Sonnet 4.6 pricing formula)
  - state::nl_tasks::NlTaskRegistry (abort handle + doc cache, 4-per-project cap)
affects:
  - Phase 3 Plan 19 (React NL chat panel) consumes NlChatEvent via Channel
  - Phase 3 Plan 20 (provider transparency modal) reads cost_usd from Usage events
  - Phase 3 status-bar token counter reads llm_turn_metrics rows
tech-stack:
  added:
    - "rusqlite 0.34 (bundled) added to storycapture host Cargo.toml for persist_turn query"
  patterns:
    - "Arc<NlTaskRegistry> managed as Tauri state for cross-task cloning"
    - "Channel<NlChatEvent> bridge: orchestrator NlTurnEvent -> DTO -> Channel::send"
    - "Cost formula: (uncached*3 + cache_read*0.30 + cache_write*6 + output*15) / 1M"
    - "state.rs -> state/mod.rs + state/nl_tasks.rs module split"
key-files:
  created:
    - apps/desktop/src-tauri/src/commands/nl.rs
    - apps/desktop/src-tauri/src/state/nl_tasks.rs
    - apps/desktop/src-tauri/tests/nl_command_tests.rs
  modified:
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src-tauri/src/lib.rs
    - apps/desktop/src-tauri/src/state/mod.rs (renamed from state.rs)
    - apps/desktop/src-tauri/Cargo.toml
    - Cargo.lock
key-decisions:
  - "Arc<NlTaskRegistry> instead of raw NlTaskRegistry: Tauri State<T> returns &T which cannot be cloned into spawned tasks; wrapping in Arc allows the forwarder task to hold a reference beyond the command lifetime"
  - "NlStoryStepDto.args_json as String instead of serde_json::Value: specta::Type is not implemented for serde_json::Value; the renderer parses with JSON.parse()"
  - "state.rs split to state/ directory: plan requires state/nl_tasks.rs submodule; converted state.rs to state/mod.rs preserving all existing code"
  - "All 6 commands implemented in single commit: natural implementation flow had all commands and tests done together rather than split across 2 commits"
  - "rusqlite 0.34 added to host Cargo.toml: persist_turn helper uses Connection::query_row with array params which requires rusqlite's Params trait"
requirements-completed: [AI-01, UI-07]
duration: ~13 min
completed: 2026-04-16
---

# Phase 03 Plan 07: NL-to-DSL Tauri Command Layer Summary

**Six typed Tauri commands bridging the NL orchestrator to the webview via Channel<NlChatEvent>, with AbortHandle-based cancel registry (4-per-project cap), Sonnet 4.6 cost computation, conversation + metrics persistence to project.sqlite, and 18 integration tests.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-04-16T02:46:02Z
- **Completed:** 2026-04-16T02:59:28Z
- **Tasks:** 2 (both TDD)
- **Commits:** 1 (implementation naturally unified)
- **Files created:** 3 (nl.rs, nl_tasks.rs, nl_command_tests.rs)
- **Files modified:** 6 (mod.rs, ipc_spec.rs, lib.rs, state/mod.rs, Cargo.toml, Cargo.lock)

## What Was Built

**Task 1+2 -- All six NL commands + registry + tests.**

| Module | Key exports |
|--------|------------|
| `commands/nl.rs` | `nl_chat_send`, `nl_cancel`, `nl_diff_apply`, `nl_diff_reject`, `nl_regen_step`, `nl_load_history`, `compute_cost`, `NlChatEvent`, `NlCommandError`, DTO types |
| `state/nl_tasks.rs` | `NlTaskRegistry` (abort handle map + StoryDoc cache, 4-per-project cap) |

**Command details:**

- **`nl_chat_send`**: Validates project_id as UUID (T-03-07-01), reads API key from keychain, builds AnthropicProvider/OpenAiProvider, generates Uuid v7 task_id (T-03-07-05), spawns `run_nl_turn` via tokio::spawn, stores AbortHandle in registry with concurrency cap check (T-03-07-03), spawns forwarder task that bridges NlTurnEvent to Channel<NlChatEvent> with cost computation and best-effort persistence.

- **`nl_cancel`**: Looks up task_id in registry, calls `abort()`, returns `TaskNotFound` if unknown.

- **`nl_diff_apply`**: Retrieves StoryDoc from registry doc cache by task_id, filters steps if step_ids non-empty, calls `render_dsl()` to produce .story text.

- **`nl_diff_reject`**: Drops cached StoryDoc so subsequent `nl_diff_apply` returns `TaskNotFound`.

- **`nl_regen_step`**: Builds targeted regen prompt ("Regenerate ONLY step with id=..."), spawns a new NL turn with same Channel forwarding pattern.

- **`nl_load_history`**: Opens project.sqlite, calls `storage::phase3::load_nl_history`, maps NlTurn to NlTurnDto.

**Cost formula** (Sonnet 4.6 pricing, AI-SPEC section 4b.5):
```
cost_usd = (uncached * 3.00 + cache_read * 0.30 + cache_write * 6.00 + output * 15.00) / 1_000_000
```

**18 integration tests:**

| Module | Tests | What they lock |
|--------|-------|----------------|
| `task_registry` | 5 | insert/abort, cancel unknown, concurrency cap, doc store/take, doc drop |
| `cost_computation` | 6 | pricing formula, cache_read, cache_write, all fields, zero, saturating underflow |
| `diff_apply_reject` | 3 | apply all steps, partial step filter, reject drops doc |
| `load_history` | 2 | 4 turns in order, empty project |
| `regen_step` | 1 | prompt contains step_id |
| `llm_metrics` | 1 | insert + read metric row with computed cost |

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **`Arc<NlTaskRegistry>` as managed state** -- Tauri's `State<T>` returns `&T` which borrows `app`. Spawned tokio tasks need `'static` ownership, so wrapping in `Arc` allows cloning the smart pointer into the forwarder task.

2. **`args_json: String` instead of `serde_json::Value`** -- `specta::Type` is not implemented for `serde_json::Value`. The renderer parses with `JSON.parse()` on the JS side.

3. **`state.rs` -> `state/mod.rs` module split** -- The plan requires `state/nl_tasks.rs` as a submodule. Converted the flat file to a directory module, preserving all existing AppState code.

4. **Single commit for both tasks** -- All 6 commands and 18 tests were naturally implemented together. Splitting into 2 commits would have required artificial partial implementation.

5. **`rusqlite 0.34` added to host** -- The `persist_turn` helper calls `Connection::query_row` with array params, which requires rusqlite's `Params` trait implementation for `[T; N]`.

## Task Commits

| Task | Message | Hash |
|------|---------|------|
| 1+2 | `feat(03-07): NL-to-DSL Tauri commands + task registry + cost computation` | `0fec5e3` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `serde_json::Value` does not implement `specta::Type`**
- **Found during:** Task 1 compilation
- **Issue:** Plan specifies `args: serde_json::Value` in `NlStoryStepDto`, but `specta::Type` is not implemented for `serde_json::Value`, causing a compile error.
- **Fix:** Changed to `args_json: String` with `serde_json::to_string()` serialization. The renderer parses with `JSON.parse()`.
- **Files modified:** `apps/desktop/src-tauri/src/commands/nl.rs`
- **Commit:** `0fec5e3`

**2. [Rule 3 - Blocking] `State<NlTaskRegistry>::inner().clone()` requires Clone**
- **Found during:** Task 1 compilation
- **Issue:** Plan shows `NlTaskRegistry` as directly managed state, but spawned tasks need to clone the registry reference. `NlTaskRegistry` contains `Mutex<HashMap<...>>` which does not implement `Clone`.
- **Fix:** Wrapped in `Arc<NlTaskRegistry>` and managed `Arc<NlTaskRegistry>` as Tauri state. Commands clone the `Arc`.
- **Files modified:** `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/commands/nl.rs`
- **Commit:** `0fec5e3`

**3. [Rule 3 - Blocking] `AbortHandle::new_pair()` does not exist in tokio 1.40**
- **Found during:** Task 1 test compilation
- **Issue:** Plan's test code uses `AbortHandle::new_pair()` which is not a real tokio API.
- **Fix:** Created `test_abort_handle()` helper that spawns a dummy sleeping task and returns its `abort_handle()`.
- **Files modified:** `apps/desktop/src-tauri/src/state/nl_tasks.rs`, `apps/desktop/src-tauri/tests/nl_command_tests.rs`
- **Commit:** `0fec5e3`

**4. [Rule 3 - Blocking] `state.rs` needed conversion to directory module**
- **Found during:** Task 1 setup
- **Issue:** Plan requires `src/state/nl_tasks.rs` but state was a flat file `src/state.rs`.
- **Fix:** Renamed `state.rs` to `state/mod.rs`, added `pub mod nl_tasks;`.
- **Files modified:** `apps/desktop/src-tauri/src/state/mod.rs` (renamed)
- **Commit:** `0fec5e3`

---

**Total deviations:** 4 auto-fixed (all Rule 3 -- blocking issues preventing compilation). **Impact:** No behaviour change from plan intent; purely structural/API adjustments.

## Guardrail Evidence

**T-03-07-01 (Tampering -- project_id):** Every command parses `project_id` as `Uuid::parse_str()` and rejects with `NlCommandError::InvalidProject` on failure. No DB write occurs before validation.

**T-03-07-02 (Info Disclosure -- Channel):** `NlChatEvent` variants contain only deltas, DTOs, usage counters, and error messages. The API key is never serialized into any event variant.

**T-03-07-03 (DoS -- unbounded turns):** `NlTaskRegistry::insert()` counts existing tasks for the same `project_id` and returns `false` when >= 4. Integration test `concurrency_cap_at_4_per_project` verifies this.

**T-03-07-05 (Repudiation -- turn attribution):** `task_id` is `Uuid::now_v7()` (time-ordered) generated server-side. The webview only passes back the server-issued ID.

**T-03-07-06 (Spoofing -- task_id collision):** Uuid v7 generation happens in the Tauri command, not the webview.

## Verification

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test nl_command_tests   # 18/18 passed
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib                      # 15/15 passed (1 ignored)
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml                           # clean
```

**Task 1 acceptance criteria:**
- `grep -c "nl_chat_send\|nl_cancel" apps/desktop/src-tauri/src/ipc_spec.rs` -> 2 (PASS)
- `grep -c "cost_usd" apps/desktop/src-tauri/src/commands/nl.rs` -> 10 (>= 1, PASS)
- `grep -c "insert_llm_metric" apps/desktop/src-tauri/src/commands/nl.rs` -> 1 (PASS)

**Task 2 acceptance criteria:**
- `grep -c "nl_diff_apply\|nl_diff_reject\|nl_regen_step\|nl_load_history" apps/desktop/src-tauri/src/ipc_spec.rs` -> 4 (PASS)
- `grep -c "Regenerate ONLY step" apps/desktop/src-tauri/src/commands/nl.rs` -> 1 (PASS)
- 18 tests green (PASS)

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|---------|
| T-03-07-01 (Tampering -- project_id) | mitigated | `Uuid::parse_str` in every command before any write |
| T-03-07-02 (Info Disclosure -- Channel) | mitigated | `NlChatEvent` enum variants never contain API key |
| T-03-07-03 (DoS -- unbounded turns) | mitigated | `NlTaskRegistry::insert` caps at 4 per project; test verifies |
| T-03-07-04 (Info Disclosure -- nl_conversations) | accepted | User-authored prompts stored intentionally per D-09 |
| T-03-07-05 (Repudiation -- turn attribution) | mitigated | Uuid v7 task_id generated server-side |
| T-03-07-06 (Spoofing -- task_id collision) | mitigated | Uuid v7 in server-side; webview passes back server-issued ID |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. All six commands are fully wired. Persistence helpers are best-effort (errors logged, not propagated) which is intentional -- DB write failure should not break the streaming UX.

## Issues Encountered

None beyond the 4 auto-fixed deviations documented above.

## Authentication Gates

None -- all tests use direct NlTaskRegistry / storage layer calls. Real keychain access is deferred to runtime.

## User Setup Required

None -- pure-Rust implementation with no external-service dependencies at build/test time.

## Next Plan Readiness

- **Plan 19 (React NL chat panel):** can invoke `nl_chat_send` via Tauri IPC and receive `NlChatEvent` stream in the webview. All six commands are registered in the specta builder and will appear in the generated TS bindings.
- **Plan 20 (provider transparency modal):** `NlChatEvent::Usage` includes `cost_usd` for real-time cost display.
- **Status-bar token counter:** reads `llm_turn_metrics` rows via `storage::phase3::session_total_cost`.
- No blockers. No new external dependencies.

## Handoff Notes

- `Arc<NlTaskRegistry>` is managed as Tauri state, not `NlTaskRegistry` directly. Commands access it via `app.state::<Arc<NlTaskRegistry>>().inner().clone()`.
- The `persist_turn` and `persist_llm_metric` helpers are best-effort: they open a new `Connection` each time and swallow errors. This is acceptable for v1 but should be optimized to use a shared connection pool in a future plan.
- `NlChatEvent` is a specta-typed enum, NOT the same as `NlTurnEvent` from the intelligence crate. The forwarder task maps between them.
- The `ipc.ts` bindings file was regenerated automatically by the specta builder during compilation. It is tracked but not manually edited.

## Self-Check: PASSED

File existence:
- `apps/desktop/src-tauri/src/commands/nl.rs` -> FOUND
- `apps/desktop/src-tauri/src/state/nl_tasks.rs` -> FOUND
- `apps/desktop/src-tauri/tests/nl_command_tests.rs` -> FOUND
- `apps/desktop/src-tauri/src/state/mod.rs` -> FOUND

Commits:
- `0fec5e3` (feat 03-07) -> FOUND

Verification:
- `cargo test --test nl_command_tests` -> 18/18 passed
- `cargo test --lib` -> 15/15 passed (1 ignored)

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
