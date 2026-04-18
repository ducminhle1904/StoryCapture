---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 02
subsystem: automation
tags: [automation, selector, playwright, sidecar, e2e, tier-1]
requires:
  - 07-01 (AriaRole + SelectorOrText::{Role,Label,TextExact})
provides:
  - SelectorStrategy::{Role, Label, TextExact} variants with as_str() → "role"|"label"|"text_exact"
  - SmartSelector::explicit_strategy routing for the three Tier 1 variants (single-attempt, score 1.0)
  - sidecar locate(selector, strategy) branches for 'role' | 'label' | 'text_exact'
  - sidecar targetToLocator() branches returning Locators for kind 'role' | 'label' | 'text_exact'
  - targetToLocator INVARIANT (string | Locator return type) documented inline + enforced at both call sites
  - playwright_driver::target_to_json exhaustive WIRE CONTRACT + 5 unit tests
  - scripts/playwright-sidecar/tests/fixtures/tier1.html — Tier 1 sidecar vitest fixture
  - crates/automation/tests/fixtures/tier1.{story,html} — Rust compile-only smoke fixtures
  - crates/automation/tests/tier1_e2e.rs — PHASE-7.3 Rust-side compile gate
affects:
  - downstream executor callers of waitFor/assert now see string|Locator dispatch inside the sidecar (transparent)
tech-stack:
  added: []
  patterns:
    - "Strategy-first dispatch in sidecar locate(): 'role'|'label'|'text_exact' routed BEFORE legacy prefix detection so 'text=' prefix collision between VisibleText and TextExact stays unambiguous"
    - "Role on-wire encoding uses split-on-FIRST-colon ('role=<kebab>:<name>') so names may contain ':'; the Rust-side unit test `explicit_role_preserves_colon_in_name` proves the encoder, the sidecar vitest case `role selector with colon-containing name resolves on a real DOM element` proves the decoder against real Chromium"
    - "targetToLocator now returns `string | Locator`; both call sites (waitFor, assert) defensively type-check with `typeof loc === 'string'` before hitting string-only APIs — documented via INVARIANT comment so future callers stay fail-loud"
    - "WIRE CONTRACT docblock in target_to_json pairs every Rust-side kind string with the sidecar branch that decodes it; no catch-all `_ =>` arm — exhaustive matching is the drift guard"
key-files:
  created:
    - scripts/playwright-sidecar/tests/fixtures/tier1.html
    - crates/automation/tests/fixtures/tier1.story
    - crates/automation/tests/fixtures/tier1.html
    - crates/automation/tests/tier1_e2e.rs
  modified:
    - crates/automation/src/events.rs
    - crates/automation/src/selector.rs
    - crates/automation/src/capability.rs
    - crates/automation/src/playwright_driver.rs
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/server.test.mjs
decisions:
  - "Bridging target_to_json stub in Task 1's commit, replaced by fully-documented WIRE CONTRACT + 5 unit tests in Task 4. Keeps every per-task commit independently buildable (CLAUDE.md no-workaround rule)."
  - "Extended capability.rs is_shadow_dom / is_download_target / is_oauth_target to cover the three new SelectorOrText arms in Task 1 rather than defer — same [Rule 3 build-sequencing] pattern plan 07-01 used. The three new arms treat their `name`/value string as the sentinel carrier, consistent with Aria/TestId/Text."
  - "Task 3 is a compile-only smoke (`cargo test --no-run` is the ship gate); PHASE-7.3 live acceptance is owned by the sidecar vitest. The `#[ignore]` companion in tier1_e2e.rs marks the live-run entry point for developers without pretending to be a CI gate."
metrics:
  duration: ~35 minutes
  completed-date: 2026-04-17
  tasks-completed: 4
  commits: 4
---

# Phase 07 Plan 02: Tier 1 accessibility-first locators (automation layer) Summary

**One-liner:** Closed the Tier 1 loop by routing Plan 07-01's `SelectorOrText::Role/Label/TextExact` through the Rust `SmartSelector` and the Playwright SEA sidecar to Playwright's canonical `getByRole(role, {name, exact: true})` / `getByLabel(name, {exact: true})` / `getByText(name, {exact: true})` APIs, with the sidecar vitest against real Chromium acting as the PHASE-7.3 acceptance gate.

## What Changed

### Rust — events.rs
- `SelectorStrategy` gains three variants: `Role`, `Label`, `TextExact`.
- `as_str()` returns `"role"`, `"label"`, `"text_exact"` — these are the exact strings the sidecar JSON-RPC `strategy` argument switches on; drift would silently mis-route.

### Rust — selector.rs
- `explicit_strategy()` routes the three new `SelectorOrText` variants with D-06 wire encoding:
  - `Role { role, name }` → `("role", format!("role={}:{name}", role.as_kebab()))`
  - `Label(name)` → `("label", format!("label={name}"))`
  - `TextExact(name)` → `("text_exact", format!("text={name}"))`
