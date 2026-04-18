---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 01
subsystem: story-parser
tags: [dsl, parser, pest, accessibility, tier-1]
requires:
  - story-parser crate (pest 2.7, ts-rs 10)
provides:
  - SelectorOrText::Role { role: AriaRole, name: String } variant
  - SelectorOrText::Label(String) variant
  - SelectorOrText::TextExact(String) variant
  - AriaRole enum (21 PascalCase variants, kebab-case serde, image|img alias)
  - cmd_fill grammar rule + layer-1 desugar to ParsedCommand::Type
  - suggest::KNOWN_ROLES (22 spellings) + Levenshtein did-you-mean for unknown role keywords
  - regenerated packages/story-dsl/src/ast.ts (TS mirror)
affects:
  - downstream consumers of SelectorOrText must add three new arms (Plan 07-02 sidecar+driver)
tech-stack:
  added: []
  patterns:
    - "Two-layer parse: stringly-typed RawTarget at layer 1, validated AriaRole at layer 2 with did-you-mean diagnostic on miss (D-08)"
    - "Sugar verbs desugar at layer 1 (lenient_tokenize) so executor sees no new variants (D-03)"
    - "Drift guard via shared lockstep keyword list — grammar role_kw / AriaRole::from_keyword / suggest::KNOWN_ROLES all carry the same 22 spellings; comment in ast.rs documents the 21-vs-22 enum-vs-spelling asymmetry"
key-files:
  created:
    - crates/story-parser/tests/fixtures/valid/tier1_new_forms.story
    - crates/story-parser/tests/fixtures/valid/tier1_legacy_forms.story
  modified:
    - crates/story-parser/src/grammar.pest
    - crates/story-parser/src/ast.rs
    - crates/story-parser/src/lenient_tokenize.rs
    - crates/story-parser/src/semantic.rs
    - crates/story-parser/src/suggest.rs
    - crates/story-parser/tests/golden.rs
    - packages/story-dsl/src/ast.ts
decisions:
  - "Adopted CONTEXT.md D-01..D-08 verbatim — 21 AriaRole variants + image/img alias, role/label/text_exact serde tags, additive grammar with role/field/text_kw before bare target_text fallback, fill→Type(Label) desugar at layer 1"
  - "Best-effort fallback for unknown role keyword: emit Diagnostic::error then degrade to SelectorOrText::Text(name) so the rest of the parse tree still builds (consistent with how unknown verbs degrade in `validate`)"
  - "Test-only `to_target_for_test` re-export added to crate-internal API so the in-process drift-guard test can construct a RawTarget::Role with an unknown spelling — the closed grammar role_kw rule otherwise makes the diagnostic path unreachable from a real .story file"
metrics:
  duration: ~25 minutes
  completed-date: 2026-04-18
  tasks-completed: 3
  commits: 3
---

# Phase 07 Plan 01: Tier 1 accessibility-first locators (parser layer) Summary

**One-liner:** Extended the Story DSL pest grammar + AST + semantic layer with role-qualified locator forms (`click button "Save"`, `fill field "Email" with "..."`, `click text "Learn more"`) mapping to Playwright's `getByRole`/`getByLabel`/`getByText` semantics, with full backwards compatibility for the legacy `selector`/`testid`/`aria`/bare-string forms.

## What Changed

### Grammar (`crates/story-parser/src/grammar.pest`)
- Added `target_role`, `target_field`, `target_text_kw` alternatives before `target_text` (the bare-string fallback) so explicit-kind forms always win.
- Added `role_kw` as an atomic rule listing the 22 supported role keyword spellings (image/img alias).
- Added `cmd_fill = { "fill" ~ target ~ "with" ~ string }` and placed it before `cmd_type` in the command alternatives.

### AST (`crates/story-parser/src/ast.rs`)
- New `AriaRole` enum: 21 PascalCase variants, `#[serde(rename_all = "kebab-case")]`, with `as_kebab()` for wire encoding and `from_keyword()` accepting both `image` and `img` (both → `AriaRole::Image`).
- `SelectorOrText` extended with three appended variants (existing variants untouched):
  - `Role { role: AriaRole, name: String }` → wire shape `{"kind":"role","value":{"role":"button","name":"Save"}}`
  - `Label(String)` → wire shape `{"kind":"label","value":"Email"}`
  - `TextExact(String)` → wire shape `{"kind":"text_exact","value":"Learn more"}`

### Wire formats for downstream (Plan 07-02 input)

These are the exact serde JSON shapes Plan 07-02's `playwright_driver::target_to_json` and the sidecar `locate()` switch must consume:

| Variant | JSON shape |
|--------|------------|
| `Role { role: AriaRole, name }` | `{"kind":"role","value":{"role":"<kebab>","name":"<name>"}}` |
| `Label(name)` | `{"kind":"label","value":"<name>"}` |
| `TextExact(name)` | `{"kind":"text_exact","value":"<name>"}` |

Note: serde `tag="kind", content="value"` with `rename_all="snake_case"` produces `text_exact` (snake_case), not `textexact` or `text-exact`. The sidecar router in 07-02 must match this exactly.

### Lenient tokenizer (`crates/story-parser/src/lenient_tokenize.rs`)
- `RawTarget` extended with parallel stringly-typed arms (`Role { role: String, name: String }`, `Label(String)`, `TextExact(String)`).
- `parse_target_pair` now routes `Rule::target_role` / `Rule::target_field` / `Rule::target_text_kw` to the corresponding `RawTarget`.
- `parse_command` routes `Rule::cmd_fill` to `ParsedCommand::Type` (the D-03 sugar — no new `ParsedCommand` variant).

