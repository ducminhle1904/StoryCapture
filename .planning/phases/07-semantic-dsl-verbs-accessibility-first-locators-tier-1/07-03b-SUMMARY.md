---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 03b
subsystem: desktop-ui
tags: [dsl, picker, codemirror, tauri-ipc, desktop-ui]
requires: [07-03a]
provides:
  - "crates/automation/src/playwright_driver.rs — PickElementResponse enum (Picked { emitted: String, locator, candidates } | Cancelled { reason })"
  - "PlaywrightSidecarDriver::pick_element_start/cancel/is_active JSON-RPC wrappers"
  - "apps/desktop/src-tauri/src/commands/picker.rs — picker_start / picker_cancel / picker_is_active Tauri commands"
  - "apps/desktop/src/ipc/picker.ts — typed PickResult union + isPicked guard + 3 wrappers"
  - "apps/desktop/src/features/editor/controller.ts — editorController module-level singleton"
  - "apps/desktop/src/features/recorder/pick-element-button.tsx — toolbar entry point + aria-live banner"
affects:
  - "apps/desktop/src-tauri/src/state/mod.rs — adds SharedPlaywrightDriverHandle slot"
  - "apps/desktop/src-tauri/src/commands/automation.rs — publishes/clears the shared driver around story execution"
  - "apps/desktop/src-tauri/src/commands/mod.rs + ipc_spec.rs — registers picker commands + DTO type"
  - "apps/desktop/src/features/editor/story-editor.tsx — registers the active EditorView with the controller"
  - "apps/desktop/src/features/recorder/recording-view.tsx — mounts PickElementButton in the live-recording toolbar"
  - "crates/automation/src/{capability,selector,playwright_driver}.rs — adds Tier 1 SelectorOrText pattern arms so the workspace compiles (forward-compat stubs; 07-02 owns the proper landing — see deferred-items.md)"
  - "apps/desktop/src-tauri/src/commands/parse.rs — extends SelectorOrTextDto with Tier 1 variants"
tech-stack:
  added: []
  patterns:
    - "Module-level singleton with EditorView ref (NOT Zustand) — controller.ts"
    - "Atomic-undo via single view.dispatch + userEvent: 'input.pick'"
    - "JSON-string DTO at the IPC boundary so the pure automation crate stays free of Tauri/specta deps (D-07)"
    - "Tauri @tauri-apps/api/mocks mockIPC for end-to-end wire-contract assertion"
key-files:
  created:
    - "apps/desktop/src-tauri/src/commands/picker.rs"
    - "apps/desktop/src/ipc/picker.ts"
    - "apps/desktop/src/features/editor/controller.ts"
    - "apps/desktop/src/features/editor/controller.test.ts"
    - "apps/desktop/src/features/recorder/pick-element-button.tsx"
    - "apps/desktop/src/features/recorder/pick-element-button.test.tsx"
    - ".planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03b-SMOKE.md"
    - ".planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/deferred-items.md"
  modified:
    - "crates/automation/src/playwright_driver.rs"
    - "crates/automation/src/lib.rs"
    - "crates/automation/src/capability.rs"
    - "crates/automation/src/selector.rs"
    - "apps/desktop/src-tauri/src/commands/automation.rs"
    - "apps/desktop/src-tauri/src/commands/mod.rs"
    - "apps/desktop/src-tauri/src/commands/parse.rs"
    - "apps/desktop/src-tauri/src/ipc_spec.rs"
    - "apps/desktop/src-tauri/src/state/mod.rs"
    - "apps/desktop/src/features/editor/story-editor.tsx"
    - "apps/desktop/src/features/recorder/recording-view.tsx"
decisions:
  - "Wire-contract field name: PickElementResponse::Picked.emitted: String — matches sidecar 07-03a server.mjs:414 byte-for-byte. Grep-guarded; renaming breaks the picker UI flow."
  - "PickElementResponseDto envelope (JSON-string) at the Tauri boundary so the pure-Rust automation crate stays free of Tauri/specta deps (D-07). Mirrors the AutomationEvent { json } pattern."
  - "AppState gains a SharedPlaywrightDriverHandle slot (Arc<TokioMutex<Option<Arc<Mutex<PlaywrightSidecarDriver>>>>>). launch_automation publishes the in-flight driver; the picker_* commands route to the SAME instance because the overlay is injected at addInitScript / launch time and can't be re-installed mid-session by a fresh sidecar."
  - "AppState dropped Debug derive — PlaywrightSidecarDriver owns process handles and has no Debug impl."
  - "editorController is a module-level singleton, NOT a Zustand store. React refs in stores don't trigger re-renders and bloat the store surface; for a single imperative target, a module is the correct seam."
  - "Insertion semantics: ONE view.dispatch with userEvent: 'input.pick' = ONE undo entry. Snap mid-line cursors to line-end before insert. Caller (PickElementButton) appends '\\n' to r.emitted."
  - "Test environment is happy-dom (project default per vitest.config.ts), NOT jsdom — plan suggested jsdom but jsdom is not installed. The test imports work identically; happy-dom supports CodeMirror's DOM operations and createPortal for the banner test."
  - "PickElementButton sessionLive predicate uses status === 'recording' || 'paused' (no 'idle-ready' state exists in the recorder store)."
