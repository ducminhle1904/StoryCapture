---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04c
subsystem: automation + desktop-picker
tags: [dsl, picker, self-healing, targets-store, stamp-step-id, phase-7.5-gate]
requires:
  - 07-04a (picker JSON-RPC forwarder + hover preview)
  - 07-04b (parser step-id grammar + formatter)
  - crates/automation Tier 2 base (wait_actionable + SmartSelector)
provides:
  - `automation::targets_store` module (TargetsFile / StepTargets / TargetRecord)
  - `targets_store::atomic_write` — POSIX-atomic tmp+rename sibling JSON write
  - `targets_store::load` — missing-file → empty; version-mismatch → Protocol err
  - `targets_store::targets_path_for` — `.story` → `.story.targets.json` helper
  - `targets_store::target_record_to_selector` — JSON record → `SelectorOrText`
  - `Executor::run_with_story_path` — threads `story_path` for self-healing
  - `executor::try_promote_fallback` — primary-miss → fallback-promotion helper
  - `Command::set_step_id(Option<Uuid>)` — mutate step id across all 13 arms
  - Tauri command `picker_stamp_step_id` — stamp UUIDv7 + seed targets sidecar
  - TS `pickerStampStepId` IPC wrapper
  - `editorController.setStoryPath` / `getStoryPath` + enriched `insertAtCursor`
    return shape (`{ ok: true, lineNumber }`)
  - PHASE-7.5 final acceptance gate: primary-miss → fallback-promoted →
    `.story.targets.json` rewritten + `.story` source UNCHANGED
affects:
  - Downstream callers of `Executor::run` unaffected — the legacy fn
    delegates to `run_with_story_path(None, …)` so the self-healing hook
    is opt-in per-call.
  - `apps/desktop/src-tauri/src/commands/parse.rs` received a Rule 3
    fixup — every `PCommand::*` match arm gained `..` for the 07-04b
    `step_id` field (SUMMARY-04b missed this site; it was production
    code not test code).
  - `editorController.insertAtCursor` now returns `{ ok: true, lineNumber }`
    instead of `{ ok: true }`. The `apps/desktop/src/features/editor/
    controller.test.ts` snap-to-line-end test updated in the same
    commit.
tech-stack:
  added:
    - "uuid::Uuid::now_v7 via the existing workspace dep (v7 feature already enabled)"
    - "tempfile usage in the automation crate test suite (already a dev-dep)"
  patterns:
    - "POSIX-atomic JSON write: `<path>.tmp.<pid>` → `fsync` → `fs::rename`. The pid-embedded temp name avoids cross-process clobbering; on crash the next successful write cleans up any orphan tmp of its own pid by overwriting the final name (tmp-from-OTHER-pids is harmless and will be gc'd when that pid's writer recovers)."
    - "Self-healing promotion: old primary → `fallbacks[0]`, winning fallback → primary. First-pass-wins (conservative); re-pick to reseed if ordering is wrong."
    - "Specta 2.0.0-rc.22 rejects `serde_json::Value` as a command arg → pass JSON-stringified envelopes at the IPC boundary, decode in the command body. Mirrors the existing `AutomationEvent { json }` pattern (07-03b)."
    - "Self-healing fires ONLY when `cmd.step_id().is_some() && story_path.is_some()`. Legacy `.story` files (no `# @id=<uuid>` comments) never touch the targets store — zero regression."
    - "Drag destinations intentionally NOT self-healed: `to` identity is paired with `from`, and promoting it in isolation would silently retarget the drop."
