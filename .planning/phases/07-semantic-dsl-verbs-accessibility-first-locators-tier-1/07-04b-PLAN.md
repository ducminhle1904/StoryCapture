---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04b
type: execute
wave: 5
depends_on:
  - 07-03b
files_modified:
  - crates/story-parser/src/grammar.pest
  - crates/story-parser/src/ast.rs
  - crates/story-parser/src/lenient_tokenize.rs
  - crates/story-parser/src/semantic.rs
  - crates/story-parser/src/formatter.rs
  - crates/story-parser/src/lib.rs
  - crates/story-parser/tests/round_trip.rs
  - crates/story-parser/tests/fixtures/valid/tier2_step_ids.story
  - crates/story-parser/Cargo.toml
autonomous: true
requirements:
  - PHASE-7.5
tags: dsl, parser, formatter, step-id
must_haves:
  truths:
    - "The pest grammar accepts an optional trailing `# @id=<uuidv7>` line comment; parser preserves it as `LineMeta.step_id: Option<Uuid>`"
    - "Grammar extension is ADDITIVE — every Tier 1 golden fixture from 07-01 still parses identically (no target/command rule altered)"
    - "Invalid UUIDv7 (wrong format) is parsed as a plain comment (ignored) with a warn-level diagnostic — step_id remains None"
    - "Legacy stories (no step-id comments) parse IDENTICALLY to pre-phase with step_id=None for all commands"
    - "The new `story_parser::formatter` can serialize a parsed Story back to DSL text preserving the step-id comments"
    - "parse(src) → format → parse is a fixpoint (structural AST equality ignoring spans) on three fixtures including tier1_new_forms, tier1_legacy_forms, and tier2_step_ids"
    - "Insta snapshot captures the canonical formatted output for tier2_step_ids"
  artifacts:
    - path: "crates/story-parser/src/grammar.pest"
      provides: "Additive trailing `# @id=<uuidv7>` comment rule — does not modify any Tier 1 target/command rule"
      contains: "step_id_comment"
    - path: "crates/story-parser/src/ast.rs"
      provides: "LineMeta.step_id: Option<Uuid> field"
      contains: "step_id"
    - path: "crates/story-parser/src/formatter.rs"
      provides: "Story → DSL text serializer preserving step-id comments + indentation"
      contains: "format_story"
    - path: "crates/story-parser/tests/round_trip.rs"
      provides: "3 round-trip fixpoint tests + 1 insta snapshot"
      contains: "round_trip"
  key_links:
    - from: "grammar.pest step_id_comment rule"
      to: "lenient_tokenize extracts uuidv7_text"
      via: "Rule::step_id_comment walker"
      pattern: "step_id_comment"
    - from: "semantic.rs builds LineMeta"
      to: "LineMeta.step_id populated via Uuid::parse_str"
      via: "ParsedCommand.step_id_raw → Option<Uuid>"
      pattern: "step_id"
    - from: "format_story emits `# @id=<uuid>`"
      to: "re-parse yields equivalent LineMeta.step_id"
      via: "parse-format-parse fixpoint test"
      pattern: "format_story"
---

<objective>
Ship the parser step-id round-trip + minimal formatter: the grammar accepts an optional trailing `# @id=<uuidv7>` line comment, the AST's `LineMeta` gains a `step_id: Option<Uuid>` field, and a new `story_parser::formatter` module serializes a parsed `Story` back to DSL text preserving step-id comments. Grammar change is ADDITIVE — no Tier 1 rule touched.

Purpose: Phase 07-04c needs step ids to key the targets store and needs the formatter to stamp a new UUIDv7 into the `.story` source on first pick. This plan lands the parse-format-parse fixpoint so 04c can write through safely.

Output: Additive grammar rule `step_id_comment`; `LineMeta.step_id: Option<Uuid>`; warn-on-invalid-UUID diagnostic; `formatter.rs` module with full command-variant coverage; 3 round-trip fixpoint tests (tier1_new_forms, tier1_legacy_forms, tier2_step_ids); insta snapshot for canonical formatted output; comprehensive regression guard on existing Tier 1 golden fixtures (`cargo test -p story-parser --test golden` still green after grammar extension).
</objective>

