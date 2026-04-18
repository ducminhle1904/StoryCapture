# Deferred Items — Phase 7

## Resolved — 07-02 recovery merge (commit following 07-03b)

Root cause: the 07-02 executor worktree was accidentally discarded before its
5 commits (e545507…0daaae2) landed on main. 07-03b subsequently had to add
forward-compat stubs to keep the workspace compiling. Those stubs have now
been replaced with 07-02's proper implementations via a recovery merge of
`0daaae2` onto current main. Conflict resolution:

- `crates/automation/src/events.rs` — 07-02's `SelectorStrategy::{Role,Label,TextExact}` variants now present with canonical `as_str()` values (`"role"`, `"label"`, `"text_exact"`).
- `crates/automation/src/selector.rs` — 07-02's `explicit_strategy()` routes the new variants to the proper strategies; stub Aria fallback arms deleted (previously unreachable).
- `crates/automation/src/playwright_driver.rs` — kept 07-03b's version (it already has the correct `target_to_json()` wire shape + all the `PickElement*` types). Added 07-02's 5 `tier1_target_to_json_tests` on top.
- `crates/automation/src/capability.rs` — took 07-02's version.
- 33/33 `cargo test -p automation --lib` tests green (07-02's 6 new + 07-03b's 5 pick-response + pre-existing).

## Still outstanding

### `apps/desktop/src-tauri/src/commands/parse.rs::SelectorOrTextDto`
07-03b added flat `Role(String)` / `Label(String)` / `TextExact(String)` arms
encoding role as `"<kebab>:<name>"`. The proper structured shape mirroring
the AST `Role { role: String, name: String }` and its TS regen via `ts-rs`
is still stub. Acceptable for now (TS IPC surface only). Proper landing can
happen in a later polish pass or in 07-04b's ts-rs regen window.
## Pre-existing test failures (discovered during 07-04a execution)

Confirmed via `git stash` test — these fail on HEAD before 07-04a's changes:

- `src/features/nl-mode/ChatPanel.test.tsx` — 1 failure (renders empty state)
- `src/features/settings/AccountsPage.test.tsx` — 6 failures

Out of scope for 07-04a (hover-preview slice). Recommend a dedicated fix
plan; these tests touch unrelated subsystems (settings keychain UI +
NL-mode chat).

## 07-04c — deferred pre-existing test failures

The following 7 vitest failures are pre-existing on the 07-04c base
(commit 8e45fd6, Wave 5 merge) and are NOT touched by this plan. Logged
here so the verifier does not mistake them for regressions:

- `src/features/nl-mode/ChatPanel.test.tsx > renders empty state heading…` — unrelated component
- `src/features/settings/AccountsPage.test.tsx` — 6 failures, Vietnamese i18n regressions in `Them key` / `Kiem tra ket noi` strings

Self-healing + picker stamp tests for plan 07-04c all pass:
- `src/features/editor/controller.test.ts` — 5/5 pass
- `src/features/recorder/pick-element-button.test.tsx` — 6/6 pass
- `cargo test -p automation --test self_healing` — 2 pass, 1 ignored (live)
- `cargo test -p automation --lib targets_store_tests` — 7/7 pass
