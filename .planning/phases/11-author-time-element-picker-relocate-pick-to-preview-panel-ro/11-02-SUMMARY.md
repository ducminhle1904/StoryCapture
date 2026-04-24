---
phase: 11
plan: 02
subsystem: recording / automation / hud
tags: [recording, executor, self-heal, record-path, hud, error-surface, d-06, d-07]
requirements: [PHASE-11.3, PHASE-11.4, PHASE-11.5]
dependency-graph:
  requires:
    - "10-01: Executor::run_with_story_path parameterization (self_heal bool contract)"
  provides:
    - "AutomationError::PrimaryMissNoHeal typed error variant"
    - "Record-path read-only invariance against .story.targets.json"
    - "HUD destructive block + Sonner toast with 'Open in Simulator' action on record-path primary-miss"
  affects:
    - "apps/desktop/src-tauri/src/commands/automation.rs (launch_automation)"
    - "crates/automation/src/executor.rs (run_with_story_path + wait_actionable_or_heal macro)"
    - "apps/desktop/src/state/recorder.ts (store shape)"
    - "apps/desktop/src/features/recorder/recording-view.tsx (step_failed dispatch)"
    - "apps/desktop/src/features/recorder/hud.tsx (error surface)"
tech-stack:
  added: []
  patterns:
    - "Typed error variant raised behind a self_heal=false gate (Rule 1 — replace silent recovery with surfaced failure)"
    - "Single source-of-truth copy constant shared between HUD + toast to prevent drift"
    - "Renderer-side ordinal clamping before dispatching navigation (T-11-02-03 mitigation)"
key-files:
  created:
    - "apps/desktop/src-tauri/tests/record_path_self_heal_false.rs"
    - "apps/desktop/src/features/recorder/primary-miss-copy.ts"
  modified:
    - "crates/automation/src/error.rs"
    - "crates/automation/src/executor.rs"
    - "crates/automation/tests/self_healing.rs"
    - "apps/desktop/src-tauri/src/commands/automation.rs"
    - "apps/desktop/src/state/recorder.ts"
    - "apps/desktop/src/features/recorder/recording-view.tsx"
    - "apps/desktop/src/features/recorder/hud.tsx"
decisions:
  - "Make self_heal an explicit parameter of Executor::run_with_story_path (legacy Executor::run preserves self_heal=true)"
  - "Raise PrimaryMissNoHeal inside the wait_actionable_or_heal! macro BEFORE try_promote_fallback is called — the record path never consults .story.targets.json"
  - "UI discrimination via substring-match on the locked copy constant (RECORD_PATH_MISS_MARKER) rather than a new typed IPC event — single-commit scope, Rust Display is the single source of truth"
  - "Keep launch_automation's story_path=None — sidecar is irrelevant once self_heal=false gate fires"
metrics:
  duration_minutes: 14
  completed_date: "2026-04-24"
  tasks_completed: 4   # Task 0 checkpoint auto-approved + Tasks 1/2/3
  files_created: 2
  files_modified: 7
---

# Phase 11 Plan 02: Record path read-only + primary-miss surface Summary

Recording runs now treat `.story.targets.json` as strictly read-only:
primary-miss raises a typed `AutomationError::PrimaryMissNoHeal` variant
carrying the UI-SPEC-locked copy, the HUD surfaces a destructive block
with an "Open in Simulator" action, and an integration test proves
byte- and mtime-identical sidecar invariance across a record-path run.

## Outcome Against Must-Haves

| Truth                                                                                                                          | Status                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| launch_automation passes self_heal=false to Executor::run_with_story_path                                                      | ✓ `apps/desktop/src-tauri/src/commands/automation.rs:282-291` — `/* self_heal */ false`                 |
| Primary-miss raises AutomationError::PrimaryMissNoHeal { step_ordinal, step_id, verb }                                         | ✓ `crates/automation/src/error.rs` — variant added with UI-SPEC Display; raised in executor macro      |
| recorder never calls try_promote_fallback                                                                                      | ✓ `executor.rs` short-circuits BEFORE `try_promote_fallback` whenever `self_heal=false`                |
| .story.targets.json byte + mtime identical post-run                                                                            | ✓ `apps/desktop/src-tauri/tests/record_path_self_heal_false.rs::record_path_primary_miss_raises_...`   |
| HUD surfaces D-06 copy verbatim + Open in Simulator action                                                                     | ✓ `hud.tsx` destructive block + Sonner toast in `recording-view.tsx`; copy pulled from single constant |
| Record-flow picker_stamp_step_id call sites removed                                                                            | ✓ grep confirms 0 occurrences in `commands/automation.rs`                                              |

## Architecture Changes

### Executor signature (Task 1)