<scope>
**EXPLICITLY IN SCOPE:**
- Additive grammar extension for trailing `# @id=<uuidv7>` comment.
- `LineMeta.step_id: Option<Uuid>` + semantic wiring + warn-on-invalid-UUID.
- `story_parser::formatter::format_story(story: &Story) -> String`.
- 3 round-trip fixpoint tests + 1 insta snapshot.
- Regression guard: Tier 1 golden fixtures from 07-01 still pass.
- `uuid` + `insta` Cargo.toml deps if absent.

**EXPLICITLY OUT OF SCOPE:**
- Notification plumbing + hover preview (07-04a).
- Targets store + self-healing + stamp-on-pick Tauri command (07-04c).
- Free-form user comment preservation (documented limitation of formatter).
</scope>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-01-SUMMARY.md
@CLAUDE.md

@crates/story-parser/src/grammar.pest
@crates/story-parser/src/ast.rs
@crates/story-parser/src/semantic.rs
@crates/story-parser/src/lenient_tokenize.rs

<interfaces>
```rust
// crates/story-parser/src/ast.rs — LineMeta extension (additive)
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineMeta {
    pub line: usize,
    pub column: usize,
    pub step_id: Option<Uuid>,   // NEW — parsed from trailing `# @id=<uuidv7>`
}

