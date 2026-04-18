---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04b
subsystem: story-parser
tags: [dsl, parser, formatter, step-id, tier-2]
requires:
  - story-parser Tier 1 (plan 07-01) — AriaRole + SelectorOrText Tier 1 variants
  - uuid crate (1.x, features v4+v7+serde)
  - insta dev-dep (already pinned at 1.40)
provides:
  - Additive pest grammar rule `step_id_comment` + `uuidv7_text` on `command_line`
  - `ast::LineMeta { line, column, step_id: Option<Uuid> }` struct
  - `Command::step_id: Option<Uuid>` field on every variant
  - `Command::step_id()`, `Command::meta()`, `Command::clear_span()` accessors
  - Warn-on-invalid-UUID diagnostic (layer-2 semantic pass)
  - `story_parser::formatter::format_story(&Story) -> String` with full command-variant coverage
  - Tier 2 fixture `tests/fixtures/valid/tier2_step_ids.story`
  - `tests/round_trip.rs` — 3 parse-format-parse fixpoint tests + 1 insta snapshot
  - `tests/step_ids.rs` — 3 integration tests (positive, legacy-regression, warn-on-invalid)
  - Canonical insta snapshot at `tests/snapshots/round_trip__tier2_step_ids_formatted.snap`
  - Downstream `Command` initializers updated in `crates/automation/tests/*` with `step_id: None`
affects:
  - Any downstream code that constructs `Command::*` by struct literal — the
    `step_id: Option<Uuid>` field is now required (see automation test updates).
    `..Default::default()` is unavailable on Command because the enum has no
    per-variant Default; downstream writers must spell out `step_id: None`.
tech-stack:
  added:
    - "uuid = { version = \"1\", features = [\"v4\", \"v7\", \"serde\"] } — Tier 2 step-id round-trip"
  patterns:
    - "Additive grammar extension — COMMENT gains a negative lookahead `!(\" \"? ~ \"@id=\")` so the explicit `step_id_comment` rule wins without touching any Tier 1 target/command rule"
    - "Per-variant `step_id: Option<Uuid>` on the Command enum, exposed uniformly via `Command::meta() -> LineMeta` (mirrors existing `Command::span()` shape)"
    - "Invalid UUID degrades to `step_id = None` + warn-level diagnostic (never fails parsing) — consistent with the unknown-verb / unknown-role fallback pattern from 07-01"
    - "ts-rs `#[cfg_attr(feature = \"ts-export\", ts(optional, type = \"string\"))]` maps `Option<Uuid>` to `string?` in the generated TS mirror"
    - "Formatter is parse-format-parse structural fixpoint on the AST; byte spans are zeroed via `Command::clear_span()` and `Scene.span = Default::default()` before comparing"
    - "Free-form user comments explicitly NOT preserved — documented in `formatter.rs` module doc-comment; 07-04c invokes the formatter only when writing step ids back after first pick"
key-files:
  created:
    - crates/story-parser/src/formatter.rs
    - crates/story-parser/tests/fixtures/valid/tier2_step_ids.story
    - crates/story-parser/tests/step_ids.rs
    - crates/story-parser/tests/round_trip.rs
    - crates/story-parser/tests/snapshots/round_trip__tier2_step_ids_formatted.snap
  modified:
    - crates/story-parser/Cargo.toml
    - crates/story-parser/src/grammar.pest
    - crates/story-parser/src/ast.rs
    - crates/story-parser/src/lib.rs
    - crates/story-parser/src/lenient_tokenize.rs
    - crates/story-parser/src/semantic.rs
    - crates/automation/tests/capability_routing.rs
    - crates/automation/tests/selector.rs
    - packages/story-dsl/src/ast.ts
    - Cargo.lock
decisions:
  - "COMMENT rule rewritten with negative lookahead `!(\" \"? ~ \"@id=\")` so the silent implicit-comment eater refuses to eat step-id comments — the explicit `step_id_comment` rule then captures them. Preserves backwards compat for ordinary `# Phase 7 ...`-style comments."
  - "`step_id` placed as a per-variant field on `Command` (13 variants) rather than refactoring every variant to embed a `LineMeta` struct. Rationale: minimizes the diff surface for downstream crates and keeps the existing `span: Span` field layout identical. `Command::meta()` synthesizes a `LineMeta` view from `span.line`, `span.col`, and `step_id` on demand."
  - "Task 1 committed as a single commit (grammar + AST + tokenizer + semantic + fixture + tests) rather than a RED/GREEN split. Rationale: the AST field addition is a breaking change for the tokenizer and semantic layer; splitting would yield a non-buildable intermediate commit — explicitly forbidden by CLAUDE.md's 'no half-implementations' rule. Same sequencing precedent as plan 07-01 (see its SUMMARY §Deviations)."