metrics:
  duration_minutes: 18
  tasks_completed: 3
  tests_added: 14   # 5 Rust serde + 5 controller + 4 button
  files_added: 8
  files_modified: 11
  completed_date: "2026-04-17"
---

# Phase 7 Plan 03b: Element-picker desktop wiring — Summary

Desktop-side Tier 2 MVP shipped. The full picker loop is closed end-to-end:
the user clicks **Pick element** in the live-recording toolbar, the
PlaywrightSidecarDriver issues `pickElement.start`, the sidecar's overlay
captures one click, the ranked DSL generator returns `{ emitted, locator,
candidates }`, the desktop deserializes it (matching 07-03a's wire field
names byte-for-byte), and `editorController.insertAtCursor(emitted + "\n")`
writes one atomic-undo line into the active CodeMirror view.

PHASE-7.4 acceptance gate is met by the desktop vitest at
`apps/desktop/src/features/recorder/pick-element-button.test.tsx` (case
"happy path: emitted DSL is inserted at cursor with trailing newline").
That test mocks the Tauri `picker_start` invoke to return the sidecar's
contracted shape and asserts `editorController.insertAtCursor` is called
with `'click button "Save"\n'` — exactly the sidecar's `emitted` field
plus the appended newline. This proves the 07-03a → 07-03b wire holds
end-to-end without a live sidecar.

## Files added / modified

| File | Status | Purpose |
|---|---|---|
| `crates/automation/src/playwright_driver.rs` | modified | `PickElementResponse` enum + `PickLocator` + `PickCandidate` + 3 driver methods + 5 serde tests |
| `crates/automation/src/lib.rs` | modified | re-export new types |
| `crates/automation/src/capability.rs` | modified | Tier 1 SelectorOrText pattern arms (forward-compat) |
| `crates/automation/src/selector.rs` | modified | Tier 1 explicit-strategy stubs (forward-compat) |
| `apps/desktop/src-tauri/src/commands/picker.rs` | new | `picker_start` / `cancel` / `is_active` Tauri commands + `PickElementResponseDto` |
| `apps/desktop/src-tauri/src/commands/automation.rs` | modified | publishes / clears shared driver in AppState |
| `apps/desktop/src-tauri/src/commands/mod.rs` | modified | registers picker module |
| `apps/desktop/src-tauri/src/commands/parse.rs` | modified | extends `SelectorOrTextDto` for Tier 1 variants |
| `apps/desktop/src-tauri/src/ipc_spec.rs` | modified | registers picker commands + DTO type |
| `apps/desktop/src-tauri/src/state/mod.rs` | modified | `SharedPlaywrightDriverHandle` slot in AppState |
| `apps/desktop/src/ipc/picker.ts` | new | typed `PickResult` union + `isPicked` + 3 wrappers |
| `apps/desktop/src/features/editor/controller.ts` | new | module-level `editorController` singleton |
| `apps/desktop/src/features/editor/controller.test.ts` | new | 5 vitest assertions incl. single-undo proof |
| `apps/desktop/src/features/editor/story-editor.tsx` | modified | registers the EditorView via useEffect |
| `apps/desktop/src/features/recorder/pick-element-button.tsx` | new | toolbar button + portal aria-live banner + Esc handler |
| `apps/desktop/src/features/recorder/pick-element-button.test.tsx` | new | 4 vitest cases incl. PHASE-7.4 final gate |
| `apps/desktop/src/features/recorder/recording-view.tsx` | modified | mounts `<PickElementButton />` in the live-recording toolbar |
| `.planning/phases/.../07-03b-SMOKE.md` | new | manual runbook (happy + 5 cancellation paths + undo + limitations) |
| `.planning/phases/.../deferred-items.md` | new | Tier 1 forward-compat stubs to be properly landed by 07-02 |

## Test runs

### Cargo (`cargo test --workspace`)

