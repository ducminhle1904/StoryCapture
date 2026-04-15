---
phase: 01-foundation-dsl-automation-capture-encode
plan: 04
subsystem: dsl-parser
tags: [dsl, pest, parser, ast, diagnostics, ts-mirror, two-layer-parse, levenshtein, panic-mode-recovery, wave-1]
requirements:
  - DSL-01
  - DSL-02
  - DSL-03
  - DSL-04
  - DSL-05
  - DSL-06
  - DSL-07
dependency-graph:
  requires:
    - "01-01 (monorepo scaffold) — `crates/story-parser` empty crate + `packages/story-dsl` empty package"
  provides:
    - "Pure `story-parser` Rust crate (zero Tauri deps, CLI-ready)"
    - "Public API: `parse(&str) -> ParseResult { ast, diagnostics }` + `parse_file(&Path) -> io::Result<ParseResult>` (10 MB cap)"
    - "Typed AST: `Story`, `Meta`, `Viewport`, `Theme`, `Scene`, `Command` (13 verbs), `SelectorOrText`, `ScrollDir` — every node carries `Span { start, end, line, col }`"
    - "Two-layer parse: lenient pest tokenize (layer 1) + semantic validation (layer 2)"
    - "Panic-mode recovery: multi-error reporting from a single `parse()` call (tested with 6+ errors in one fixture)"
    - "Levenshtein 'did you mean' suggestions for unknown verbs and unknown meta keys"
    - "ts-rs auto-emitted TS mirror at `packages/story-dsl/src/ast.ts` (34 lines, 11 exported types)"
    - "`@storycapture/story-dsl` typecheck script wired (`pnpm --filter ... typecheck` exits 0)"
  affects:
    - "01-06 (BrowserDriver) — consumes `Story`, `Scene`, `Command`, `SelectorOrText` to drive the executor"
    - "01-09 (UI editor) — consumes `packages/story-dsl/src/ast.ts` for CodeMirror diagnostics + autocomplete"
    - "01-10 (release CI) — adds `cargo test -p story-parser && git diff --exit-code packages/story-dsl/src/ast.ts` drift gate"
    - "Phase 5 headless CLI — can depend on `story-parser` directly without Tauri"
tech-stack:
  added:
    - "pest 2.7 (resolved 2.8.6) — parser generator"
    - "pest_derive 2.7 (resolved 2.8.6) — `#[derive(Parser)]` macro"
    - "strsim 0.11.1 — Levenshtein distance for did-you-mean suggestions"
    - "ts-rs 10.1.0 — Rust → TypeScript type generation (default-on via `ts-export` feature)"
    - "specta 2.0.0-rc.22 — opt-in via `specta-types` feature (kept dormant; ts-rs is the active path)"
    - "insta 1.40 (dev) — snapshot testing harness (available, not yet exercised)"
    - "proptest 1.5 (dev) — property-based tests (available, not yet exercised)"
  patterns:
    - "Two-layer parse: pest layer 1 emits `LenientToken` stream including `Unknown { text, span }` for any line the grammar can't match; layer 2 (`semantic.rs`) walks the stream into the typed AST while emitting diagnostics — single source of `did you mean` UX (D-08)."
    - "Panic-mode recovery: `recover.rs` rebuilds a best-effort `LenientToken` stream when pest itself returns `Err`, so `parse()` always yields multiple diagnostics in a single pass (D-09)."
    - "Span-everywhere: every AST node has a `Span` derived from `pest::Pair::as_span()` + `start_pos().line_col()`. `Command::span()` accessor centralises lookup."
    - "Public API surface deliberately small (`parse`, `parse_file`, `ParseResult`, `Story`, `Diagnostic`, `Severity`, plus the AST types). All internals (`lenient_tokenize`, `semantic`, `recover`, `suggest`) are public modules but consumers should rely on the re-exports."
    - "TS mirror codegen pinned to `cargo test`: every `#[derive(TS)]` type emits an `export_bindings_*` test that writes the corresponding TS to disk on `cargo test`. CI gate (Plan 10) then `git diff --exit-code`s `packages/story-dsl/src/ast.ts` to detect drift (D-10)."
    - "Pure-crate discipline: `Cargo.toml` lists only pest/serde/thiserror/strsim/ts-rs/specta — no Tauri or platform-native crates. `cargo tree -p story-parser | grep -i tauri` returns zero matches (DSL-07)."
