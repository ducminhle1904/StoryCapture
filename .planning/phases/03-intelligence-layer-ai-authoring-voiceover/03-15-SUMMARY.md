---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 15
subsystem: intelligence
tags: [rust, lsp, selector-lint, heuristic, regex, diagnostics, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/13
    provides: LSP server + diagnostics.rs semantic_diagnostics integration point
provides:
  - intelligence::lsp::selector_lint::{SelectorIssue, SelectorWarning, analyze_selector}
  - LSP WARNING diagnostics with source "selector-lint" for brittle selectors
  - 31-entry fixture corpus (known_broken + known_good) for E11 regression
affects:
  - Phase 3 eval harness (Plan 21) — E11 confusion-matrix test is CI-gatable
  - Phase 3 LSP experience — selector warnings surface in editor hover
tech-stack:
  added: [serde_yaml (dev-only)]
  patterns:
    - "LazyLock<Regex> for precompiled heuristic patterns — regex crate provides linear-time guarantees (no backtracking), mitigating ReDoS"
    - "Selector lint merged into semantic_diagnostics via AST walk — no separate LSP handler needed"
    - "extract_selector_value strips parser wrapper (selector keyword + quotes) before linting"
key-files:
  created:
    - crates/intelligence/src/lsp/selector_lint.rs
    - crates/intelligence/tests/selector_lint_tests.rs
    - crates/intelligence/tests/fixtures/selectors/known_broken.yaml
    - crates/intelligence/tests/fixtures/selectors/known_good.yaml
  modified:
    - crates/intelligence/src/lsp/diagnostics.rs
    - crates/intelligence/src/lsp/mod.rs
    - crates/intelligence/Cargo.toml
key-decisions:
  - "Used regex crate LazyLock statics instead of inline compilation — linear-time guarantees mitigate T-03-15-01 ReDoS risk; 10KB adversarial input completes in <50ms"
  - "Selector lint integrated into existing semantic_diagnostics() rather than a separate LSP handler — keeps diagnostic pipeline unified; selector warnings appear alongside parser warnings"
  - "extract_selector_value strips the parser's wrapper text (selector keyword + quotes) since story_parser stores the full token text including 'selector \"...\"'"
  - "data-testid exclusion in brittle-attr check done via string contains rather than regex look-ahead — regex crate does not support look-ahead; functional equivalent"
  - "Fixture corpus has 31 entries (16 broken + 15 good) exceeding the 30 minimum — includes false-positive and false-negative traps for adversarial coverage"
requirements-completed: [AI-06]
duration: ~8 min
completed: 2026-04-16
---

# Phase 03 Plan 15: Selector Heuristic Analyzer + E11 Fixture Corpus Summary

**Static selector linter with 6 heuristic rules (TooGeneric, MissingFallback, DeepNthChild, AbsoluteXPath, OverlyDynamicClass, BrittleAttribute) integrated into LSP semantic diagnostics, plus a 31-entry fixture corpus enforcing E11 thresholds (precision=1.00, recall=0.86).**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-16T02:22:22Z
- **Completed:** 2026-04-16T02:30:38Z
- **Tasks:** 2 (both TDD)
- **Commits:** 2
- **Files created:** 4
- **Files modified:** 3

## What Was Built

**Task 1 -- Selector heuristic analyzer + LSP integration.**

`crates/intelligence/src/lsp/selector_lint.rs` implements 6 pure-function heuristic rules:

| Rule | Function | Detects |
|------|----------|---------|
| TooGeneric | `is_too_generic` | Single `.class` or `#id` token with no combinators/attributes (regex `^[.#][A-Za-z][A-Za-z0-9_\-]*$`) |
| MissingFallback | (conditional) | TooGeneric selector with no `alt_selectors` fallback chain |
| DeepNthChild | `is_deep_nth_child` | 3+ `:nth-child(...)` occurrences in selector |
| AbsoluteXPath | `is_absolute_xpath` | Starts with `/html/` or `/body/` (after optional `xpath:` prefix) |
| OverlyDynamicClass | `is_overly_dynamic_class` | Contains `_[a-f0-9]{6,}_` or `__[a-zA-Z0-9]{5,}__` patterns (CSS Modules/styled-components) |
| BrittleAttribute | `is_brittle_attr` | `[style="..."]`, `[class="..."]` with value >= 20 chars, or `[data-*]` with hex hash value (excluding data-testid) |

All regexes are precompiled in `LazyLock<Regex>` statics using the `regex` crate which provides linear-time guarantees (T-03-15-01 mitigated).

`analyze_selector(selector, has_fallback) -> Vec<SelectorWarning>` applies all rules and returns human-readable warnings with suggestions.

**LSP integration:** `diagnostics.rs::semantic_diagnostics` now walks the parsed AST after parser diagnostics, extracts `SelectorOrText::Selector` targets from click/type/hover/assert/select/waitfor/upload/drag commands, strips the parser wrapper via `extract_selector_value`, runs `analyze_selector`, and emits each warning as:
```rust
Diagnostic {
    severity: WARNING,
    source: "selector-lint",
    code: "selector-lint",
    message: warning.message,
    ...
}
```

13 unit tests + 1 integration test cover all 6 rules, fallback suppression, XPath prefix handling, adversarial input (10KB selector < 50ms), and no-panic on malformed input.

**Task 2 -- 31-entry fixture corpus + E11 confusion-matrix test.**

- `known_broken.yaml`: 16 entries covering all 6 `SelectorIssue` variants at least twice
- `known_good.yaml`: 15 entries including false-positive traps (e.g., `button.primary-cta[data-testid='submit']` -- has class but also anchor attribute)

`selector_lint_tests.rs` loads both YAML files, runs `analyze_selector` on each, computes the confusion matrix, and asserts thresholds:

| Metric | Result | Threshold |
|--------|--------|-----------|
| Precision | 1.0000 | >= 0.80 |
| Recall | 0.8636 | >= 0.70 |
| TP | 19 | -- |
| FP | 0 | -- |
| FN | 3 | -- |

3 additional tests: variant coverage (all 6 appear >= 2x in broken set), good corpus entries all expect empty, total entries >= 30.

## Decisions Made

See `key-decisions` frontmatter. Headlines:

1. **LazyLock<Regex> statics** -- precompiled at first use, amortized across all linting calls. Linear-time regex crate eliminates ReDoS risk.
2. **Unified diagnostic pipeline** -- selector lint merged into `semantic_diagnostics()` via AST walk rather than requiring a separate LSP handler. Simpler architecture.
3. **extract_selector_value** -- the story parser stores `Selector("selector \".btn\"")` including the keyword and quotes; the helper strips to just `.btn` before linting.
4. **String-based data-testid exclusion** -- regex crate does not support look-ahead; `!s.contains("data-testid")` is the functional equivalent for the brittle-attr check.

## Task Commits

| Task | Message | Hash |
|------|---------|------|
| 1 | `feat(03-15): selector heuristic analyzer with 6 rules + LSP diagnostics integration` | `3348f7e` |
| 2 | `test(03-15): 31-selector fixture corpus + E11 confusion-matrix test` | `ae70bfe` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] regex crate does not support look-ahead for data-testid exclusion.**
- **Found during:** Task 1 implementation of `is_brittle_attr`.
- **Issue:** Plan's `RE_DATA_ATTR_HEX` regex used `(?!testid)` negative look-ahead which the `regex` crate does not support (by design -- it guarantees linear-time matching).
- **Fix:** Replaced look-ahead with a broader regex `\[data-[a-z\-]+=['"][a-f0-9]{8,}['"]\]` plus a post-match `!s.contains("data-testid")` guard. Functionally equivalent.
- **Files modified:** `crates/intelligence/src/lsp/selector_lint.rs`.
- **Commit:** `3348f7e`.