### Semantic layer (`crates/story-parser/src/semantic.rs`)
- `to_target` refactored to take `&mut Vec<Diagnostic>`; every `build_command` call site updated.
- Unknown role keyword path: emits `Diagnostic::error` with Levenshtein did-you-mean (e.g. `unknown role 'buton' — did you mean 'button'?`) and degrades to `SelectorOrText::Text(name)` so the AST keeps building.
- Test-only `to_target_for_test` re-export so the in-process drift-guard test can exercise the unknown-role path (the closed grammar `role_kw` rule otherwise makes this branch unreachable from real `.story` input).

### Suggest (`crates/story-parser/src/suggest.rs`)
- `pub const KNOWN_ROLES: &[&str]` listing all 22 keyword spellings — must stay in lockstep with `AriaRole::from_keyword`.
- New unit test `finds_role_typo` covering Levenshtein hits for `buton`/`lnk`/`imag`.

### TS mirror (`packages/story-dsl/src/ast.ts`)
- Regenerated by ts-rs on `cargo build --features ts-export`. Now exports:
  - `export type AriaRole = "button" | "link" | ... | "main"` (21 union members)
  - Extended `SelectorOrText` union with the three new arms — verified `kind` values are `"role"`, `"label"`, `"text_exact"`.

## Tests

All 33 tests across the story-parser crate pass:
- `cargo test -p story-parser --lib` → 24 tests (16 pre-existing + 7 tier1_tests + 1 finds_role_typo)
- `cargo test -p story-parser --test golden` → 9 tests (7 pre-existing + 2 tier1 fixture tests)
- `cargo test -p story-parser --test errors` → 9 tests (regression — unchanged)
- `cargo build -p story-parser --features ts-export` → green

The `unknown_role_emits_did_you_mean_direct` test directly verifies the must_haves claim about KNOWN_ROLES diagnostics by constructing a `RawTarget::Role { role: "buton", .. }` in-process — the only path that actually exercises the drift-guard branch.

## Backwards Compatibility (the load-bearing requirement)

Verified end-to-end via `tier1_legacy_forms_fixture_uses_only_pre_phase7_variants`: the legacy fixture exercises every pre-Phase-7 target form (`selector ".save-btn"`, `testid "save"`, `aria "Save"`, bare `"Save"`, `type selector "#email" "..."`) and the test asserts that no command in the resulting AST uses any of the new `Role`/`Label`/`TextExact` variants. The same forms also appear in the existing `all-verbs.story` fixture, whose pre-existing assertions still pass without modification.

## Pest Compilation Quirks Encountered

- `role_kw` is an atomic (`@`) rule so the inner `string` is exposed via `into_inner()` from the parent `target_role` pair, NOT from `role_kw` itself. The tokenizer iterates the `target_role` children to find both `role_kw` and `string` siblings — handled in `parse_target_pair`.
- The `r#"..."#` raw-string delimiter collides with `#`-prefixed CSS selectors inside test fixtures (e.g. `selector "#save"`). Use `r##"..."##` for any inline `.story` source containing `#`.
- pest_derive auto-generates the `Rule` enum, so adding a variant requires no manual `Rule::*` changes outside the grammar.

## Deviations from Plan

**[Rule 3 — Build sequencing]** The plan as written would have left the build broken between Task 1 and Task 2 (semantic.rs's existing `match` on `RawTarget` becomes non-exhaustive the moment Task 1 adds the new variants). To keep each per-task commit independently buildable (CLAUDE.md "no workarounds, no half-implementations"), Task 1's commit includes a structural-only `to_target` update in semantic.rs that maps the new RawTarget arms to the corresponding SelectorOrText arms WITHOUT diagnostic threading. Task 2 then refactors `to_target` to its final shape (threading `&mut Vec<Diagnostic>` and adding the KNOWN_ROLES did-you-mean path). The end-state code matches the plan exactly; only the per-commit sequencing differs.

**Files modified:** `crates/story-parser/src/semantic.rs` (Task 1 commit only — the change is replaced by Task 2)
**Commits:** 5422815 (Task 1 includes the bridging stub), 6aeed3b (Task 2 replaces it)

## Auth Gates

None. Fully offline parser work.

## Known Stubs

None. All new variants are wired through the entire pipeline (grammar → tokenizer → semantic → AST → ts-rs mirror) and exercised by the test suite. Plan 07-02 will wire them through the sidecar/driver — that is the defined Phase 7 boundary, NOT a stub in this plan.

## Self-Check: PASSED

- crates/story-parser/src/grammar.pest — modified ✓
- crates/story-parser/src/ast.rs — modified, AriaRole + 3 new SelectorOrText arms present ✓
- crates/story-parser/src/lenient_tokenize.rs — modified, 3 new RawTarget arms + Rule::cmd_fill ✓
- crates/story-parser/src/semantic.rs — modified, to_target threads diagnostics, tier1_tests module green ✓
- crates/story-parser/src/suggest.rs — modified, KNOWN_ROLES + finds_role_typo ✓
- crates/story-parser/tests/golden.rs — extended with 2 tier1 tests ✓
- crates/story-parser/tests/fixtures/valid/tier1_new_forms.story — created ✓
- crates/story-parser/tests/fixtures/valid/tier1_legacy_forms.story — created ✓
- packages/story-dsl/src/ast.ts — regenerated, AriaRole + 3 new arms present ✓
- Commit 5422815 — present in `git log` ✓
- Commit 6aeed3b — present in `git log` ✓
- Commit cd75cc9 — present in `git log` ✓