key-files:
  created:
    - "crates/story-parser/src/grammar.pest — pest grammar (104 lines): file/story_block/meta_block/scene_block + 13 verb rules + target/direction/duration/string/number/ident terminals"
    - "crates/story-parser/src/ast.rs — typed AST: Story, Meta, Viewport, Theme, Scene, SelectorOrText, ScrollDir, Command, Span; serde + ts-rs derives"
    - "crates/story-parser/src/diagnostic.rs — Diagnostic, Severity (Error|Warning|Info) + builder helpers"
    - "crates/story-parser/src/parser.rs — `pest_derive::Parser` impl (StoryParser) + public `parse()` entrypoint orchestrating layer 1 → layer 2"
    - "crates/story-parser/src/lenient_tokenize.rs — pest pair walker producing `Vec<LenientToken>`; handles MetaEntry, SceneStart/End, Command, Unknown"
    - "crates/story-parser/src/semantic.rs — layer-2 validator: builds Story AST, validates meta keys/values, emits diagnostics with did-you-mean for unknown verbs/keys"
    - "crates/story-parser/src/recover.rs — line-based fallback when pest returns Err; produces best-effort LenientToken stream + 1 pest-error diagnostic"
    - "crates/story-parser/src/suggest.rs — `KNOWN_VERBS` + `KNOWN_META_KEYS` slices; `did_you_mean(input, candidates)` via `strsim::levenshtein` (≤ 2 distance threshold)"
    - "crates/story-parser/src/io.rs — `parse_file(&Path)` with 10 MB size cap (T-04-01) and explicit UTF-8 validation (T-04-04)"
    - "crates/story-parser/src/lib.rs — module declarations + re-exports of the public API"
    - "crates/story-parser/tests/golden.rs — 7 tests: empty/whitespace, simple fixture, all-verbs fixture, span invariants, click target extraction"
    - "crates/story-parser/tests/errors.rs — 9 tests: typo suggestion, multi-error recovery (≥6 in one pass), span validity, AST-with-errors, unknown meta key (+suggestion), speed range warning, viewport pair parse, missing-brace recovery"
    - "crates/story-parser/tests/fixtures/valid/simple.story — canonical PROJECT.md sample with all 4 meta keys + 1 scene + 5 commands"
    - "crates/story-parser/tests/fixtures/valid/all-verbs.story — single scene exercising every one of the 13 verbs in canonical order"
    - "crates/story-parser/tests/fixtures/invalid/typo.story — 1 misspelled verb (`clik`) for did-you-mean test"
    - "crates/story-parser/tests/fixtures/invalid/multi-error.story — 5 misspelled verbs + 2 misspelled meta keys for multi-error/recovery test"
    - "packages/story-dsl/src/ast.ts — auto-generated TS mirror (34 lines, 11 exported types)"
    - "packages/story-dsl/tsconfig.json — extends config/tsconfig.base.json, strict, noEmit"
  modified:
    - "crates/story-parser/Cargo.toml — added pest, pest_derive, strsim, ts-rs (default), specta (opt-in), insta + proptest dev-deps; declared `ts-export` and `specta-types` feature flags"
    - "crates/story-parser/src/lib.rs — replaced scaffold stub with module declarations + public re-exports"
    - "packages/story-dsl/package.json — added typescript devDep + `typecheck` script"
    - "packages/story-dsl/src/index.ts — replaced scaffold stub with `export * from './ast'`"
    - "Cargo.lock + pnpm-lock.yaml — refreshed for new deps"