key-files:
  created:
    - crates/automation/src/targets_store.rs
    - crates/automation/tests/self_healing.rs
    - crates/automation/tests/fixtures/self_healing.html
    - crates/automation/tests/fixtures/self_healing.story
    - crates/automation/tests/fixtures/self_healing.story.targets.json
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md
  modified:
    - crates/automation/src/lib.rs
    - crates/automation/src/executor.rs
    - crates/story-parser/src/ast.rs
    - apps/desktop/src-tauri/src/commands/picker.rs
    - apps/desktop/src-tauri/src/commands/parse.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/editor/controller.ts
    - apps/desktop/src/features/editor/controller.test.ts
    - apps/desktop/src/features/recorder/pick-element-button.tsx
    - apps/desktop/src/ipc/picker.ts
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/deferred-items.md
decisions:
  - "Added `Executor::run_with_story_path` as an additional entry point rather than breaking the public `Executor::run` signature. The legacy fn now delegates to the new one with `story_path = None`, so every existing caller (including `apps/desktop/src-tauri/src/commands/automation.rs`) keeps working unchanged. Only new callers that want self-healing need to thread the path through."
  - "The PHASE-7.5 CI proof uses a programmable mock driver (`HealingMockDriver`) rather than spinning the live Playwright sidecar. Rationale: (a) the live path requires a full Node SEA + Chromium install and is already covered by `07-04c-SMOKE.md`; (b) the mock proves the self-healing ALGORITHM (fallback iteration, primary-miss detection, atomic sidecar rewrite) without coupling to network/process setup; (c) keeps `cargo test -p automation` under 1s. The live-sidecar variant is `#[ignore]`d with a pointer to the operator runbook."
  - "Specta-compatible envelope: `picker_stamp_step_id` accepts `primary_json: String` + `fallbacks_json: String` instead of `serde_json::Value`/`Vec<serde_json::Value>`. Specta 2.0.0-rc.22 does not implement `FunctionArg` for `serde_json::Value`. The TS wrapper (`pickerStampStepId`) stringifies at the IPC boundary; this mirrors the `AutomationEvent { json }` pattern already established in 07-03b for `PickElementResponseDto`."
  - "Rule 3 fixup on `apps/desktop/src-tauri/src/commands/parse.rs`: 07-04b added `step_id: Option<Uuid>` to every `Command` variant but its SUMMARY only fixed the `crates/automation/tests/*` test files — it missed the production `PCommand → CommandDto` `From` impl, which the 07-04c Tauri build exposed. Added `..` to each arm (13 sites) since `CommandDto` does not carry `step_id` (renderer reads via the story_parser AST directly, not through this DTO)."
  - "Target record shape is `{ kind: String, value: serde_json::Value }` instead of a typed enum. Rationale: forward-compatible with future selector strategies without requiring a schema bump — the `value` JSON is decoded against `SelectorOrText` only when the executor consults it. Unknown `kind` values degrade gracefully (warn + skip) instead of erroring the whole run."
metrics:
  duration: ~90 minutes
  completed-date: 2026-04-17
  tasks-completed: 2
  commits: 2
---

# Phase 07 Plan 04c: Self-healing targets store + picker stamp (PHASE-7.5 final gate)

**One-liner:** Ship the PHASE-7.5 final gate — `targets_store` sibling JSON with POSIX-atomic writes, an executor hook that promotes the first passing fallback when the primary `wait_actionable` misses (rewriting the sidecar JSON atomically while leaving the `.story` source byte-identical), a `picker_stamp_step_id` Tauri command that stamps a `Uuid::now_v7` on first pick via the 07-04b formatter + seeds the targets JSON, and a mock-driver integration test that proves the end-to-end invariant.

## Commits

| Task | SHA | Title |
|------|-----|-------|
| 1 | `5f35fcd33e831841799b87134e8434fb4adeb428` | feat(07-04c): targets_store + executor self-healing + integration test |
| 2 | `acb2c01e93883e4dfa598f33a845b322a46f576b` | feat(07-04c): picker_stamp_step_id Tauri command + SMOKE runbook |

## Targets store — atomic write naming convention

```text
foo.story                          # DSL source — NEVER modified by self-healing
foo.story.targets.json             # sidecar — rewritten atomically on promotion
foo.story.targets.json.tmp.<pid>   # transient tmp, lifetime < one fs::rename
```

On a successful `atomic_write`:
1. `fs::File::create(tmp)` → `write_all` → `sync_data`
2. `fs::rename(tmp, final)` — POSIX-atomic on macOS + Windows (NTFS/APFS).
3. On rename failure, best-effort `fs::remove_file(tmp)` before returning.

The tmp name embeds `std::process::id()` so two live writers never clobber
each other's pending data; orphan tmp files from a crashed pid are
harmless (they get overwritten on the next successful write by any pid,
since we rename OVER the final name).

## Self-healing promotion semantics