- `synth_value_for` and `score_for` extended with non-reachable arms for the three new strategies (`debug_assert!(false, ...)` in `synth_value_for`) — defense in depth since strict explicit strategies never reach ranked scoring.
- 6 new tests: colon-in-name encoding proof, `as_str()` sidecar contract, and a `NoopDriver`-backed proof that the new strategies take a single attempt with score 1.0 and NO fallback-chain entries.

### Rust — capability.rs (Rule 3 bridging)
- `is_shadow_dom`, `is_download_target`, `is_oauth_target` extended to cover the three new `SelectorOrText` variants. Consistent with the existing arms: the `name`/value string carries any sentinel prefix.

### Rust — playwright_driver.rs (Task 1 bridge → Task 4 full)
- Task 1 commit contains a bridging `target_to_json` stub so the lib compiles. Task 4 replaces it with the fully-documented version:
  - `Role { role, name }` → `{"kind":"role","value":{"role":"<kebab>","name":"<name>"}}` (OBJECT value so names may contain `:` / `=` / `"` without on-wire escaping)
  - `Label(s)` → `{"kind":"label","value":"<s>"}`
  - `TextExact(s)` → `{"kind":"text_exact","value":"<s>"}` (snake_case kind tag — matches sidecar branch)
- Prefaced by a WIRE CONTRACT docblock that lists every `(kind, value-shape, sidecar-branch)` triple. Explicit no-catch-all drift guard.
- 5 unit tests in `tier1_target_to_json_tests`: object-shape + kebab role, colon-in-name, label string-value, `text_exact` snake_case (the drift guard), and legacy variants unchanged.

### Sidecar — server.mjs
- `locate(selector, strategy)` gains three TOP-level branches dispatched on `strategy` BEFORE the legacy prefix detection:
  - `strategy === 'role'` → decodes `role=<kebab>:<name>` via split-on-FIRST-colon, calls `page.getByRole(role, { name, exact: true })`
  - `strategy === 'label'` → `page.getByLabel(name, { exact: true })`
  - `strategy === 'text_exact'` → `page.getByText(name, { exact: true })`
- Legacy `aria-name=` chained `.or()` branch untouched — grep-verified 3 occurrences of `aria-name=`.
- `targetToLocator(target)` gains three branches for `kind === 'role' | 'label' | 'text_exact'` that return Playwright `Locator` objects (not strings). Prefaced by an INVARIANT comment enumerating every call site and the string|Locator shape they must tolerate.
- `waitFor` and `assert` handlers rewritten with `const loc = targetToLocator(target); if (typeof loc === 'string') { ... } else { ... }` so both shapes are handled defensively. Any future caller that forgets this branch crashes loudly rather than silently mis-routing.

### Sidecar — tests/fixtures/tier1.html (new)
Self-contained HTML: `<h1>Dashboard</h1>`, nav `<a>Docs</a>`, form with `<label>Email</label><input>` + `<label>Password</label><input>` + `<button type="submit">Save</button>`, `<img alt="Hero">`, `<p>Learn more</p>` + decoy `<p>Learn more stuff</p>` so exact-mode matters.

### Sidecar — server.test.mjs
- Added `pathToFileURL` import + `TIER1_FIXTURE_URL` constant.
- New `describe("Phase 7 Tier 1 — locate() strict explicit strategies")` block with **10 tests** driving real Chromium:
  1. `getByRole(button, Save)` resolves the submit button
  2. `getByRole(link, Docs)` resolves the nav link
  3. `getByLabel(Email)` resolves the email input
  4. `getByText` exact matches `Learn more` but rejects `Learn more not present` (the decoy)
  5. `click` uses `locate('role')` for `SelectorOrText::Role`
  6. `type` uses `locate('label')` for `SelectorOrText::Label`
  7. `click` uses `locate('text_exact')` for `SelectorOrText::TextExact`
  8. Legacy bare `aria-name=Save` / `strategy: 'accessible-name'` regression guard
  9. `elementState` with a Tier 1 `role=button:Save` target routes through `locate()` and reports visible (proves elementState coverage since it uses `locate()` directly, NOT `targetToLocator`)
  10. Role selector with colon-in-name (`Go: now`) resolves against a data-URL-injected real DOM element — decoding counterpart to the Rust encoding test

### Rust — crates/automation/tests/tier1_e2e.rs (new)
Compile-only integration smoke. Parses `tier1.story` (mixed new + legacy forms), walks every command through `SmartSelector::resolve_with_attempts` against `NoopDriver`, and asserts strategy routing per `SelectorOrText` kind. Ship gate is `cargo test -p automation --test tier1_e2e --no-run`. The companion `#[ignore]` test `tier1_live_run_against_real_chromium` documents the live-run entry point; actual live coverage lives in vitest.

## Tests

| Suite | Result |
|---|---|
| `cargo test -p automation --lib` | **28 passed** (22 pre-existing + 6 selector tests + 5 target_to_json tests) |
| `cargo test -p automation --test tier1_e2e --no-run` | **green** (Task 3 ship gate) |
| `cargo test -p automation --test tier1_e2e` | **1 passed, 1 ignored** |
| `cargo test -p automation --test capability_routing` | 7 passed (regression — unchanged) |
| `cargo test -p automation --test selector` | 10 passed (regression — unchanged) |
| `pnpm --filter playwright-sidecar test` | **15 passed** (5 pre-existing browserProcess + 10 new Phase 7 Tier 1) — **PHASE-7.3 gate** |