`Executor::run_with_story_path` gained an explicit `self_heal: bool`
parameter (Phase 10-01 already shipped the flag on `run_simulator` and
threaded it through `run_story`; Phase 11-02 exposes it at the public
surface). `Executor::run` preserves legacy behavior by passing
`self_heal: true`.

```rust
pub fn run_with_story_path(
    story, story_path, primary, fallback, persistence,
    screenshot_dir, launch_opts, control,
    self_heal: bool,   // ← NEW (Phase 11-02)
) -> mpsc::Receiver<ExecutorEvent>
```

### Record-path gate (Task 1)

Inside `run_command`'s `wait_actionable_or_heal!` macro, a
`self_heal=false` check fires BEFORE `try_promote_fallback` is
consulted:

```rust
if !self_heal {
    return Err((
        AutomationError::PrimaryMissNoHeal {
            step_ordinal: ordinal,
            step_id: cmd_step_id,
            verb: format_verb_excerpt(cmd),
        },
        attempts,
    ));
}
```

`format_verb_excerpt` renders `click "Save"`-style strings using the
existing `cmd.verb()` helper plus a target extractor, so the HUD can
display the verb verbatim without re-parsing.

### Record-path call site (Task 2)

`launch_automation` no longer calls the legacy `Executor::run` (which
defaulted self_heal=true). It now invokes
`Executor::run_with_story_path(…, self_heal=false)` with `story_path=None`
— the sidecar path is irrelevant because the `self_heal=false` gate
short-circuits before any sidecar read.

### HUD + toast surface (Task 3)

Error copy lives in a single source-of-truth module
(`apps/desktop/src/features/recorder/primary-miss-copy.ts`) that
exports:

- `RECORD_PATH_MISS_MARKER` — substring discriminant matched against
  `StepFailed.error_message`.
- `RECORD_PATH_MISS_BODY` — the locked body sentence with `{N}`
  placeholder for runtime substitution.
- `parsePrimaryMiss(errorMessage)` — returns `{ verbExcerpt }` or
  `null`.

`recording-view.tsx` routes matching `step_failed` events through
`setPrimaryMiss()` on the recorder store and fires a 12-second Sonner
destructive toast whose `action` slot navigates to
`/editor/:projectId?step=N`. `hud.tsx` reads `primaryMiss` from the
store and renders a destructive region (border-l-4 `--color-danger`,
`AlertTriangle` 16 px, inline mono verb pill, right-aligned
`Open in Simulator →` Link). Ordinal is clamped to positive integers
per threat T-11-02-03 before the navigation dispatches.

## Integration Test

`apps/desktop/src-tauri/tests/record_path_self_heal_false.rs` exercises
the end-to-end record-path gate against an in-process
`AlwaysMissDriver`:

- `record_path_primary_miss_raises_primary_miss_no_heal`:
  asserts `StepFailed.error_message` carries all three UI-SPEC
  phrases ("could not match any element",
  "Self-healing is disabled during recording",
  "Open this story in Simulator") AND that
  `.story.targets.json` bytes + mtime are identical pre- and
  post-run.
- `record_path_does_not_emit_fallback_promotion`:
  asserts no `StepSucceeded` fires — a silent fallback promotion
  would manifest here.

Both pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Plan references `errors.rs` but file is `error.rs`**

- **Found during:** Task 1 — initial Read
- **Fix:** Applied edits to `crates/automation/src/error.rs` (singular).
  The plan's filename references are off; actual file is singular.
- **Files modified:** `crates/automation/src/error.rs`
- **Commit:** fdc7f47

**2. [Rule 3 — Blocking] Plan's proposed call site expected a `story_path` that `launch_automation` does not have**

- **Found during:** Task 2
- **Issue:** Plan's proposed Executor::run_with_story_path code passed
  `Some(story_path.clone())`, but `launch_automation` receives
  `story_source: String` (raw text) with no path. Passing a path would
  be synthetic/meaningless.
- **Fix:** Passed `story_path: None`. Since `self_heal=false` short-
  circuits before any sidecar read, the path is never consulted; the
  invariant (targets.json byte-identical) holds.
- **Files modified:** `apps/desktop/src-tauri/src/commands/automation.rs`
- **Commit:** b5dc434

**3. [Rule 2 — Missing critical functionality] `try_promote_fallback` would still run on self_heal=false, violating the must_have**

- **Found during:** Task 1
- **Issue:** Pre-Phase-11 comment explicitly kept the fallback probe
  running regardless of `self_heal` so the simulator could surface
  `match_kind=Fuzzy` in read-only runs. Plan's must_haves forbid
  `try_promote_fallback` on the record path. The simulator now needs
  to pass `self_heal=true` to retain Fuzzy surfacing (existing code
  paths respect that; this plan does not touch them).