// crates/story-parser/src/formatter.rs (NEW)
pub fn format_story(story: &Story) -> String;
// Preserves: step_id trailing comments, indentation, blank lines between scenes,
// and the original `story "name" { ... }` + `scene "name" { ... }` structure.
// Does NOT preserve free-floating user comments (out of scope).
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Parser extension — additive trailing `# @id=<uuidv7>` comment → LineMeta.step_id + Tier 1 regression guard</name>
  <files>crates/story-parser/src/grammar.pest, crates/story-parser/src/ast.rs, crates/story-parser/src/lenient_tokenize.rs, crates/story-parser/src/semantic.rs, crates/story-parser/src/lib.rs, crates/story-parser/tests/fixtures/valid/tier2_step_ids.story, crates/story-parser/Cargo.toml</files>
  <read_first>
    - crates/story-parser/src/grammar.pest (current command_line / line rules — where to attach the optional trailing comment)
    - crates/story-parser/src/ast.rs (existing LineMeta struct — extend with step_id)
    - crates/story-parser/src/lenient_tokenize.rs (how tokens flow into ParsedCommand)
    - crates/story-parser/src/semantic.rs (how LineMeta is constructed on each command)
    - crates/story-parser/tests/fixtures/valid/*.story (Tier 1 golden fixtures — MUST continue to pass)
    - CLAUDE.md (prefer uuid crate with v4 + v7 features)
  </read_first>
  <behavior>
    - A command line like `click button "Save"  # @id=018f4c1e-7b3a-7000-8000-000000000001` parses the same as without the comment, BUT the resulting command's `LineMeta.step_id == Some(Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000001").unwrap())`.
    - An invalid UUIDv7 (wrong version or malformed) is still parsed as a comment (ignored) — step_id remains None, diagnostic warn-level emitted.
    - Free-form trailing comments without `@id=` are also ignored (no step_id set).
    - **Regression guard:** every pre-existing Tier 1 golden fixture from 07-01 must parse IDENTICALLY after the grammar extension — no target/command rule is altered; this is strictly additive.
    - grammar.pest carries an explicit comment: `// Additive: trailing step-id comment. Does not alter any Tier 1 target/command rule.`
  </behavior>
  <action>
1. **Edit `crates/story-parser/src/grammar.pest`.** Add an optional `step_id_comment` rule and attach it additively:
   ```pest
   // Additive: trailing step-id comment. Does not alter any Tier 1 target/command rule.
   step_id_comment = { "#" ~ WHITESPACE* ~ "@id=" ~ uuidv7_text }
   uuidv7_text = @{ ASCII_HEX_DIGIT+ ~ ("-" ~ ASCII_HEX_DIGIT+)* }
   // Attach to command_line (NON-destructive — optional extension):
   command_line = { command ~ step_id_comment? ~ NEWLINE }
   ```
   The exact rule name depends on the current grammar; adapt to what already exists. The key property: `step_id_comment` must be a NAMED (non-silent) rule so `lenient_tokenize` can see it, AND the trailing `?` means legacy lines parse unchanged.

2. **Edit `crates/story-parser/src/ast.rs`:**
   ```rust
   use uuid::Uuid;

   #[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
   pub struct LineMeta {
       pub line: usize,
       pub column: usize,
       #[serde(default, skip_serializing_if = "Option::is_none")]
       pub step_id: Option<Uuid>,
   }
   ```
   Check if `uuid` is in `Cargo.toml` dependencies; if not, add `uuid = { version = "1", features = ["v4", "v7", "serde"] }`.

3. **Edit `crates/story-parser/src/lenient_tokenize.rs`.** When `parse_command` encounters a `Rule::command_line`, walk its children for an optional `Rule::step_id_comment`; if present, extract the `uuidv7_text` inner string. Pass it up to semantic via a new field on `ParsedCommand` OR attach to the line-meta struct. Add helper `fn parse_step_id(inner: &str) -> Option<Uuid>` using `Uuid::parse_str`.

4. **Edit `crates/story-parser/src/semantic.rs`.** Where `LineMeta` is built for each command, populate `step_id`:
   ```rust
   let step_id = parsed_cmd.step_id_raw.as_deref().and_then(|s| Uuid::parse_str(s).ok());
   let meta = LineMeta { line, column, step_id };
   ```
   If the raw string was present but failed to parse, emit a `Diagnostic::warn` ("invalid step id '{raw}' — expected UUIDv7, ignored"). Don't fail the parse.

5. **Create `crates/story-parser/tests/fixtures/valid/tier2_step_ids.story`:**
   ```story
   # Tier 2 step-id round-trip fixture
   story "Tier 2 step ids" {
     meta {
       app: "https://example.com"
     }
     scene "picked" {
       click button "Save"  # @id=018f4c1e-7b3a-7000-8000-000000000001
       click link "Docs"    # @id=018f4c1e-7b3a-7000-8000-000000000002
       click "No step id yet"
     }
   }
   ```

6. **Add unit tests** in `semantic.rs` (or new `tests/step_ids.rs`):
   ```rust
   #[test]
   fn step_id_comment_is_parsed_into_line_meta() {
       let src = std::fs::read_to_string("tests/fixtures/valid/tier2_step_ids.story").unwrap();
       let r = crate::parse(&src);
       assert!(r.diagnostics.iter().all(|d| !matches!(d.severity, crate::diagnostic::Severity::Error)));
       let cmds = &r.ast.unwrap().scenes[0].commands;
       assert_eq!(cmds[0].meta().step_id.map(|u| u.to_string()).as_deref(), Some("018f4c1e-7b3a-7000-8000-000000000001"));
       assert_eq!(cmds[1].meta().step_id.map(|u| u.to_string()).as_deref(), Some("018f4c1e-7b3a-7000-8000-000000000002"));
       assert!(cmds[2].meta().step_id.is_none());
   }

   #[test]
   fn legacy_fixtures_have_no_step_ids() {
       // Regression: pre-Phase-7.5 fixtures all have step_id == None after parse.
       for p in ["tier1_new_forms.story", "tier1_legacy_forms.story"] {
           let src = std::fs::read_to_string(format!("tests/fixtures/valid/{p}")).unwrap();
           let r = crate::parse(&src);
           let cmds: Vec<_> = r.ast.unwrap().scenes.iter().flat_map(|s| s.commands.iter()).collect();
           assert!(cmds.iter().all(|c| c.meta().step_id.is_none()), "fixture {p} unexpectedly has step_ids");
       }
   }

   #[test]
   fn invalid_uuid_emits_warn_not_error() {
       let src = r#"story "x" { scene "s" { click "a"  # @id=not-a-uuid } }"#;
       let r = crate::parse(&src);
       assert!(r.ast.is_some());
       let warns: Vec<_> = r.diagnostics.iter().filter(|d| matches!(d.severity, crate::diagnostic::Severity::Warning)).collect();
       assert!(warns.iter().any(|d| d.message.contains("invalid step id") || d.message.contains("UUIDv7")));
   }
   ```
   If `Command` does not currently expose `meta()`, add a helper that returns `&LineMeta` for any variant.

7. **Tier 1 regression guard.** Run `cargo test -p story-parser --test golden` (or equivalent name) to confirm every existing Tier 1 golden fixture from 07-01 still passes identically after the grammar extension. This is explicit in the verify block.
  </action>
  <verify>
    <automated>cargo test -p story-parser --lib 2>&1 | tail -10 && cargo test -p story-parser --tests 2>&1 | tail -10 && cargo test -p story-parser --test golden 2>&1 | tail -10 && test -f crates/story-parser/tests/fixtures/valid/tier2_step_ids.story && grep -n "step_id_comment" crates/story-parser/src/grammar.pest && grep -n "Additive: trailing step-id comment" crates/story-parser/src/grammar.pest && grep -n "step_id: Option<Uuid>" crates/story-parser/src/ast.rs && grep -n "@id=" crates/story-parser/tests/fixtures/valid/tier2_step_ids.story && grep -n "uuid" crates/story-parser/Cargo.toml</automated>
  </verify>
  <acceptance_criteria>
    - `cargo build -p story-parser` exits 0
    - `cargo test -p story-parser` exits 0 (all new + legacy tests)
    - **Tier 1 regression guard:** `cargo test -p story-parser --test golden` exits 0 — all Tier 1 golden fixtures from 07-01 still pass identically
    - `grep -n "step_id_comment" crates/story-parser/src/grammar.pest` matches
    - `grep -n "Additive: trailing step-id comment" crates/story-parser/src/grammar.pest` matches (explicit comment documenting additive nature)
    - `grep -n "step_id: Option<Uuid>" crates/story-parser/src/ast.rs` matches
    - `grep -n "uuid" crates/story-parser/Cargo.toml` matches (dep present)
    - Fixture file contains two `@id=` comments in valid UUIDv7 form + one command with no comment
    - `step_id_comment_is_parsed_into_line_meta` asserts both step ids + the bare command has None
    - `legacy_fixtures_have_no_step_ids` passes (regression on 07-01 fixtures)
    - `invalid_uuid_emits_warn_not_error` passes (warn diagnostic, not error)
  </acceptance_criteria>
  <done>Grammar parses optional trailing `# @id=<uuidv7>` comments via an additive rule; `LineMeta.step_id` populated; invalid UUID → warn-level diagnostic; legacy stories parse identically with step_id=None; Tier 1 golden fixtures from 07-01 still pass — regression guard asserted in verify block.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Minimal story-parser formatter + parse-format-parse fixpoint insta snapshot</name>
  <files>crates/story-parser/src/formatter.rs, crates/story-parser/src/lib.rs, crates/story-parser/tests/round_trip.rs, crates/story-parser/Cargo.toml</files>
  <read_first>
    - crates/story-parser/src/ast.rs (Story, Scene, Command variants — the formatter has to cover all of them)
    - crates/story-parser/src/grammar.pest (confirm keyword spellings for formatting output)
    - crates/story-parser/tests/fixtures/valid/*.story (input fixtures for round-trip)
    - insta crate usage in existing tests (if present) — if not, add `insta = "1"` to dev-dependencies
  </read_first>
  <behavior>
    - `format_story(&Story) -> String` produces DSL text that parses back to an AST `==` (structurally equal, ignoring LineMeta.line/column) to the input.
    - Step-id comments round-trip: a command with `meta.step_id == Some(uuid)` formats as `<command>  # @id=<uuid>\n`.
    - Indentation: scenes indented 2 spaces, commands indented 4 spaces inside scene, meta indented 4 spaces inside `meta { ... }` block.
    - Blank lines between scenes are NOT preserved (out of scope).
    - Free-form user comments (without `@id=`) are NOT preserved (explicit limitation — documented in the module doc comment).
    - `parse(src) → format → parse` produces the same AST (ignoring spans) — proven by insta snapshot + structural equality.
  </behavior>
  <action>
1. **Create `crates/story-parser/src/formatter.rs`.** The module exports `pub fn format_story(story: &Story) -> String`. Cover every `Command` variant (click, type, navigate, wait, wait-for, scroll, hover, drag, select, upload, assert, screenshot, pause, fill — check the actual enum). For each, write a small emitter:
   ```rust
   //! Minimal DSL formatter. Preserves step_id comments, indentation, and scene
   //! structure. DOES NOT preserve free-form user comments (out of scope).
   use crate::ast::*;
   use std::fmt::Write;

   pub fn format_story(story: &Story) -> String {
       let mut out = String::new();
       let _ = writeln!(out, "story {:?} {{", story.name);
       if !story.meta.is_empty() { format_meta(&mut out, &story.meta); }
       for scene in &story.scenes {
           let _ = writeln!(out, "  scene {:?} {{", scene.name);
           for cmd in &scene.commands {
               format_command(&mut out, cmd);
           }
           let _ = writeln!(out, "  }}");
       }
       let _ = writeln!(out, "}}");
       out
   }

   fn format_command(out: &mut String, cmd: &Command) {
       let line = match cmd {
           Command::Click { target, .. } => format!("click {}", format_target(target)),
           Command::Type { target, text, .. } => format!("type {} {:?}", format_target(target), text),
           // ... every variant ...
       };
       let _ = write!(out, "    {line}");
       if let Some(id) = cmd.meta().step_id {
           let _ = write!(out, "  # @id={id}");
       }
       let _ = writeln!(out);
   }

   fn format_target(t: &SelectorOrText) -> String {
       match t {
           SelectorOrText::Text(s) => format!("{s:?}"),
           SelectorOrText::Selector(s) => format!("selector {s:?}"),
           SelectorOrText::TestId(s) => format!("testid {s:?}"),
           SelectorOrText::Aria(s) => format!("aria {s:?}"),
           SelectorOrText::Role { role, name } => format!("{} {name:?}", role.as_kebab()),
           SelectorOrText::Label(s) => format!("field {s:?}"),
           SelectorOrText::TextExact(s) => format!("text {s:?}"),
       }
   }
   ```
   Note: Rust's `{s:?}` escaping happens to match the DSL's double-quoted escape rules (backslash-quote). Verify against a string containing `"` — if there's a mismatch, replace with a tiny custom `dsl_quote(&str) -> String` helper.

2. **Expose** via `lib.rs`: `pub mod formatter;` + `pub use formatter::format_story;`.

3. **Create `crates/story-parser/tests/round_trip.rs`:**
   ```rust
   use story_parser::{parse, format_story};

   fn strip_spans(story: &mut story_parser::ast::Story) {
       for scene in &mut story.scenes {
           for cmd in &mut scene.commands {
               let m = cmd.meta_mut();
               m.line = 0; m.column = 0;
           }
       }
   }

   fn assert_round_trip(path: &str) {
       let src = std::fs::read_to_string(path).unwrap();
       let r1 = parse(&src);
       assert!(r1.diagnostics.iter().all(|d| !matches!(d.severity, story_parser::diagnostic::Severity::Error)),
           "initial parse errors: {:?}", r1.diagnostics);
       let story1 = r1.ast.clone().unwrap();

       let formatted = format_story(&story1);
       let r2 = parse(&formatted);
       assert!(r2.diagnostics.iter().all(|d| !matches!(d.severity, story_parser::diagnostic::Severity::Error)),
           "reparse errors for {path}:\n{formatted}\nDiags: {:?}", r2.diagnostics);
       let mut story2 = r2.ast.unwrap();
       let mut story1_s = story1.clone();
       strip_spans(&mut story1_s);
       strip_spans(&mut story2);
       assert_eq!(story1_s, story2, "round-trip AST mismatch for {path}:\nformatted:\n{formatted}");
   }

   #[test]
   fn round_trip_tier2_step_ids() {
       assert_round_trip("tests/fixtures/valid/tier2_step_ids.story");
   }

   #[test]
   fn round_trip_tier1_new_forms() {
       assert_round_trip("tests/fixtures/valid/tier1_new_forms.story");
   }

   #[test]
   fn round_trip_tier1_legacy_forms() {
       assert_round_trip("tests/fixtures/valid/tier1_legacy_forms.story");
   }

   #[test]
   fn format_output_snapshot_tier2_step_ids() {
       let src = std::fs::read_to_string("tests/fixtures/valid/tier2_step_ids.story").unwrap();
       let story = parse(&src).ast.unwrap();
       let formatted = format_story(&story);
       insta::assert_snapshot!("tier2_step_ids_formatted", formatted);
   }
   ```
   Ensure `Command` has a `meta_mut()` helper — if not, add one.

4. **Cargo.toml dev-dependencies:** add `insta = "1.40"` if absent.

5. **First-run acceptance.** Run `cargo test -p story-parser --test round_trip` once to generate the snapshot under `crates/story-parser/tests/snapshots/round_trip__tier2_step_ids_formatted.snap`; inspect visually; commit. Subsequent runs assert equality.
  </action>
  <verify>
    <automated>cargo test -p story-parser --test round_trip 2>&1 | tail -15 && cargo test -p story-parser 2>&1 | tail -5 && test -f crates/story-parser/src/formatter.rs && grep -n "pub fn format_story" crates/story-parser/src/formatter.rs && grep -n "pub use formatter::format_story" crates/story-parser/src/lib.rs && ls crates/story-parser/tests/snapshots/ 2>/dev/null && grep -n "insta" crates/story-parser/Cargo.toml</automated>
  </verify>
  <acceptance_criteria>
    - `cargo test -p story-parser --test round_trip` exits 0 with 4 tests green (3 round-trip fixpoints + 1 insta snapshot)
    - `crates/story-parser/tests/snapshots/` contains the committed `.snap` for `tier2_step_ids_formatted`
    - Round-trip covers: tier2_step_ids (step-id comments), tier1_new_forms (role/field/text-keyword forms), tier1_legacy_forms (selector/testid/aria/bare)
    - Module doc comment on `formatter.rs` explicitly states "free-form user comments are not preserved" limitation
    - No use of `todo!()` or `unimplemented!()` in the formatter for any command variant
  </acceptance_criteria>
  <done>Minimal formatter ships with full command-variant coverage; parse-format-parse is a structural fixpoint on three fixtures including step-id comments; insta snapshot captures the canonical output; known limitation (free-form comments not preserved) documented.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| `.story` source ↔ formatter | Formatter must NEVER emit invalid DSL; round-trip fixpoint guards this. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-04b-01 | Injection | Formatter emits DSL strings (command args + step-id UUIDs) | mitigate | UUIDs pass `Uuid::parse_str` before entering AST; formatter uses Rust's `{s:?}` escape for strings (matches DSL quote rules) OR a dedicated `dsl_quote` helper if round-trip snapshot fails. The insta snapshot in Task 2 guards correctness. |
| T-07-04b-02 | Tampering | Grammar extension could accidentally alter Tier 1 rule behavior | mitigate | Rule is additive (`?` suffix on `command_line`); explicit `// Additive: ...` comment in grammar.pest; regression guard: `cargo test -p story-parser --test golden` asserted in verify block. |
</threat_model>

<verification>
1. `cargo test -p story-parser` exits 0 (all tests incl. round_trip suite)
2. `cargo test -p story-parser --test golden` exits 0 (Tier 1 regression guard — 07-01 fixtures still pass)
3. `grep -n "step_id: Option<Uuid>" crates/story-parser/src/ast.rs` matches
4. `grep -n "pub fn format_story" crates/story-parser/src/formatter.rs` matches
5. `grep -n "Additive: trailing step-id comment" crates/story-parser/src/grammar.pest` matches
6. Insta snapshot for `tier2_step_ids_formatted` committed
</verification>

<success_criteria>
- [ ] Pest grammar ADDITIVE extension for `step_id_comment` (Tier 1 regression guard via `cargo test -p story-parser --test golden`)
- [ ] LineMeta.step_id + semantic warn-on-invalid-UUID + tier2_step_ids fixture + 3 parser tests green
- [ ] `story_parser::formatter::format_story` + parse-format-parse fixpoint on 3 fixtures + insta snapshot committed
- [ ] PHASE-7.5 partially met (parser/formatter slice; targets store + self-healing remain in 07-04c)
</success_criteria>

<output>
After completion, create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04b-SUMMARY.md` capturing:
- Grammar diff (the additive `step_id_comment` rule lines)
- Formatter scope + free-form-comment limitation
- Insta snapshot path
- Tier 1 regression guard result: `cargo test -p story-parser --test golden` output tail
</output>