## Cross-language wire consistency (grep-verified)

| Rust | Sidecar |
|---|---|
| `"kind": "role"` (1) | `target.kind === 'role'` (1) |
| `"kind": "label"` (1) | `target.kind === 'label'` (1) |
| `"kind": "text_exact"` (1) | `target.kind === 'text_exact'` (1) |
| `SelectorStrategy::Role.as_str() == "role"` | `strategy === 'role'` branch in `locate()` |
| `SelectorStrategy::Label.as_str() == "label"` | `strategy === 'label'` branch |
| `SelectorStrategy::TextExact.as_str() == "text_exact"` | `strategy === 'text_exact'` branch |

## Backwards Compatibility

- Legacy `aria-name=` chained `.or()` branch in sidecar `locate()` untouched — grep shows 3 occurrences of `aria-name=` across server.mjs (1 comment + 1 branch + 1 test reference).
- The vitest case `bare aria-name= fallback path still resolves (legacy regression guard)` drives the legacy ranked chain through real Chromium; still green.
- All 4 legacy `SelectorOrText` variants (`Text`, `Selector`, `TestId`, `Aria`) encode identically to their pre-Phase-7 shape in `target_to_json` — regression-guarded by the new `legacy_variants_unchanged` unit test.
- `capability.rs` extensions treat Role/Label/TextExact identically to Aria/Text/TestId for sentinel-prefix sniffing (shadow/download/oauth).

## Deviations from Plan

**[Rule 3 — Build sequencing] capability.rs extended in Task 1.** The plan did not list `capability.rs` as a Task 1 touchpoint, but the moment Task 1 added `SelectorOrText::{Role,Label,TextExact}` via the pest AST, three `match` sites in `capability.rs` became non-exhaustive and broke `cargo build`. Same pattern Plan 07-01 used for `semantic.rs` (its SUMMARY documents the equivalent bridging). End-state code matches the plan's intent; the three new arms treat the `name`/value string as the sentinel carrier, consistent with the existing `Aria`/`TestId`/`Text` arms. **Files modified:** `crates/automation/src/capability.rs` (Task 1 commit).

**[Rule 3 — Build sequencing] target_to_json bridging stub in Task 1.** Task 1 added a minimal `target_to_json` arm for the three new variants so the library builds; Task 4 then replaces that stub with the full WIRE CONTRACT documentation + 5 unit tests. The plan explicitly calls for Task 4 to "replace" the function; this deviation just makes each intermediate commit independently buildable. End-state code is identical to the plan spec. **Commits:** `e545507` (Task 1 bridge) → `37c574f` (Task 4 full).

## Auth Gates

None. Fully offline automation + vitest work.

## Known Stubs

None. Every new `SelectorOrText` variant is wired through the entire pipeline: Rust `SelectorStrategy` → `explicit_strategy()` → `target_to_json` → sidecar `locate()` / `targetToLocator()` → Playwright `getByRole`/`getByLabel`/`getByText`, with both Rust unit tests and vitest cases exercising each leg.

## Threat Flags

None introduced. Threat register T-07-02-01..04 all covered by the implementation (see plan threat_model):
- T-07-02-01 (injection via `role=<role>:<name>`): mitigated — role is a closed `AriaRole` enum emitted by `as_kebab()`; name passes through to Playwright's literal string-match API.
- T-07-02-02 (elevation via targetToLocator string|Locator drift): mitigated — INVARIANT comment + both call sites defensively `typeof loc === 'string'` gated.
- T-07-02-03, T-07-02-04: accepted per plan.

## Self-Check: PASSED

- crates/automation/src/events.rs — modified, 3 new SelectorStrategy variants + as_str branches present ✓
- crates/automation/src/selector.rs — modified, explicit_strategy handles Role/Label/TextExact, 6 new tests ✓
- crates/automation/src/capability.rs — modified, all 3 match sites exhaustive ✓
- crates/automation/src/playwright_driver.rs — modified, WIRE CONTRACT + 5 new tests ✓
- scripts/playwright-sidecar/server.mjs — modified, locate() + targetToLocator() + INVARIANT + call sites ✓
- scripts/playwright-sidecar/server.test.mjs — modified, Phase 7 Tier 1 describe block with 10 tests ✓
- scripts/playwright-sidecar/tests/fixtures/tier1.html — created ✓
- crates/automation/tests/tier1_e2e.rs — created ✓
- crates/automation/tests/fixtures/tier1.story — created ✓
- crates/automation/tests/fixtures/tier1.html — created ✓
- Commit e545507 — present in git log ✓
- Commit 9a014c8 — present in git log ✓
- Commit bf99f66 — present in git log ✓
- Commit 37c574f — present in git log ✓
- `cargo test -p automation --lib` → 28 passed ✓
- `cargo test -p automation --test tier1_e2e --no-run` → green ✓
- `pnpm --filter playwright-sidecar test` → 15 passed ✓