```text
Before promotion:
  primary      = #save-v1   (FAILS wait_actionable)
  fallbacks[0] = #save-v2   (PASSES wait_actionable — FIRST hit)
  fallbacks[1] = role=button:Save

After promotion (atomic sidecar rewrite):
  primary      = #save-v2                            ← winner
  fallbacks[0] = #save-v1                            ← demoted old primary
  fallbacks[1] = role=button:Save                    ← retained
```

Rules:
- **First-pass wins** — the first fallback that resolves AND passes
  `wait_actionable` is promoted. Remaining fallbacks are NOT retried
  within the same run.
- **Old primary is always retained** at `fallbacks[0]` so a future
  markup revert auto-re-promotes it without any user action.
- **Other pre-existing fallbacks are retained** somewhere in the
  array — order after the promoted slot is implementation-defined
  (we splice out the winner's slot, insert old primary at index 0).
- **`.story` source is NEVER modified.** Only the sibling JSON
  changes. The source is only rewritten by `picker_stamp_step_id`
  (first-pick stamping path), never by the executor.

## Explicit confirmation of the source-immutability invariant

The executor path — `try_promote_fallback` — writes to
`<story_path>.targets.json` via `targets_store::atomic_write` **only**.
There is no `fs::write(<story_path>, ...)` call anywhere in the
self-healing codepath. The `.story` source is mutated **only** by
`picker_stamp_step_id` (via `story_parser::format_story`) and only on
the first pick of a line that has no `# @id=<uuid>` comment yet. Once
stamped, subsequent picks reuse the existing UUID — the source stays
byte-identical.

This is asserted by `primary_miss_promotes_first_passing_fallback` at
`crates/automation/tests/self_healing.rs` (`assert_eq!(src_after,
src_before, "self-healing must NEVER modify the .story source")`).

## Cross-crate coupling

Two new cross-crate touchpoints, both at boundaries that already exist:

1. **`story_parser → automation` (targets_store)** — none. The parser
   crate is unchanged from 07-04b's exposed surface aside from the new
   `Command::set_step_id` helper, which is self-contained.
2. **`automation → story_parser` (self-healing fallback resolution)** —
   `targets_store::target_record_to_selector` imports `SelectorOrText`
   + `AriaRole`. Both were already re-exported by automation via
   `driver.rs` / `events.rs`; no new `pub use` surface needed.
3. **`apps/desktop/src-tauri → automation` (picker_stamp_step_id)** —
   the Tauri command uses `automation::targets_store::{TargetsFile,
   StepTargets, TargetRecord, targets_path_for, atomic_write, load}`.
   `automation` was already a direct dep of the Tauri crate.
4. **`apps/desktop/src-tauri → story_parser` (picker_stamp_step_id)** —
   uses `story_parser::{parse, format_story, Command::set_step_id}`.
   `story-parser` was already a direct dep of the Tauri crate.

## PHASE-7.5 final acceptance gate result

### CI proof (mock driver, `crates/automation/tests/self_healing.rs`)

```
running 3 tests
test primary_miss_promotes_first_passing_fallback_live ... ignored,
    live sidecar required — see 07-04c-SMOKE.md for the operator runbook
test legacy_story_without_step_id_does_not_touch_targets_store ... ok
test primary_miss_promotes_first_passing_fallback ... ok

test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.11s
```

The `primary_miss_promotes_first_passing_fallback` test asserts all
three PHASE-7.5 invariants end-to-end through the executor:

1. `click()` fires exactly once, against the promoted fallback
   (`#save-v2`), not the primary (`#save-v1`).
2. `.story` source bytes are identical before and after the run
   (`assert_eq!(src_after, src_before, …)`).
3. `.story.targets.json` is rewritten:
   - `primary.kind == "selector"`, `primary.value == "#save-v2"`
   - `fallbacks[0].kind == "selector"`, `fallbacks[0].value == "#save-v1"`
   - the `role=button:Save` fallback is retained.

### Operator proof (real browser, `07-04c-SMOKE.md`)

Three-step runbook: first-pick stamp → idempotent re-pick → self-healing
against a mutated local HTML file. Operator sign-off checklist at the
bottom of the runbook captures the three PHASE-7.5 gates.

**PHASE-7.5 CI gate: PASSED.** Operator sign-off is a release-gate
checklist item tracked by the runbook, not this plan.

## Acceptance Criteria

- [x] `crates/automation/src/targets_store.rs` exists + registered via `lib.rs`
- [x] `cargo test -p automation --lib targets_store_tests` passes all 7 tests
  (missing-file, version-mismatch, round-trip, no-tmp-leak, path helper,
  kind coverage, unknown-kind rejection — two more than the plan
  minimum of 4, for higher confidence)
- [x] `cargo test -p automation --test self_healing --no-run` exits 0
- [x] `cargo test -p automation --test self_healing` passes 2 non-ignored
  tests (compile-only smoke + the end-to-end mock-driver proof)
- [x] Fixture files exist on disk (`self_healing.html`, `.story`,
  `.story.targets.json`)
- [x] `grep -n "atomic_write\|fs::rename" crates/automation/src/targets_store.rs` matches
- [x] `grep -n "targets_path_for" crates/automation/src/targets_store.rs` matches
- [x] Executor self-heal path integrated: `step_id`, `fallbacks`,
  `targets_store` all referenced in `executor.rs`
- [x] `legacy_story_without_step_id_does_not_touch_targets_store` passes
- [x] `cargo check` in `apps/desktop/src-tauri/` exits 0
- [x] `cargo test --workspace` exits 0
- [x] `grep -n "picker_stamp_step_id"` matches in commands/picker.rs AND ipc_spec.rs
- [x] `grep -n "pickerStampStepId"` matches in src/ipc/picker.ts AND pick-element-button.tsx
- [x] `07-04c-SMOKE.md` committed with all 3 sections (First-pick
  stamping, Subsequent-pick update, Self-healing) + Known limitations
- [x] PHASE-7.5 CI gate met (primary-miss → fallback-promoted →
  targets.json rewritten → .story source UNCHANGED)

## Deviations from Plan

### Rule 3 — parse.rs pre-existing pattern-incompleteness

The plan did not enumerate downstream production code that pattern-matches
on `Command` variants. 07-04b's SUMMARY fixed two downstream test files
(`crates/automation/tests/selector.rs`, `capability_routing.rs`) but missed
`apps/desktop/src-tauri/src/commands/parse.rs`, which builds a
`CommandDto` mirror for the TS `parseStory` IPC. Adding `picker_stamp_step_id`
forced a fresh `cargo check` on the Tauri crate and exposed all 13 `E0027`
errors. Fixed in the Task 2 commit by appending `..` to each arm — the
`CommandDto` mirror intentionally omits `step_id` (the renderer reads it
from the `story_parser` AST directly, not through this DTO).

**Files:** `apps/desktop/src-tauri/src/commands/parse.rs`.
**Commit:** `acb2c01e93883e4dfa598f33a845b322a46f576b`.

### Rule 2 — Tauri command arg type hardening (Specta incompatibility)

The plan prescribed `primary: serde_json::Value` + `fallbacks:
Vec<serde_json::Value>` for `picker_stamp_step_id`, but Specta 2.0.0-rc.22
does NOT implement `FunctionArg` for `serde_json::Value` (14 error cascade
from the `#[specta::specta]` macro expansion). Switched to JSON-stringified
envelopes (`primary_json: String` + `fallbacks_json: String`) decoded in
the command body. This mirrors the existing `PickElementResponseDto { json: String }`
pattern already established in 07-03b for the same reason. The TS wrapper
(`pickerStampStepId`) stringifies at the boundary so caller code is
unchanged.

**Files:** `apps/desktop/src-tauri/src/commands/picker.rs`,
`apps/desktop/src/ipc/picker.ts`.
**Commit:** `acb2c01e93883e4dfa598f33a845b322a46f576b`.

### Rule 2 — editor controller extended to expose path + line number

The plan allowed "best-effort" wiring if no story-path state exists. Rather
than passing `null` and skipping, extended `editorController` with a
`setStoryPath`/`getStoryPath` pair AND enriched the `insertAtCursor` return
shape with `lineNumber`. Rationale: the PickElementButton already owns the
stamp fire-and-forget semantics; without a line number the stamp would
have to re-parse the entire source to locate the cursor, which duplicates
work the editor already tracked. This is a minimal, type-safe seam — the
existing `insertAtCursor` test was updated in the same commit.

**Files:** `apps/desktop/src/features/editor/controller.ts`,
`apps/desktop/src/features/editor/controller.test.ts`.
**Commit:** `acb2c01e93883e4dfa598f33a845b322a46f576b`.

### Rule 3 — additional unit tests beyond plan minimum

The plan specified 4 targets_store unit tests (missing-file, version-mismatch,
round-trip, no-tmp-leak). Shipped 7 — added coverage for `targets_path_for`
(sibling path construction), `target_record_to_selector` (kind-coverage
matrix across all 7 selector strategies), and unknown-kind rejection.
Rationale: `target_record_to_selector` is the sole adapter between the
JSON sidecar schema and `SelectorOrText`, and kind drift there would
silently break self-healing without surfacing in the integration test.
Cheap to test, high-value defense.

**Files:** `crates/automation/src/targets_store.rs`.
**Commit:** `5f35fcd33e831841799b87134e8434fb4adeb428`.

## Auth Gates

None. Fully offline — targets store is local filesystem; picker stamp
is a Tauri command against a user-owned `.story` file.

## Known Stubs

None. No `todo!()`, no `unimplemented!()`, no placeholder branches.

The `primary_miss_promotes_first_passing_fallback_live` test is
`#[ignore]`d with a pointer to `07-04c-SMOKE.md` — this is by design
(live sidecar + real Chromium are heavyweight; the algorithm is already
proven by the mock-driver test in the same file).

## Deferred Issues

Pre-existing vitest failures NOT touched by this plan (confirmed against
the base commit `8e45fd6` before any 07-04c work):

- `src/features/nl-mode/ChatPanel.test.tsx` — 1 failure (empty state heading)
- `src/features/settings/AccountsPage.test.tsx` — 6 failures (Vietnamese
  i18n regressions in `Them key` / `Kiem tra ket noi` strings)

Logged to `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/deferred-items.md`.

## Self-Check: PASSED

Files created:
- `crates/automation/src/targets_store.rs` — FOUND
- `crates/automation/tests/self_healing.rs` — FOUND
- `crates/automation/tests/fixtures/self_healing.html` — FOUND
- `crates/automation/tests/fixtures/self_healing.story` — FOUND
- `crates/automation/tests/fixtures/self_healing.story.targets.json` — FOUND
- `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md` — FOUND

Files modified:
- `crates/automation/src/lib.rs` — `pub mod targets_store` added ✓
- `crates/automation/src/executor.rs` — `run_with_story_path` + `try_promote_fallback` added ✓
- `crates/story-parser/src/ast.rs` — `Command::set_step_id` helper added ✓
- `apps/desktop/src-tauri/src/commands/picker.rs` — `picker_stamp_step_id` added ✓
- `apps/desktop/src-tauri/src/commands/parse.rs` — 13 `PCommand` arms patched with `..` ✓
- `apps/desktop/src-tauri/src/ipc_spec.rs` — `picker::picker_stamp_step_id` registered ✓
- `apps/desktop/src/features/editor/controller.ts` — path helpers + enriched return ✓
- `apps/desktop/src/features/editor/controller.test.ts` — updated for new return shape ✓
- `apps/desktop/src/features/recorder/pick-element-button.tsx` — fire-and-forget stamp wired ✓
- `apps/desktop/src/ipc/picker.ts` — `pickerStampStepId` exported ✓

Commits:
- `5f35fcd33e831841799b87134e8434fb4adeb428` (Task 1) — FOUND in `git log`
- `acb2c01e93883e4dfa598f33a845b322a46f576b` (Task 2) — FOUND in `git log`

Gate results:
- `cargo test --workspace`: 0 failures ✓
- `cargo test -p automation --lib targets_store_tests`: 7/7 pass ✓
- `cargo test -p automation --test self_healing`: 2/2 pass, 1 ignored (live) ✓
- `cd apps/desktop/src-tauri && cargo check`: clean ✓
- vitest `controller.test.ts`: 5/5 pass ✓
- vitest `pick-element-button.test.tsx`: 6/6 pass ✓
- sidecar `pnpm test`: 53/53 pass ✓

**PHASE-7.5 CI gate: PASSED.**