decisions:
  - "Picked ts-rs over specta as the active TS-mirror generator. Both are declared in Cargo.toml (different feature flags) so the swap is one feature toggle, but ts-rs (a) ships byte-stable output without a runtime, (b) needs no `cargo run` step (writes during `cargo test`), and (c) uses standalone derive macros that compose cleanly with serde. specta is kept available for later if Tauri integration via `tauri-specta` ever benefits from a single source — but for the pure parser crate, ts-rs is the lower-overhead choice."
  - "Committed the canonical viewport grammar to `WIDTHxHEIGHT` literal (per PROJECT.md spec / RESEARCH.md Q3) AND additionally accept the `{ width, height }` struct form AND the named idents `desktop|tablet|mobile`. The plan body's grammar example only listed the named idents + struct form; the critical-context block in the executor brief insisted on `WIDTHxHEIGHT`. Supporting all three is conservative, prevents future churn, and the diagnostic message names the canonical form first."
  - "Grammar's `EOI_OR_NL` accepts `NEWLINE+ | ';' | &EOI | &'}''`. This relaxation lets one-line forms parse (e.g. `meta { app: \"x\" }` and `scene \"s\" { pause }`) — important for inline tests and for future templates without compromising the canonical multi-line aesthetic."
  - "ts-rs `export_to` uses three `..` segments (e.g. `\"../../../packages/story-dsl/src/ast.ts\"`) because ts-rs 10 resolves the path relative to its internal `bindings/` working directory under `CARGO_MANIFEST_DIR`, not the manifest dir itself. Without the extra `..` the file lands at `crates/packages/...`."
  - "Defined the public AST as both `Command::Wait { duration_ms: u64, ... }` and `WaitFor { ..., timeout_ms: Option<u64> }` (the unit conversion happens in `lenient_tokenize::parse_duration` so consumers never need to interpret `1500ms` vs `2s`)."
  - "Used `LenientToken::Unknown` instead of letting pest fail outright on unknown verbs. The pest grammar's `recovery_line` rule matches any non-empty non-`}` line that isn't a recognised command — these flow through to layer 2 where semantic.rs runs `did_you_mean` against `KNOWN_VERBS`. This satisfies DSL-05 + DSL-06 in a single mechanism."
metrics:
  duration_minutes: 8
  task_count: 2
  files_created: 18
  files_modified: 5
  lines_of_rust: ~1500
  lines_of_pest: 104
  lines_of_generated_ts: 34
  ts_exported_types: 11
  pest_grammar_rules: 36
  dsl_verbs_supported: 13
  test_count: 31  # 15 unit + 7 golden + 9 errors
  parse_throughput_1000_lines_release: "16ms (budget: <50ms)"
  completed: 2026-04-14
---

# Phase 1 Plan 04: Story DSL parser Summary

**A pure, Tauri-free `story-parser` Rust crate that turns `.story` files into a typed AST with span info on every node, uses a two-layer pipeline (lenient pest tokenize → semantic validation) for human-readable diagnostics with Levenshtein "did you mean" suggestions and panic-mode recovery for multi-error single-pass reports, with TS mirror types auto-emitted to `@storycapture/story-dsl` via ts-rs.**

## Outcome

DSL-01 through DSL-07 discharged. The parser exposes a 4-symbol public surface (`parse`, `parse_file`, `ParseResult`, `Diagnostic`) plus the AST types. All 13 DSL verbs from PROJECT.md's "STORY DSL SPECIFICATION" parse into structured `Command` enum variants with verb-specific payloads (URL, target, text, direction, amount, duration_ms, timeout_ms, name). The crate has zero Tauri dependencies — Phase 5's headless CLI can consume it unchanged. The TS mirror at `packages/story-dsl/src/ast.ts` is generated on every `cargo test -p story-parser` and committed to git so TS consumers don't depend on Rust being built first.

