# Deferred Items — Phase 7

## From 07-03b execution

### Tier 1 forward-compat stubs (07-02 owns the proper landing)

`07-03b` had to add minimal pattern arms in `crates/automation/` so the
workspace compiles, because `SelectorOrText::{Role,Label,TextExact}` exist
in `crates/story-parser/src/ast.rs` but downstream consumers were never
patched. These are STUBS — 07-02 should land the proper implementations:

- `crates/automation/src/events.rs` — `SelectorStrategy` enum still lacks
  `Role`/`Label`/`TextExact` variants. `selector.rs::explicit_strategy()`
  currently maps the new SelectorOrText variants onto `SelectorStrategy::Aria`
  with prefixed string values (`role=...`, `label=...`, `text=...`). 07-02
  should add the proper `SelectorStrategy::Role|Label|TextExact` variants
  and update `explicit_strategy()` to return them.
- `crates/automation/src/selector.rs` — same as above; uses Aria strategy
  as a placeholder.
- `crates/automation/src/playwright_driver.rs::target_to_json()` — already
  emits the proper `{"kind": "role", "value": {role, name}}` etc. Matches
  CONTEXT.md §Tier 1 prerequisite. No further work needed.
- `apps/desktop/src-tauri/src/commands/parse.rs::SelectorOrTextDto` — added
  flat `Role(String)`/`Label`/`TextExact` arms. The proper structured shape
  (mirror of the AST `Role { role, name }`) and TS regen via `ts-rs` is
  Tier 1 work.
