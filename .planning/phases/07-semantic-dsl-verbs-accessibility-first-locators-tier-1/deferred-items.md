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
