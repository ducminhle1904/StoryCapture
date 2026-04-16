---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 13
subsystem: intelligence
tags: [rust, tower-lsp, language-server, dsl, pest, ropey, dashmap]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: intelligence crate (host module)
  - phase: 01-foundation-dsl-automation-capture-encode/*
    provides: crates/story-parser (pest grammar + parse + Levenshtein suggest)
provides:
  - "intelligence::lsp::StoryLanguageServer (tower_lsp::LanguageServer impl)"
  - "intelligence::lsp::diagnostics::{diagnose, grammar_diagnostics, semantic_diagnostics, VERB_CATALOG, verb_doc, verb_list}"
  - "intelligence::lsp::document::{apply_changes, identifier_at, byte_offset_to_position, byte_range_to_lsp_range, position_to_char}"
  - "intelligence::lsp::server::testing::InProcessServer (test facade)"
affects:
  - "Plan 03-14 (IPC bridge) — consumes StoryLanguageServer via LspService"
  - "Desktop shell (future) — wires tauri IPC to this language server"
tech-stack:
  added:
    - "dashmap 6 (concurrent Url → Rope map)"
    - "ropey 1.6 (rope for incremental edits + UTF-8 safe offsets)"
  patterns:
    - "Shared grammar (D-16): LSP reuses story_parser::parse directly — no stdio, no sidecar"
    - "Severity remapping at the LSP boundary — parser emits Error for unknown verbs, LSP surfaces as WARNING per D-17 (semantic ≠ grammar)"
    - "Testable facade pattern — InProcessServer shares all logic with the real LanguageServer impl but skips the JSON-RPC transport"
key-files:
  created:
    - crates/intelligence/src/lsp/mod.rs
    - crates/intelligence/src/lsp/server.rs
    - crates/intelligence/src/lsp/diagnostics.rs
    - crates/intelligence/src/lsp/document.rs
    - crates/intelligence/tests/lsp_server_tests.rs
  modified:
    - crates/intelligence/Cargo.toml
    - crates/intelligence/src/lib.rs
    - Cargo.lock
key-decisions:
  - "Use story_parser::parse (actual public fn) instead of the plan's referenced `parse_story` — name drift. parse() already concatenates grammar + semantic diagnostics, so no separate semantic pass is needed."
  - "Define VERB_CATALOG locally in lsp/diagnostics.rs rather than depending on a yet-to-exist crates/intelligence/src/nl/verb_whitelist.rs — keeps plan 03-13 self-contained. A future NL plan can consolidate."
  - "Remap unknown-verb Errors to WARNING at the LSP boundary (D-17). The parser classifies them as Error because they break the typed AST; the LSP user-facing story is recoverable ('Did you mean click?'), which is WARNING semantics."
  - "Test via InProcessServer facade, not a full tower-lsp LspService+duplex — avoids standing up an async transport just to assert document state + diagnostic content. The facade calls the same diagnose/identifier_at/verb_doc helpers as the real LanguageServer impl."
  - "Identifier extraction uses [A-Za-z0-9_-]+ (word chars including hyphen) so `wait-for` is a single identifier, matching the grammar's verb tokenization."
requirements-completed: [AI-06]
metrics:
  tasks_completed: 1
  tasks_total: 1
  files_created: 5
  files_modified: 3
  duration_minutes: ~15
  completed: 2026-04-15
---

# Phase 03 Plan 13: In-Process Language Server for .story Files Summary

In-process `tower-lsp` `LanguageServer` for `.story` files that shares `crates/story-parser` directly (D-16) — document tracking, incremental edits via `ropey`, diagnostic publish on every change, hover + prefix-filtered completion backed by a local `VERB_CATALOG`.

## What Was Built

**`StoryLanguageServer` (`lsp/server.rs`)** — implements the six `tower_lsp::LanguageServer` methods required by the plan (`initialize`, `did_open`, `did_change`, `did_close`, `hover`, `completion`) plus `initialized` and `shutdown`. Documents are stored in `DashMap<Url, ropey::Rope>`; each `did_open` / `did_change` runs the full diagnostic pipeline and calls `client.publish_diagnostics`. Capabilities declared: `TextDocumentSyncKind::INCREMENTAL`, `HoverProviderCapability::Simple(true)`, `CompletionOptions` with trigger characters `" "` and `"\n"`.

**Diagnostic mapping (`lsp/diagnostics.rs`)** — `diagnose(source, rope)` runs `story_parser::parse` and maps each `story_parser::Diagnostic` to `lsp_types::Diagnostic` with correct line/col ranges computed via `ropey::Rope::byte_to_char` (T-03-13-02: UTF-8 safe). Unknown-verb diagnostics are re-classified from parser-ERROR to LSP-WARNING per D-17; a `code: "unknown-verb"` string is attached for client-side filtering. `"Did you mean"` casing is canonicalized on the way out. `VERB_CATALOG` is a 13-entry array of `(verb, markdown_doc)` tuples covering every verb in `story_parser::suggest::KNOWN_VERBS` (verified by a unit test).

**Document model (`lsp/document.rs`)** — Rope-backed edits via `apply_changes` (handles both incremental `TextDocumentContentChangeEvent { range: Some(…) }` and full-replace `range: None` per LSP spec). `position_to_char`, `byte_offset_to_position`, `byte_range_to_lsp_range` go through `ropey`'s char-index API exclusively; `identifier_at` walks left/right from a cursor using `[A-Za-z0-9_-]` so multi-word verbs like `wait-for` are returned as one token.

**`InProcessServer` test facade (`lsp/server::testing`)** — reuses the exact same `diagnose`, `apply_changes`, `identifier_at`, `verb_doc`, `verb_list` helpers as the real impl but records `publish_diagnostics` calls into an in-memory `Vec<DiagnosticsPublish>` instead of crossing an RPC boundary. This lets the six integration tests assert on published diagnostic content directly.

## Verification

```bash
cargo test -p intelligence --test lsp_server_tests     # 6/6 green
cargo test -p intelligence                              # 76/76 green across lib + integration
cargo build -p intelligence                             # exit 0
```

**Acceptance criteria (all passed):**

- `grep -c "publish_diagnostics" crates/intelligence/src/lsp/server.rs` = 4 (≥ 1 required)
- `grep -cE "CompletionResponse|CompletionItem" crates/intelligence/src/lsp/server.rs` = 11 (≥ 1)
- `grep -c "story_parser" crates/intelligence/src/lsp/diagnostics.rs` = 6 (≥ 1)
- `grep -cE "Did you mean|did_you_mean" crates/intelligence/src/lsp/diagnostics.rs` = 10 (≥ 1)

**Test coverage (6 integration tests):**

| # | Name | Assertion |
|---|------|-----------|
| 1 | `did_open_stores_doc_and_hover_returns_verb_doc` | `did_open` → DashMap insert; hover on `click` returns markdown catalog doc |
| 2 | `did_change_applies_incremental_edits_and_publishes_diagnostics` | Incremental range edit replaces `click` → `clik` in rope; diagnostics re-published |
| 3 | `did_close_removes_doc_and_stale_hover_returns_none` | Doc removed from map; hover returns None; empty diagnostics published |
| 4 | `grammar_error_produces_error_diagnostic` | `@@@ not a story file` → ERROR severity diagnostic with well-formed range, source = `"story-parser"` |
| 5 | `unknown_verb_produces_did_you_mean_warning` | `clik "x"` → WARNING with `"Did you mean"` message referencing a known verb |
| 6 | `completion_filters_by_prefix` | Cursor after `cl` → completion includes `click` (KEYWORD kind), excludes `navigate` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan references `story_parser::parse_story`; the actual public function is `story_parser::parse`**
- **Found during:** Task 1 (first compile of `diagnostics.rs`)
- **Issue:** Plan's `<interfaces>` and `read_first` reference `parse_story`. The story-parser crate exposes `parse` (and `parse_file` for io). No `parse_story` alias exists.
- **Fix:** Imported `story_parser::parse as parse_story` locally in `diagnostics.rs` so the plan's naming convention is still visible in the code, and used it throughout.
- **Files modified:** `crates/intelligence/src/lsp/diagnostics.rs`
- **Commit:** `89feb7b`

**2. [Rule 3 - Blocking] Plan references `VERB_CATALOG` from `crates/intelligence/src/nl/verb_whitelist.rs`, which doesn't exist yet**
- **Found during:** Task 1 drafting
- **Issue:** The plan's action bullet references `VERB_CATALOG` from a module that isn't part of this plan's file list and doesn't exist in the repo. A future NL plan (03-14 or later) may introduce it.
- **Fix:** Defined `VERB_CATALOG` locally in `lsp/diagnostics.rs` as a `&[(&str, &str)]` table of 13 verb → markdown-doc pairs. Covers every verb in `story_parser::suggest::KNOWN_VERBS` (asserted by a unit test). A future consolidation can move this up without changing the LSP call sites.
- **Files modified:** `crates/intelligence/src/lsp/diagnostics.rs`
- **Commit:** `89feb7b`

**3. [Rule 1 - Bug] Parser emits unknown-verb diagnostics as ERROR, not WARNING**
- **Found during:** Task 1 verify (first test run)
- **Issue:** `story_parser::parse` classifies `"unknown command 'teleport'"` as `Severity::Error`. The plan's Test 5 requires these to surface as `DiagnosticSeverity::WARNING` per D-17.
- **Fix:** Added `is_unknown_verb_diag()` helper that classifies by message substring (`"unknown command"` / `"unknown verb"` / `"did you mean"`). LSP layer remaps those to WARNING regardless of parser severity, and attaches `code: "unknown-verb"` for client filtering. Grammar-level errors (bad tokens at SOI, unterminated blocks that the parser cannot recover) remain ERROR.
- **Files modified:** `crates/intelligence/src/lsp/diagnostics.rs`
- **Commit:** `89feb7b`

**4. [Rule 2 - Missing Critical] Plan's example DSL uses `... end end` but the actual grammar uses `{ ... }` braces**
- **Found during:** Task 1 verify (grammar parse errors on plan-style fixtures)
- **Issue:** The plan's Test fixtures use `story "t"\nscene "s"\n  click "x"\nend\nend` but `grammar.pest` expects `story "t" { scene "s" { click "x" } }`. Using the plan's literal syntax produces a full-grammar failure rather than exercising the intended behavior.
- **Fix:** Rewrote all six test fixtures to use the brace syntax. Test-1 hover position, Test-2 edit range, Test-6 prefix position all adjusted to match the new line/column offsets.
- **Files modified:** `crates/intelligence/tests/lsp_server_tests.rs`
- **Commit:** `89feb7b`

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 bug). No architectural decisions escalated — all changes were necessary to match the real parser surface and produce a compiling, testable LSP layer.

## Known Stubs

None. `StoryLanguageServer` is a complete `LanguageServer` impl (per plan scope). The plan explicitly scopes the IPC bridge to Plan 14 — absence of a transport wire-up is intentional and covered by the `InProcessServer` facade for testing.

## Authentication Gates

None. Pure-Rust LSP layer; no network or credential dependencies.

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-03-13-01 (DoS — pathological input) | mitigated | `story_parser::parse` (pest) is O(n); `MAX_STORY_FILE_BYTES` guard already enforced at the `story_parser::io` layer. Panic-mode recovery from DSL-06 caps fan-out. |
| T-03-13-02 (Tampering — multi-byte UTF-8 offsets) | mitigated | All position/range conversions go through `ropey::Rope::byte_to_char` / `char_to_byte` in `lsp/document.rs`; unit test `byte_offset_round_trip_multibyte` exercises `héllo\nwörld`. |
| T-03-13-03 (Info Disclosure — diagnostic echoes source) | accepted | Source is user-authored and user-visible; diagnostics only quote spans from the same user's buffer. No new disclosure surface. |

## Handoff Notes for Next Plan (03-14)

- `StoryLanguageServer::new(client)` is the public constructor. Wire via `tower_lsp::LspService::build(|client| StoryLanguageServer::new(client))` → produces a `(Service, MessageStream)` pair the IPC bridge can drive.
- `diagnose(source, rope)`, `verb_doc(ident)`, and `verb_list()` are `pub` free functions — safe to call from the IPC bridge if it needs to synthesize diagnostics for non-LSP callers.
- `InProcessServer` is `#[doc(hidden)]` but `pub` — reserved for tests, not for production IPC wiring.
- `VERB_CATALOG` in `lsp/diagnostics.rs` is the current source of truth for hover/completion text. If/when `crates/intelligence/src/nl/verb_whitelist.rs` lands, migrate the constant and update the three callers (`verb_doc`, `verb_list`, `VERB_CATALOG::verb_catalog_covers_known_verbs` test).
- Severity remapping (`is_unknown_verb_diag`) is message-substring based because parser `Diagnostic` has no discriminant for "semantic vs grammar". If a future Phase-1 plan adds structured codes to `story_parser::Diagnostic`, switch the detection to code-based.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/lsp/mod.rs` → FOUND
- `crates/intelligence/src/lsp/server.rs` → FOUND
- `crates/intelligence/src/lsp/diagnostics.rs` → FOUND
- `crates/intelligence/src/lsp/document.rs` → FOUND
- `crates/intelligence/tests/lsp_server_tests.rs` → FOUND

Commits:
- `89feb7b` (feat 03-13) → FOUND in `git log`

Verification:
- `cargo build -p intelligence` → exit 0
- `cargo test -p intelligence --test lsp_server_tests` → 6/6 passed
- `cargo test -p intelligence` → 76/76 passed (no regression)

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-15*