`cargo test -p story-parser` runs 31 tests (15 unit, 7 golden, 9 errors) — all green. `cargo tree -p story-parser | grep -i tauri` returns nothing. `pnpm --filter @storycapture/story-dsl typecheck` exits 0. A 1000-command synthetic story parses in **16 ms (release)** — 3× under the 50 ms budget called out in the plan output spec.

## Performance

- **1000-command parse (release build):** 16 ms (budget: <50 ms)
- **Cold `cargo build -p story-parser`:** 7.9 s (24 transitive dep crates added)
- **Cold `cargo test -p story-parser`:** ~6 s
- **Generated `ast.ts` size:** 34 lines, 11 exported types

## Pest grammar rule count + verb coverage

`crates/story-parser/src/grammar.pest` defines **36 named rules** (excluding implicit silent rules):

- 1 file/entry rule (`file`)
- 3 block rules (`story_block`, `meta_block`, `scene_block`)
- 1 statement rule + 1 recovery rule (`statement`, `command_line`, `recovery_line`)
- 13 command rules (`cmd_navigate`, `cmd_click`, `cmd_type`, `cmd_scroll`, `cmd_hover`, `cmd_drag`, `cmd_select`, `cmd_upload`, `cmd_wait`, `cmd_wait_for`, `cmd_assert`, `cmd_screenshot`, `cmd_pause`)
- 5 target rules (`target`, `target_text`, `target_selector`, `target_testid`, `target_aria`)
- 4 meta rules (`meta_entry`, `meta_key`, `meta_value`, `viewport_pair`, `viewport_struct`)
- 8 terminals (`direction`, `duration`, `duration_unit`, `number_lit`, `string`, `number`, `ident`)

All 13 verbs from PROJECT.md "STORY DSL SPECIFICATION" supported:

| Verb         | Grammar                              | AST variant   |
|--------------|--------------------------------------|---------------|
| `navigate`   | `"navigate" ~ string`                | `Navigate`    |
| `click`      | `"click" ~ target`                   | `Click`       |
| `type`       | `"type" ~ target ~ string`           | `Type`        |
| `scroll`     | `"scroll" ~ direction ~ number?`     | `Scroll`      |
| `hover`      | `"hover" ~ target`                   | `Hover`       |
| `drag`       | `"drag" ~ target ~ "to" ~ target`    | `Drag`        |
| `select`     | `"select" ~ target ~ string`         | `Select`      |
| `upload`     | `"upload" ~ target ~ string`         | `Upload`      |
| `wait`       | `"wait" ~ duration`                  | `Wait`        |
| `wait-for`   | `"wait-for" ~ target ~ ...`          | `WaitFor`     |
| `assert`     | `"assert" ~ target`                  | `Assert`      |
| `screenshot` | `"screenshot" ~ string`              | `Screenshot`  |
| `pause`      | `"pause"`                            | `Pause`       |

## Benchmark of parsing a 1000-line story

Generated ad-hoc benchmark: a story with one scene containing 1000 `click "Save"` commands, parsed via `parse(&str)` in release mode.

```
parsed 1008 lines in 15.974ms; commands=1000, diags=0
```

**16 ms** for 1000 verb invocations — well under the 50 ms budget. Allocator is unoptimised (default `String` everywhere); a future hot-path could intern strings if real-world stories ever push past 50k commands.

## Notes on ts-rs vs. specta choice

Both were declared in `Cargo.toml` so the swap is a single feature toggle. Picked **ts-rs** as the active path:

| Criterion             | ts-rs                                            | specta                                         |
|-----------------------|--------------------------------------------------|------------------------------------------------|
| Runtime needed?       | No — writes during `cargo test`                  | Yes — needs a `cargo run` emit step            |
| Standalone derive     | Yes (`#[derive(TS)]`)                            | Yes (`#[derive(Type)]`) but plays best with `tauri-specta` |
| Output stability      | Byte-stable, sorted, deterministic               | Stable but format depends on `specta-typescript` major |
| Pure-crate fit        | Excellent — zero ecosystem coupling              | Good — but pulls `tauri-specta` ergonomics into play |
| Path resolution       | `export_to` relative to `bindings/` (3× `..`)    | Configured at emit-call site                   |