- **Fix:** In `wait_actionable_or_heal!`, raise `PrimaryMissNoHeal`
  BEFORE `try_promote_fallback` is called whenever `self_heal=false`.
- **Files modified:** `crates/automation/src/executor.rs`
- **Commit:** fdc7f47

**4. [Rule 3 — Blocking] Desktop test build fails because sidecar binaries are missing**

- **Found during:** Task 2 — first test compile
- **Issue:** `apps/desktop/src-tauri/build.rs` requires
  `binaries/ffmpeg-aarch64-apple-darwin` and
  `binaries/playwright-sidecar-aarch64-apple-darwin` + the
  `binaries/playwright-sidecar-modules/` resource dir; without them
  no desktop test can build. These are declared in `.gitignore` and
  populated by packaging scripts.
- **Fix:** Created 10-byte shell-script stubs for both sidecar binaries
  and a `.gitkeep` inside `binaries/playwright-sidecar-modules/`.
  None of these files are tracked by git (they match `.gitignore`
  patterns), and they're unused at test time — only the build-script
  file-existence check reads them.
- **Files modified:** None committed (all gitignored)
- **Commit:** (not applicable — dev-only build fixtures)

**5. [Rule 3 — Blocking] Rust 2021 raw-string edge case in test fixture**

- **Found during:** Task 2 — second compile
- **Issue:** `r#"... "#value" ..."#` conflicted with the Rust 2021
  reserved `#identifier` prefix syntax.
- **Fix:** Switched to `r##" ... "##` delimiters.
- **Files modified:** `apps/desktop/src-tauri/tests/record_path_self_heal_false.rs`
- **Commit:** b5dc434

### Design Choices

**Discriminator strategy for PrimaryMissNoHeal events (Task 3).** The
plan preferred typed discrimination but the existing `AutomationEvent`
IPC only forwards `error_message: String`. Rather than broaden the IPC
surface, Phase 11-02 discriminates via substring-match on
`RECORD_PATH_MISS_MARKER` — safe because the Rust Display string is
the single source of truth (tested in
`record_path_primary_miss_raises_primary_miss_no_heal`). A future
plan can add a typed error-kind enum to the IPC without changing the
HUD behavior; the constant isolates the drift surface to one file.

## Commits

| Task | Commit  | Description                                                                            |
| ---- | ------- | -------------------------------------------------------------------------------------- |
| 0    | n/a     | Phase 10-01 signature merged (14 self_heal matches in executor.rs); auto-approved      |
| 1    | fdc7f47 | feat(11-02): add AutomationError::PrimaryMissNoHeal + self_heal=false gate             |
| 2    | b5dc434 | feat(11-02): flip record path to self_heal=false + invariance test                     |
| 3    | 4377f7f | feat(11-02): HUD record-path primary-miss block + Open in Simulator action             |

## Verification Transcript

```
cargo test -p automation --lib
→ 61 passed; 0 failed (Task 1 gate)

cargo test -p storycapture --test record_path_self_heal_false
→ 2 passed; 0 failed (Task 2 gate)

pnpm --filter @storycapture/desktop typecheck
→ exit 0 (Task 3 gate)

grep -c "self_heal" apps/desktop/src-tauri/src/commands/automation.rs
→ 4  (≥ 1 required)

grep -c "picker_stamp_step_id" apps/desktop/src-tauri/src/commands/automation.rs
→ 0  (= 0 required)

grep -c "Open in Simulator" apps/desktop/src/features/recorder/hud.tsx
→ 4  (≥ 2 required; button label + 3 doc comments)

grep -rl "Self-healing is disabled during recording" apps/desktop/src/
→ single hit: features/recorder/primary-miss-copy.ts
  (constant lives in exactly one file — no drift risk)
```

## Threat Flags

No new threat surface introduced outside the plan's existing
`<threat_model>`. The HUD ordinal clamp (T-11-02-03 mitigation) is
implemented; the HUD rejects the navigation when
`Number.isInteger(ordinal) && ordinal >= 1` is false.

## Self-Check: PASSED

- File `crates/automation/src/error.rs`: FOUND (PrimaryMissNoHeal variant present).
- File `crates/automation/src/executor.rs`: FOUND (self_heal param + format_verb_excerpt helper).
- File `apps/desktop/src-tauri/tests/record_path_self_heal_false.rs`: FOUND.
- File `apps/desktop/src/features/recorder/primary-miss-copy.ts`: FOUND.
- File `apps/desktop/src/features/recorder/hud.tsx`: FOUND (destructive block present).
- Commit fdc7f47: FOUND.
- Commit b5dc434: FOUND.
- Commit 4377f7f: FOUND.
