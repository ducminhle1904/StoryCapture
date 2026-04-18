# Phase 7 Research — Semantic DSL verbs (Tier 1)

**Researched:** 2026-04-17
**Source:** In-session sub-agent research (three parallel agents: Tier 1/2/3 landscape + implementation)

## RESEARCH COMPLETE

## Background

StoryCapture's DSL today forces users to write CSS selectors and ARIA prefixes:

```
click selector ".new-todo"
hover selector ".figure:first-of-type img"
select selector "#dropdown" "Option 1"
```

This requires DOM knowledge that target users (product/design folks) don't have. Industry has converged on **accessibility-first locators** (Playwright Codegen, Testing Library, Chrome DevTools Recorder) that use ARIA role + accessible name as the primary targeting surface. Tier 1 promotes these into first-class DSL syntax.

## Current Code Map (files inspected)

| File | Purpose | Tier 1 impact |
|---|---|---|
| `crates/story-parser/src/grammar.pest` | pest grammar | Add 3 new target rules + `cmd_fill` alternative + `role_kw` atomic |
| `crates/story-parser/src/ast.rs` | `SelectorOrText`, ts-rs annotations | Add `Role`, `Label`, `TextExact` variants + `AriaRole` enum |
| `crates/story-parser/src/lenient_tokenize.rs` | pair walker → `RawTarget`, `ParsedCommand` | Extend `RawTarget`; route new target pairs; handle `cmd_fill` → `ParsedCommand::Type` |
| `crates/story-parser/src/semantic.rs` | layer-2 build_command, validation | Map new `RawTarget` variants to new `SelectorOrText` variants |
| `crates/story-parser/src/suggest.rs` | Levenshtein diagnostics | Add `KNOWN_ROLES` + did-you-mean on unknown role_kw |
| `crates/story-parser/src/parser.rs` | Rule enum (pest-derived) | Regenerates automatically |
| `packages/story-dsl/src/ast.ts` | TS mirror | Regenerates via ts-rs |
| `crates/automation/src/events.rs` | `SelectorStrategy` enum | Add `Role`, `Label`, `TextExact` variants + `as_str()` |
| `crates/automation/src/selector.rs` | SmartSelector, `explicit_strategy`, ranked chain | Add explicit short-circuits for the 3 new variants |
| `crates/automation/src/driver.rs` | `ResolvedSelector`, `BrowserDriver` | No changes (opaque pass-through) |
| `crates/automation/src/executor.rs` | consumes ResolvedSelector | No changes |
| `crates/automation/src/auto_wait.rs` | visible/stable polling | No changes |
| `scripts/playwright-sidecar/server.mjs` | JSON-RPC server, `locate()`, `targetToLocator()` | Add 3 highest-precedence branches in both helpers |

## Validation Architecture (Nyquist-style)

**Deterministic parser tests**
- Positive: every supported role keyword × every target-taking verb generates a valid AST with the right `SelectorOrText` variant. Use `insta` snapshots.
- Negative: unknown role keyword triggers did-you-mean diagnostic listing candidate roles.
- `fill ... with ...` desugars to `Command::Type` with `Label` target — snapshot match.
- Legacy forms (`click selector "..."`, `click testid "..."`, `click aria "..."`, `click "..."`) parse identically to pre-change output. Use golden-file comparison against checked-in fixtures.

**SmartSelector unit tests**
- `Role/Label/TextExact` variants bypass the fallback chain: exactly one attempt per strategy, confidence 1.0, no fuzzy retry.
- Existing `Text(s)` ranked-chain behavior is unchanged (regression guard).

**Sidecar tests**
- Against a static HTML fixture with a button, a labelled input, and a link, the three new `locate()` branches return locators that resolve to exactly one element each (`count() === 1`).
- `elementState` and `waitFor` both respect the new strategies (they go through `targetToLocator`).

**End-to-end smoke**
- One E2E `.story` using every new form against a local HTML fixture, run through the existing Playwright sidecar harness, produces PASS on every step.

## Design Decisions

### D-01 — Syntax shape
`click <role> "<name>"` with `role` as a keyword (button/link/…) rather than `click role=button "Save"`. Chosen for readability; keyword list is small (~20) and spelled out in grammar for good error messages.

### D-02 — Bare `click "text"` semantics
Unchanged: continues through the ranked SmartSelector chain (accessible-name → label → visible text → fuzzy). Only the explicit `click text "..."` form short-circuits to `getByText(name, { exact: true })`.

### D-03 — `fill` as sugar
`fill field "Email" with "..."` is syntactic sugar over `type field "Email" "..."` (which also now works). `fill` reads more naturally; `type` preserved because existing stories use it and because not all inputs are form fields.

### D-04 — `Label` vs `field "..."`
The DSL uses the word `field` (design-friendly) but the AST/strategy is called `Label` because it maps to Playwright's `getByLabel`. This is an intentional translation layer.

### D-05 — Role subset
20 roles covers >95% of interactive targets in typical SaaS demos. Adding more is a non-breaking change later. Image has `img` alias for the HTML natural spelling.

### D-06 — Encoding in SmartSelector value
`role=<role>:<name>` chosen because names may contain `=` (e.g. `"a=b"`); split on first `:` preserves that. Sidecar parses symmetrically.

### D-07 — Did-you-mean
Uses the existing `suggest.rs` Levenshtein mechanism. `KNOWN_ROLES` is a single `const &[&str]` kept in sync with `AriaRole`.

### D-08 — Error classification
Role mismatch at runtime is not a new error class; the existing `wait_actionable` timeout with visible=false output is informative enough.

## Wave Split Recommendation

Two plans. Sequential (Plan 2 depends on Plan 1's AST/grammar output):

- **Plan 07-01** — Grammar + AST + semantic + suggest + TS mirror regen + parser tests
- **Plan 07-02** — SmartSelector strategies + sidecar `locate` / `targetToLocator` branches + sidecar tests + integration fixture

## Effort Estimate

- Plan 07-01: ~1.5 days (grammar + 3 AST variants + validation + tests)
- Plan 07-02: ~1.5 days (SmartSelector + sidecar + fixture E2E)
- Total: ~3 days

## Open Questions

None — every decision is locked in CONTEXT.md.

## References

- Playwright Locators API: https://playwright.dev/docs/locators
- Testing Library philosophy (role-first): https://testing-library.com/docs/queries/about/#priority
- Chrome DevTools Recorder schema: https://developer.chrome.com/docs/devtools/recorder
- pest grammar docs: https://pest.rs/
- Existing Phase 1 DSL plans (reference implementation): `.planning/phases/01-foundation-dsl-automation-capture-encode/01-04-PLAN.md`