metrics:
  duration: ~35 minutes
  completed-date: 2026-04-17
  tasks-completed: 2
  commits: 2
---

# Phase 07 Plan 04b: Parser step-id round-trip + minimal formatter Summary

**One-liner:** Land the Tier 2 parser+formatter slice — an additive pest grammar rule captures an optional trailing `# @id=<uuidv7>` comment on each command line into `Command.step_id: Option<Uuid>`, a new `story_parser::formatter::format_story` module serializes the AST back to DSL text, and three parse-format-parse fixpoint tests (plus an insta snapshot) prove the round-trip preserves step-id comments across the Tier 1 legacy-forms, Tier 1 new-forms, and Tier 2 step-ids fixtures. Tier 1 golden regression guard stays green.

## Commits

| Task | SHA | Title |
|------|-----|-------|
| 1 | `86d9cc42fb4413f981eff3d6a490da9992b7628a` | feat(07-04b): parser step-id round-trip — additive `# @id=<uuidv7>` comment → Command.step_id |
| 2 | `fb128549290ad8154769fd6f9db50fd05baf5cbf` | feat(07-04b): minimal story-parser formatter + parse-format-parse fixpoint |

## Grammar Diff (additive)

```pest
// COMMENT intentionally refuses to match `# @id=...` (optionally with one
// leading space) so the additive `step_id_comment` rule below can capture
// it instead. See `step_id_comment`.
COMMENT = _{ ("#" ~ !(" "? ~ "@id=") ~ (!NEWLINE ~ ANY)*) | ("/*" ~ (!"*/" ~ ANY)* ~ "*/") }

statement = { command_line | recovery_line }
// Additive: trailing step-id comment. Does not alter any Tier 1 target/command rule.
// `step_id_comment?` preserves legacy lines (no comment) byte-for-byte identically.
command_line = { command ~ step_id_comment? ~ EOI_OR_NL }
step_id_comment = { "#" ~ "@id=" ~ uuidv7_text }
uuidv7_text = @{ ASCII_ALPHANUMERIC ~ (ASCII_ALPHANUMERIC | "-")* }
```

The `uuidv7_text` rule is intentionally lax (any alphanumeric + dash sequence) — layer-2 `semantic.rs` enforces strict UUIDv7 validity via `uuid::Uuid::parse_str`. A malformed string emits a warn-level diagnostic and leaves `step_id = None` rather than failing the parse.

## Formatter scope

`format_story(&Story) -> String` covers:

- All 13 `Command` variants (navigate, click, type, scroll, hover, drag, select, upload, wait, wait-for, assert, screenshot, pause).
- All 7 `SelectorOrText` target forms including Tier 1 role/field/text-exact.
- `meta` block (app, viewport, theme, speed), emitted only when at least one field is set.
- Trailing `# @id=<uuid>` step-id comments (canonical two-space gap before the hash).
- Indentation: scenes at 2 spaces, commands at 4 spaces, meta entries at 4 spaces.

**Known limitation (documented in `formatter.rs` module doc-comment):**

> Free-form user comments (anything starting with `#` that is NOT a `# @id=<uuidv7>` step-id comment) are NOT preserved. This formatter is invoked only when writing step ids back to `.story` source after a first pick (plan 07-04c territory); user-authored files are not auto-formatted.

Blank lines between scenes/commands are also not preserved — output has canonical whitespace.

## Insta snapshot

`crates/story-parser/tests/snapshots/round_trip__tier2_step_ids_formatted.snap`:

```
source: crates/story-parser/tests/round_trip.rs
expression: formatted
---
story "Tier 2 step ids" {
  meta {
    app: "https://example.com"
  }
  scene "picked" {
    click button "Save"  # @id=018f4c1e-7b3a-7000-8000-000000000001
    click link "Docs"  # @id=018f4c1e-7b3a-7000-8000-000000000002
    click "No step id yet"
  }
}
```

## Tier 1 Regression Guard