```
test playwright_driver::pick_element_serde_tests::cancelled_navigation ... ok
test playwright_driver::pick_element_serde_tests::cancelled_unsupported_url ... ok
test playwright_driver::pick_element_serde_tests::picked_response_deserializes_testid ... ok
test playwright_driver::pick_element_serde_tests::cancelled_user ... ok
test playwright_driver::pick_element_serde_tests::picked_response_deserializes_role_object_value ... ok
```

5/5 serde round-trip tests covering testid, role-object-value, navigation,
user-cancel, unsupported-url. Workspace-wide cargo test passes (no
regressions; storage / encoder / story-parser / etc. all clean).

### Desktop vitest — controller (`pnpm exec vitest run controller.test.ts`)

```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

5 cases:
1. `isReady()` false when no view registered
2. `insertAtCursor` returns `{ ok: false, reason: "no-view" }` without throwing when not ready
3. snap-to-line-end on a mid-line cursor (insert lands at line-end, not cursor offset)
4. **SINGLE undo entry** — `undo()` restores doc to original (atomicity proof)
5. two consecutive inserts produce two undo entries (LIFO)

### Desktop vitest — pick-element-button (`pnpm exec vitest run pick-element-button.test.tsx`)

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

4 cases:
1. disabled when `recorder.status` is not live (`idle`)
2. **PHASE-7.4 GATE** — mocked `picker_start` returns `{ emitted: 'click button "Save"', ... }` → `editorController.insertAtCursor` called once with `'click button "Save"\n'`
3. cancelled response (`{ cancelled: true, reason: "user-cancel" }`) → `editorController.insertAtCursor` NOT called
4. `role="status"` `aria-live="polite"` banner mounts during pick + unmounts after settle

### Desktop vitest — full suite (`pnpm exec vitest run`)

```
 Test Files  2 failed | 19 passed (21)
      Tests  7 failed | 142 passed (149)
```

The 7 failures live in `src/features/nl-mode/ChatPanel.test.tsx` (1 fail)
and `src/features/settings/AccountsPage.test.tsx` (6 fail). These
**pre-existed** — confirmed by stashing the 07-03b changes and re-running
the same two test files: same 7 failures. Out of scope per the plan's
scope-boundary rule; logged for follow-up.

## PHASE-7.4 acceptance gate — confirmation

> User-observable: "pick element → DSL appears at cursor"

- [x] `picker_start` Tauri command returns `PickElementResponseDto { json }` from the in-flight sidecar driver
- [x] TS `pickElement()` parses the inner JSON into the typed `PickResult` union (`PickPicked | PickCancelled`)
- [x] `PickElementButton.onClick` calls `editorController.insertAtCursor(r.emitted + "\n")` on the `Picked` arm
- [x] vitest end-to-end (mocked sidecar) asserts the wire-contract `emitted` field flows verbatim to the editor with the appended newline
- [x] Cancellation paths (user-cancel, navigation, unsupported-url, timeout) each surface a distinct toast and skip insertion
- [x] `editorController.insertAtCursor` is provably single-undo (controller test #4)

The Rust `PickElementResponse::Picked.emitted: String` field name matches
the sidecar wire field byte-for-byte
(`scripts/playwright-sidecar/server.mjs:414` per 07-03a SUMMARY). The
`grep -c "emitted: String" crates/automation/src/playwright_driver.rs`
guard returns `3` (one in the enum definition, two in the test pattern
matches).

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 — Blocking] Tier 1 SelectorOrText variants broke `automation` crate compilation**

- **Found during:** Task 1 first `cargo build -p automation`
- **Issue:** `crates/story-parser/src/ast.rs` exports
  `SelectorOrText::{Role, Label, TextExact}` (Tier 1 — landed but
  forward-compat stubs in downstream crates were never added). Five match
  sites in `crates/automation/src/{capability,selector,playwright_driver}.rs`
  and one in `apps/desktop/src-tauri/src/commands/parse.rs` failed E0004
  non-exhaustive-pattern errors.
- **Fix:** Added minimal pattern arms preserving existing semantics.
  `selector::explicit_strategy()` maps the new variants onto
  `SelectorStrategy::Aria` with prefixed string values (e.g.
  `role=button:Save`, `label=Email`, `text=Learn more`) — to be replaced
  by proper `SelectorStrategy::Role|Label|TextExact` variants in 07-02.
  `playwright_driver::target_to_json()` already implements the proper
  CONTEXT.md §Tier-1-prerequisite shape (`{kind: "role", value: {role,
  name}}` etc.). `capability.rs` returns false for the new variants
  (no shadow-DOM / download / oauth heuristic applies to them). `SelectorOrTextDto`
  in `parse.rs` adds flat `Role(String) | Label(String) | TextExact(String)`
  arms (the proper structured shape + ts-rs regen is Tier 1 work).
- **Files modified:** see "key-files modified" above.
- **Logged:** `.planning/phases/07-.../deferred-items.md` for 07-02 to pick up.
- **Commits:** `77d6c50` (Task 1)

**2. [Rule 3 — Blocking] No `state.driver` field for picker commands to route through**

- **Found during:** Task 1 — picker.rs needed an AppState handle to the
  active sidecar driver. Plan note: "Adjust AppState field access to
  match the actual name used by existing automation commands… do not
  fabricate a new field." Reality: there was no such field. The existing
  `launch_automation` command spawns a per-call sidecar and consumes it
  inline; no shared handle existed.
- **Fix:** Added `SharedPlaywrightDriverHandle` (`Arc<TokioMutex<Option<Arc<Mutex<PlaywrightSidecarDriver>>>>>`)
  to `AppState`. `launch_automation` publishes `shared_pw.clone()` to
  this slot at executor startup and clears it at story end. Picker
  commands take a clone of the inner Arc inside a short critical
  section, then `.lock().await` on the driver to issue JSON-RPC. This is
  the minimum addition needed to make the picker reachable; the
  alternative — spinning a fresh sidecar — would not see the same
  injected overlay (overlay is added via `addInitScript` at launch time).
- **Files modified:** `state/mod.rs`, `commands/automation.rs`, `commands/picker.rs`.
- **Commits:** `77d6c50` (Task 1)

**3. [Rule 3 — Blocking] `AppState` `Debug` derive failed because PlaywrightSidecarDriver lacks Debug**

- **Found during:** Task 1 build after adding the driver slot.
- **Fix:** Removed `#[derive(Debug)]` from `AppState`. AppState held no
  callers using `{:?}` on it, so this is safe.