**2. [Rule 3 - Blocking] Parser stores full token text in Selector variant including keyword + quotes.**
- **Found during:** Task 1 integration test (Test 7).
- **Issue:** `SelectorOrText::Selector` contains `"selector \".btn\""` not just `".btn"`. The linter's regex patterns don't match the wrapped text.
- **Fix:** Added `extract_selector_value()` helper in `diagnostics.rs` that strips the `selector` keyword prefix and surrounding quotes before passing to `analyze_selector`.
- **Files modified:** `crates/intelligence/src/lsp/diagnostics.rs`.
- **Commit:** `3348f7e`.

**3. [Rule 2 - Missing Critical] Added threat mitigation tests (T-03-15-01, T-03-15-02).**
- **Found during:** Task 1 test drafting.
- **Issue:** Plan's threat model requires ReDoS mitigation and no-panic on malformed input, but neither is explicitly tested.
- **Fix:** Added `test_adversarial_10kb_selector_completes_fast` (asserts < 50ms on 10KB input) and `test_no_panic_on_malformed` (exercises empty, whitespace, null bytes, special chars).
- **Files modified:** `crates/intelligence/src/lsp/selector_lint.rs`.
- **Commit:** `3348f7e`.

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 missing-critical). **Impact:** All necessary for correctness. No scope creep.