For the pure parser crate, ts-rs wins on overhead and predictability. specta is kept available for later if a unified Tauri + parser TS surface ever justifies it.

## Grammar ambiguities resolved

1. **Viewport literal vs. struct vs. ident** — three accepted forms (`1280x800`, `{ width: 1280, height: 800 }`, `desktop|tablet|mobile`). Documented in the diagnostic message: invalid values name `WIDTHxHEIGHT` first.
2. **Meta entry separators** — accepts newline, `;`, or `,` (the comma form makes one-line `meta { app: "x", viewport: 1280x800 }` parse, important for templates).
3. **Inline blocks** — relaxed `NEWLINE+` after `{` to `NEWLINE*` so single-line forms parse for tests and macros. Multi-line remains the canonical aesthetic.
4. **`drag … to …`** — kept the `"to"` keyword as a literal grammar token rather than a separator-typed rule, so error messages mention the exact bad token.
5. **`wait-for "X" timeout 5s`** — `timeout` is a keyword, `duration` is a single typed terminal (`5s`, `500ms`, `2m`). The `parse_duration` helper normalises to `u64` ms before the AST sees it.
6. **String escapes** — supports `\"`, `\\`, `\n`, `\t`. Other backslash escapes pass the trailing char through verbatim (matching common DSL conventions).
7. **Comments** — `# line comment` AND `/* block comment */` both supported via the silent `COMMENT` rule.

## Task Commits

1. **Task 1: pest grammar + typed AST + two-layer parse pipeline** — `9fde121` (feat)
2. **Task 2: error-path tests + ts-rs TS mirror in @storycapture/story-dsl** — `1aa1954` (feat)

_Per parallel-execution protocol the orchestrator owns the metadata commit (SUMMARY.md + STATE.md + ROADMAP.md). This agent commits implementation files + the SUMMARY itself in a separate dedicated commit (below)._

## Verification

- `cargo test -p story-parser` — **31 passed, 0 failed, 0 ignored** (15 unit + 7 golden + 9 errors)
- `cargo test -p story-parser --test golden` — 7/7 ✓
- `cargo test -p story-parser --test errors` — 9/9 ✓ (including `multi_error_recovery` asserting ≥ 6 diagnostics from one pass)
- `cargo build -p story-parser` — exits 0 (cold 7.9 s)
- `cargo tree -p story-parser | grep -i tauri` — no matches (DSL-07 purity proven)
- `wc -l packages/story-dsl/src/ast.ts` — 34 lines
- `grep "^export" packages/story-dsl/src/ast.ts | wc -l` — 12 (one per type)
- `grep -q "export type Story" packages/story-dsl/src/ast.ts` ✓
- `grep -q "export type Span" packages/story-dsl/src/ast.ts` ✓
- `grep -q "export type Diagnostic" packages/story-dsl/src/ast.ts` ✓
- `grep -q "export type Command" packages/story-dsl/src/ast.ts` ✓
- `pnpm --filter @storycapture/story-dsl typecheck` — exits 0
- 1000-command release-build benchmark: 16 ms (budget < 50 ms)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical functionality] Added named-ident viewport presets in addition to `WIDTHxHEIGHT`**
- **Found during:** Task 1, grammar design.
- **Issue:** The plan body's grammar example only listed `desktop|tablet|mobile` and the `{ width, height }` struct form. The critical-context block in the executor brief insisted on `viewport: 1280x800` literal pair. PROJECT.md's STORY DSL SPECIFICATION uses `1280x800`. The conservative move is to accept all three forms and let downstream UI surface the canonical literal in diagnostics.
- **Fix:** Grammar accepts `viewport_pair` (`1280x800`), `viewport_struct` (`{ width: N, height: N }`), and named idents (`desktop` → 1280×800, `tablet` → 1024×768, `mobile` → 375×667). Diagnostic for invalid input names `WIDTHxHEIGHT` first.
- **Files:** `crates/story-parser/src/grammar.pest`, `crates/story-parser/src/semantic.rs`
- **Commit:** `9fde121`