- **Commits:** `77d6c50`

### Scope notes (not deviations)

- Test environment used is `happy-dom` (project default), not `jsdom`. The
  plan-suggested `// @vitest-environment jsdom` header was omitted because
  jsdom is not in `apps/desktop/devDependencies`. happy-dom supports all
  CodeMirror DOM operations and React Portals required by the tests; all
  9 vitest cases pass cleanly under it.
- Sessions-live predicate in `PickElementButton` uses
  `status === "recording" || "paused"` (the recorder store has no
  `idle-ready` state — the actual states are
  `idle | preflight | recording | paused | stopping | completed | failed`).
  This matches the plan's intent (enabled while sidecar is alive).

### Out-of-scope failures detected

- 7 vitest failures in `ChatPanel.test.tsx` (NL mode) and
  `AccountsPage.test.tsx` (settings) pre-exist on `main`. Confirmed by
  `git stash` + re-run. Not investigated further per scope-boundary rule.

## Threat Flags

None new. The implementation matches the plan's `<threat_model>`:

| Threat | Mitigation in code |
|---|---|
| T-07-03b-01 (DSL injection via `emitted`) | `editorController.insertAtCursor` calls `view.dispatch({ changes: { from, insert: text } })` — text is passed verbatim as a CodeMirror change spec, not eval'd, not injected as innerHTML. The sidecar's `escapeDslString` (07-03a) handles `\` + `"` escaping before string interpolation. |
| T-07-03b-02 (bogus `timeout_ms`) | Bounded by `u64`; no persistent side-effects; sidecar enforces its own 60 s default. |
| T-07-03b-03 (`editorController` is bundle-callable) | Bundle is signed + notarized (Plan 01-10); only in-app code can import the module. |

## Self-Check

```
[ -f apps/desktop/src/features/editor/controller.ts ] && FOUND
[ -f apps/desktop/src/features/editor/controller.test.ts ] && FOUND
[ -f apps/desktop/src/features/recorder/pick-element-button.tsx ] && FOUND
[ -f apps/desktop/src/features/recorder/pick-element-button.test.tsx ] && FOUND
[ -f apps/desktop/src/ipc/picker.ts ] && FOUND
[ -f apps/desktop/src-tauri/src/commands/picker.rs ] && FOUND
[ -f .planning/phases/07-.../07-03b-SMOKE.md ] && FOUND
git log --oneline | grep 77d6c50  → FOUND  (Task 1)
git log --oneline | grep 3097eef  → FOUND  (Task 2)
git log --oneline | grep 9432aa5  → FOUND  (Task 3)
grep -c "emitted: String" crates/automation/src/playwright_driver.rs → 3 (≥1)
grep -n "PickElementButton" apps/desktop/src/features/recorder/recording-view.tsx → 2 (import + JSX)
grep -n "editorController.setView\|editorController.clearView" apps/desktop/src/features/editor/story-editor.tsx → both present
```

## Self-Check: PASSED