## Verification

```bash
cargo test -p intelligence --lib -- lsp::selector_lint    # 13/13 passed
cargo test -p intelligence --lib -- lsp::diagnostics      # 2/2 passed
cargo test -p intelligence --test selector_lint_tests      # 3/3 passed
cargo test -p intelligence                                 # all passed (70 lib + integration)
```

**Task 1 acceptance criteria:**
- All 7 tests green (14 delivered) -- PASS
- `grep -c "SelectorIssue" selector_lint.rs` = 20 (>= 6) -- PASS
- `grep -c "selector-lint" diagnostics.rs` = 8 (>= 1) -- PASS

**Task 2 acceptance criteria:**
- `e11_confusion_matrix_meets_thresholds` passes -- PASS
- Precision = 1.0000 >= 0.80 -- PASS
- Recall = 0.8636 >= 0.70 -- PASS
- Total fixture entries = 31 >= 30 -- PASS

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|---------|
| T-03-15-01 (ReDoS) | mitigated | `regex` crate provides linear-time guarantees; `test_adversarial_10kb_selector_completes_fast` asserts 10KB input completes in < 50ms |
| T-03-15-02 (Panic on malformed) | mitigated | No `.unwrap()` on user input; all regex operations via `is_match`/`find_iter`; `test_no_panic_on_malformed` exercises empty/null/special chars without panic |

## Known Stubs

None. All 6 heuristic rules are fully implemented and tested.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register.

## Issues Encountered

None beyond the auto-fixed deviations. The main discovery was that the story parser stores the full token text (including `selector` keyword and quotes) in `SelectorOrText::Selector`, requiring an extraction step before linting.

## Authentication Gates

None -- pure-Rust implementation with no external service dependencies.

## User Setup Required

None -- no external service configuration required.

## Next Plan Readiness

- **Eval harness (Plan 21):** The E11 confusion-matrix test is CI-gatable. Future fixture additions will automatically be included in the precision/recall calculation.
- **LSP experience:** Selector warnings appear in the editor alongside parser diagnostics. The source field `"selector-lint"` allows UI filtering.
- No blockers.

## Handoff Notes

- `analyze_selector` takes a raw CSS/XPath selector string, not the parser wrapper. Callers outside the LSP pipeline should pass the bare selector value.
- The fixture corpus can be extended by adding entries to `known_broken.yaml` or `known_good.yaml`. The test will automatically pick up new entries and recompute metrics.
- 3 FN cases exist in the current corpus (documented in test output): `._a3f9b2_container` not flagged as TooGeneric (underscore prefix), `div.__module_abc12__wrapper` not flagged (underscore inside hash). These are acceptable heuristic limitations that don't impact the E11 thresholds.

## Self-Check: PASSED