**2. [Rule 3 — Blocking] Relaxed `NEWLINE+` to `NEWLINE*` after `{`**
- **Found during:** Task 2, errors.rs tests using inline forms (e.g. `meta { spped: 1.0 }`).
- **Issue:** Strict `NEWLINE+` after every `{` rejected one-line block forms — convenient for tests, fixtures, and future macros.
- **Fix:** Changed to `NEWLINE*` in `story_block`, `meta_block`, `scene_block`. Added `;` and `&"}"` as accepted statement/entry separators. Multi-line remains the canonical aesthetic; single-line is now permitted.
- **Files:** `crates/story-parser/src/grammar.pest`
- **Commit:** `9fde121` (initial draft) + lockfile in `1aa1954`

**3. [Rule 3 — Blocking] Fixed ts-rs `export_to` path (extra `..` segment)**
- **Found during:** Task 1, post-cargo-test inspection. ts-rs wrote `crates/packages/story-dsl/src/ast.ts` instead of `packages/story-dsl/src/ast.ts`.
- **Issue:** ts-rs 10 resolves `export_to` relative to its internal `bindings/` working directory under `CARGO_MANIFEST_DIR`, not the manifest dir itself. Two `..` only escapes the crate; three escape the workspace-relative path.
- **Fix:** Changed `"../../packages/story-dsl/src/ast.ts"` → `"../../../packages/story-dsl/src/ast.ts"` on every `#[ts(export_to = ...)]` attribute (10 sites).
- **Files:** `crates/story-parser/src/ast.rs`, `crates/story-parser/src/diagnostic.rs`, `crates/story-parser/src/parser.rs`
- **Commit:** `9fde121`

**4. [Rule 2 — Missing critical functionality] Added `typecheck` script + `tsconfig.json` to `@storycapture/story-dsl`**
- **Found during:** Task 2 success-criteria verification (`pnpm --filter ... typecheck` was specified but the package had no `scripts.typecheck`).
- **Issue:** Without a `tsconfig.json` + script, the success criterion's typecheck command would fail.
- **Fix:** Added `tsconfig.json` extending the workspace base + `typecheck: "tsc --noEmit -p tsconfig.json"` script + `typescript` and `@storycapture/config` dev-deps.
- **Files:** `packages/story-dsl/package.json`, `packages/story-dsl/tsconfig.json`
- **Commit:** `1aa1954`

**5. [Rule 2 — Missing critical functionality] Added `parse_duration` helper that normalises to milliseconds before the AST**
- **Found during:** Task 1, AST design.
- **Issue:** Plan's interfaces block typed `Wait { duration_ms: u64 }` but didn't specify how `2s`/`500ms`/`3m` get converted. Without a helper, every consumer would have to re-implement.
- **Fix:** `lenient_tokenize::parse_duration(&str) -> u64` strips the unit suffix and multiplies. The AST sees a single normalised `u64`.
- **Files:** `crates/story-parser/src/lenient_tokenize.rs`
- **Commit:** `9fde121`

---

**Total deviations:** 5. None architectural (no Rule 4 escalations).
- 2 grammar relaxations (additional viewport form, inline block support).
- 1 ts-rs path fix (build-system gotcha).
- 1 missing typecheck wiring.
- 1 helper API added.

## Authentication Gates

None. The parser is a pure offline crate.

## Issues Encountered