```
$ cargo test -p story-parser --test golden
running 9 tests
test empty_input_is_valid ... ok
test whitespace_only_is_valid ... ok
test click_target_text_extracted ... ok
test parses_simple_fixture ... ok
test every_node_has_nonzero_span ... ok
test span_invariant_verb_in_substring ... ok
test tier1_legacy_forms_fixture_uses_only_pre_phase7_variants ... ok
test parses_all_verbs_fixture ... ok
test tier1_new_forms_fixture_parses_clean_with_expected_variants ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

All 9 Tier 1 golden fixtures still pass — grammar extension is verifiably additive. Full story-parser test count (lib + 5 integration files): **50 tests pass, 0 fail**.

## Acceptance Criteria

- [x] `cargo build -p story-parser` exits 0
- [x] `cargo test -p story-parser` exits 0 (50/50 tests green)
- [x] `cargo test -p story-parser --test golden` exits 0 — Tier 1 regression guard PASSED
- [x] `grep -n "step_id_comment" crates/story-parser/src/grammar.pest` matches
- [x] `grep -n "Additive: trailing step-id comment" crates/story-parser/src/grammar.pest` matches
- [x] `grep -n "step_id: Option<Uuid>" crates/story-parser/src/ast.rs` matches (14 occurrences — LineMeta + 13 Command variants)
- [x] `grep -n "uuid" crates/story-parser/Cargo.toml` matches
- [x] tier2_step_ids.story fixture contains two `@id=` comments + one bare command
- [x] `step_id_comment_is_parsed_into_line_meta` passes
- [x] `legacy_fixtures_have_no_step_ids` passes (regression on 07-01 fixtures + simple + all-verbs)
- [x] `invalid_uuid_emits_warn_not_error` passes
- [x] `cargo test -p story-parser --test round_trip` exits 0 with 4 tests green
- [x] Insta snapshot `round_trip__tier2_step_ids_formatted.snap` committed
- [x] No `todo!()` or `unimplemented!()` in formatter
- [x] Module doc comment on `formatter.rs` documents the free-form-comment limitation

## Deviations from Plan

**[Rule 3 — Build sequencing]** Task 1 was committed as a single atomic commit (grammar + AST + tokenizer + semantic + fixture + tests + downstream test fixups) rather than a RED/GREEN TDD split. Rationale: adding `step_id: Option<Uuid>` to every `Command` enum variant is a breaking field addition for the lenient tokenizer, the semantic layer, and downstream automation tests simultaneously — splitting would yield a non-building intermediate commit, explicitly forbidden by CLAUDE.md ("no half-implementations, no workarounds"). Same sequencing precedent was set by plan 07-01 (see its SUMMARY §Deviations). The end-state code matches the plan contract verbatim; only the per-commit sequencing differs.

**[Rule 3 — Downstream test fixups]** The plan did not enumerate downstream crates that construct `Command::*` by struct literal. Two such sites existed (`crates/automation/tests/selector.rs` 5 call sites, `crates/automation/tests/capability_routing.rs` 5 call sites). Each was updated with `step_id: None`. These are pure mechanical additions — no behavior change — and are required to keep the workspace build green. Documented as part of the Task 1 commit.

**Files modified for Rule 3 fixups:** `crates/automation/tests/selector.rs`, `crates/automation/tests/capability_routing.rs`.
**Commit:** `86d9cc42fb4413f981eff3d6a490da9992b7628a` (Task 1).

## Auth Gates

None. Fully offline parser + formatter work.

## Known Stubs

None. The formatter covers every `Command` and `SelectorOrText` variant — no `todo!()`, no `unimplemented!()`, no placeholder branches. The free-form-comment limitation is a documented design choice (out of scope), not a stub.

## Self-Check: PASSED

Files created:
- `crates/story-parser/src/formatter.rs` — FOUND
- `crates/story-parser/tests/fixtures/valid/tier2_step_ids.story` — FOUND
- `crates/story-parser/tests/step_ids.rs` — FOUND
- `crates/story-parser/tests/round_trip.rs` — FOUND
- `crates/story-parser/tests/snapshots/round_trip__tier2_step_ids_formatted.snap` — FOUND

Files modified:
- `crates/story-parser/Cargo.toml` — uuid dep present ✓
- `crates/story-parser/src/grammar.pest` — `step_id_comment` + `Additive:` marker present ✓
- `crates/story-parser/src/ast.rs` — `LineMeta` struct + 13 per-variant `step_id` fields ✓
- `crates/story-parser/src/lib.rs` — `pub mod formatter;` + `pub use formatter::format_story;` ✓
- `crates/story-parser/src/lenient_tokenize.rs` — `LenientToken::Command.step_id_raw` ✓
- `crates/story-parser/src/semantic.rs` — warn-on-invalid-UUID diagnostic + `build_command` threads `step_id` ✓
- `crates/automation/tests/capability_routing.rs` — downstream `step_id: None` fixups ✓
- `crates/automation/tests/selector.rs` — downstream `step_id: None` fixups ✓
- `packages/story-dsl/src/ast.ts` — regenerated; `step_id?: string` flows through to TS mirror ✓

Commits:
- `86d9cc42fb4413f981eff3d6a490da9992b7628a` (Task 1) — FOUND in `git log`
- `fb128549290ad8154769fd6f9db50fd05baf5cbf` (Task 2) — FOUND in `git log`

Gate results:
- `cargo test -p story-parser --test golden`: 9/9 pass (Tier 1 regression guard) ✓
- `cargo test -p story-parser --test round_trip`: 4/4 pass (3 fixpoints + 1 snapshot) ✓
- `cargo test -p story-parser --test step_ids`: 3/3 pass ✓
- `cargo test -p story-parser` (full suite): 50/50 pass ✓