- **Initial scene-token ordering bug.** `walk_scene_block` originally inserted `SceneStart` AFTER processing all child statements (because `out.insert(out.len(), ...)` was meant to mark a position, but the position was captured AFTER iteration). Fixed by extracting the scene name first and pushing `SceneStart` before walking children. Caught by golden tests on the first run.
- **`cargo` not on PATH.** Resolved by sourcing `$HOME/.cargo/env` in every Bash invocation (the worktree shell does not pick it up automatically).
- **ts-rs `export_to` ambiguity.** See deviation #3.

## Threat Surface Scan

No new surfaces beyond the plan's `<threat_model>`. T-04-01 (DoS via huge file) is mitigated by the 10 MB cap in `io.rs`. T-04-04 (malformed UTF-8) is mitigated by explicit `std::str::from_utf8` validation in `parse_file`. T-04-02 (TS mirror drift) is mitigated by the auto-emit pattern + planned Plan 10 CI gate. T-04-03 (path leakage) is honoured: diagnostics carry only byte offsets and line/col, never paths.

## Next Plan Readiness

- **Plan 01-06 (BrowserDriver):** Can begin. `Story`, `Scene`, `Command`, `SelectorOrText` are the public surface the executor walks. The `Command::span()` accessor gives the executor a precise source range to surface in `AppError::ExecutionFailed` payloads.
- **Plan 01-09 (Story Editor UI):** Can begin. `packages/story-dsl/src/ast.ts` is committed and typechecks. CodeMirror diagnostics provider can map `Diagnostic { span: { line, col, start, end } }` to CM6 `Diagnostic` records 1:1.
- **Plan 01-10 (release CI):** Can extend its workflow with `cargo test -p story-parser && git diff --exit-code packages/story-dsl/src/ast.ts` to enforce the no-drift contract.
- **Phase 5 headless CLI (deferred):** The crate is ready as a direct dependency — zero Tauri imports, `parse_file` is the natural CLI entrypoint.

## Self-Check

**Files created (verified on disk):**
- FOUND: `crates/story-parser/src/grammar.pest`
- FOUND: `crates/story-parser/src/ast.rs`
- FOUND: `crates/story-parser/src/diagnostic.rs`
- FOUND: `crates/story-parser/src/parser.rs`
- FOUND: `crates/story-parser/src/lenient_tokenize.rs`
- FOUND: `crates/story-parser/src/semantic.rs`
- FOUND: `crates/story-parser/src/recover.rs`
- FOUND: `crates/story-parser/src/suggest.rs`
- FOUND: `crates/story-parser/src/io.rs`
- FOUND: `crates/story-parser/tests/golden.rs`
- FOUND: `crates/story-parser/tests/errors.rs`
- FOUND: `crates/story-parser/tests/fixtures/valid/simple.story`
- FOUND: `crates/story-parser/tests/fixtures/valid/all-verbs.story`
- FOUND: `crates/story-parser/tests/fixtures/invalid/typo.story`
- FOUND: `crates/story-parser/tests/fixtures/invalid/multi-error.story`
- FOUND: `packages/story-dsl/src/ast.ts`
- FOUND: `packages/story-dsl/tsconfig.json`

**Commits (verified in `git log --oneline`):**
- FOUND: `9fde121` feat(01-04): pest grammar + typed AST + two-layer parse pipeline for Story DSL
- FOUND: `1aa1954` feat(01-04): error-path tests + ts-rs TS mirror in @storycapture/story-dsl

**Behavior (verified via cargo + pnpm):**
- FOUND: `cargo test -p story-parser` → 31/31 passed
- FOUND: `cargo tree -p story-parser | grep -i tauri` → no matches
- FOUND: `pnpm --filter @storycapture/story-dsl typecheck` → exits 0
- FOUND: 1000-command release benchmark → 16 ms

## Self-Check: PASSED

---
*Phase: 01-foundation-dsl-automation-capture-encode*
*Plan: 04 — Story DSL parser*
*Completed: 2026-04-14 (worktree agent-a2974203)*
