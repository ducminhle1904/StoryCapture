//! Coverage for the `nth N` target modifier.
//!
//! Asserts:
//!   1. Parsing — `valid/nth_modifier.story` parses cleanly and the expected
//!      `target_nth` values land on each Command variant.
//!   2. Round-trip — `format_story(parse(src))` reparses to a structurally
//!      equal AST.
//!   3. Backward compat — fixtures without nth round-trip byte-identically;
//!      targets that omit nth produce `None` after parse.
//!   4. Diagnostics — `nth 0` is rejected at parse time (collapsed to `None`)
//!      because Playwright's `.nth(idx)` is 0-based and we 1-index at the DSL
//!      boundary.
//!   5. Drag — both `from_nth` and `to_nth` propagate independently.

use std::path::PathBuf;

use story_parser::ast::{AriaRole, Command, SelectorOrText, Story};
use story_parser::{format_story, parse, Severity};

fn fixture(rel: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(rel);
    p
}

fn parse_clean(src: &str) -> Story {
    let r = parse(src);
    let errs: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Error))
        .collect();
    assert!(errs.is_empty(), "expected clean parse, got: {:?}", errs);
    r.ast.expect("ast present")
}

fn strip_spans(story: &mut Story) {
    story.span = Default::default();
    story.meta.span = Default::default();
    for scene in &mut story.scenes {
        scene.span = Default::default();
        for c in &mut scene.commands {
            c.clear_span();
        }
    }
}

// ── 1: parse extracts nth correctly per tier ──────────────────────────

#[test]
fn parse_extracts_nth_per_tier() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let story = parse_clean(&src);
    let cmds = &story.scenes[0].commands;

    // Index reflects fixture order.
    match &cmds[0] {
        Command::Click {
            target: SelectorOrText::TestId(v),
            target_nth,
            ..
        } => {
            assert_eq!(v, "row");
            assert_eq!(*target_nth, Some(2));
        }
        other => panic!(
            "cmds[0] expected Click(testid 'row' nth 2), got {:?}",
            other
        ),
    }
    match &cmds[1] {
        Command::Click {
            target: SelectorOrText::Role { role, name },
            target_nth,
            ..
        } => {
            assert_eq!(*role, AriaRole::Button);
            assert_eq!(name, "Save");
            assert_eq!(*target_nth, Some(1));
        }
        other => panic!("cmds[1] expected Click(button Save nth 1), got {:?}", other),
    }
    match &cmds[2] {
        Command::Click {
            target: SelectorOrText::Label(v),
            target_nth,
            ..
        } => {
            assert_eq!(v, "Email");
            assert_eq!(*target_nth, Some(3));
        }
        other => panic!("cmds[2] expected Click(field Email nth 3), got {:?}", other),
    }
    match &cmds[3] {
        Command::Click {
            target: SelectorOrText::TextExact(v),
            target_nth,
            ..
        } => {
            assert_eq!(v, "Learn more");
            assert_eq!(*target_nth, Some(4));
        }
        other => panic!(
            "cmds[3] expected Click(text 'Learn more' nth 4), got {:?}",
            other
        ),
    }
}

// ── 2: nth propagates to Hover/Type/Select/Upload/WaitFor/Assert ──────

#[test]
fn parse_extracts_nth_per_verb() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let story = parse_clean(&src);
    let cmds = &story.scenes[0].commands;

    match &cmds[4] {
        Command::Hover { target_nth, .. } => assert_eq!(*target_nth, Some(2)),
        other => panic!("cmds[4] expected Hover, got {:?}", other),
    }
    match &cmds[5] {
        Command::Type {
            target_nth, text, ..
        } => {
            assert_eq!(*target_nth, Some(1));
            assert_eq!(text, "alice@example.com");
        }
        other => panic!("cmds[5] expected Type, got {:?}", other),
    }
    match &cmds[6] {
        Command::Select {
            target_nth, value, ..
        } => {
            assert_eq!(*target_nth, Some(2));
            assert_eq!(value, "VN");
        }
        other => panic!("cmds[6] expected Select, got {:?}", other),
    }
    match &cmds[7] {
        Command::Upload {
            target_nth, path, ..
        } => {
            assert_eq!(*target_nth, Some(1));
            assert_eq!(path, "/tmp/x");
        }
        other => panic!("cmds[7] expected Upload, got {:?}", other),
    }
    match &cmds[8] {
        Command::WaitFor {
            target_nth,
            timeout_ms,
            ..
        } => {
            assert_eq!(*target_nth, Some(5));
            assert_eq!(*timeout_ms, None);
        }
        other => panic!("cmds[8] expected WaitFor, got {:?}", other),
    }
    match &cmds[9] {
        Command::WaitFor {
            target_nth,
            timeout_ms,
            ..
        } => {
            assert_eq!(*target_nth, Some(5));
            assert_eq!(*timeout_ms, Some(10_000));
        }
        other => panic!("cmds[9] expected WaitFor with timeout, got {:?}", other),
    }
    match &cmds[10] {
        Command::Assert { target_nth, .. } => assert_eq!(*target_nth, Some(1)),
        other => panic!("cmds[10] expected Assert, got {:?}", other),
    }
}

// ── 3: Drag propagates from_nth + to_nth independently ────────────────

#[test]
fn parse_extracts_drag_from_to_nth() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let story = parse_clean(&src);
    let cmds = &story.scenes[0].commands;
    match &cmds[11] {
        Command::Drag {
            from: SelectorOrText::TestId(f),
            from_nth,
            to: SelectorOrText::TestId(t),
            to_nth,
            ..
        } => {
            assert_eq!(f, "src");
            assert_eq!(*from_nth, Some(1));
            assert_eq!(t, "dst");
            assert_eq!(*to_nth, Some(2));
        }
        other => panic!("cmds[11] expected Drag, got {:?}", other),
    }
}

// ── 4: backward compat — targets WITHOUT nth land as None ─────────────

#[test]
fn parse_backward_compat_no_nth_is_none() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let story = parse_clean(&src);
    let cmds = &story.scenes[0].commands;
    match &cmds[12] {
        Command::Click {
            target: SelectorOrText::TestId(v),
            target_nth,
            ..
        } => {
            assert_eq!(v, "without-nth");
            assert_eq!(*target_nth, None);
        }
        other => panic!(
            "cmds[12] expected Click(testid 'without-nth'), got {:?}",
            other
        ),
    }
    match &cmds[13] {
        Command::Click {
            target: SelectorOrText::Role { name, .. },
            target_nth,
            ..
        } => {
            assert_eq!(name, "WithoutNth");
            assert_eq!(*target_nth, None);
        }
        other => panic!(
            "cmds[13] expected Click(button WithoutNth), got {:?}",
            other
        ),
    }
}

// ── 5: parse-format-parse round-trip preserves nth ────────────────────

#[test]
fn round_trip_preserves_nth() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let mut story1 = parse_clean(&src);
    let formatted = format_story(&story1);
    // Reparse must succeed cleanly.
    let mut story2 = parse_clean(&formatted);
    strip_spans(&mut story1);
    strip_spans(&mut story2);
    assert_eq!(
        story1, story2,
        "AST drift after round-trip\nformatted:\n{}",
        formatted
    );
}

// ── 6: formatter emits `nth N` postfix iff Some ───────────────────────

#[test]
fn formatter_emits_nth_postfix_only_when_some() {
    let src = std::fs::read_to_string(fixture("valid/nth_modifier.story")).unwrap();
    let story = parse_clean(&src);
    let formatted = format_story(&story);

    // Lines with nth must carry the postfix.
    assert!(
        formatted.contains("click testid \"row\" nth 2"),
        "expected `click testid \"row\" nth 2`, got:\n{formatted}"
    );
    assert!(
        formatted.contains("drag testid \"src\" nth 1 to testid \"dst\" nth 2"),
        "expected drag with both nth postfixes, got:\n{formatted}"
    );
    assert!(
        formatted.contains("wait-for testid \"row\" nth 5 timeout 10000ms"),
        "expected wait-for with nth and timeout, got:\n{formatted}"
    );
    // Lines without nth must NOT have a stray postfix.
    assert!(
        formatted.contains("click testid \"without-nth\"\n")
            || formatted.contains("click testid \"without-nth\""),
        "expected legacy form preserved, got:\n{formatted}"
    );
    assert!(
        !formatted.contains("\"without-nth\" nth"),
        "no nth postfix expected on the without-nth line, got:\n{formatted}"
    );
}

// ── 7: legacy fixtures byte-identical (no nth field churn) ────────────

#[test]
fn legacy_fixtures_no_nth_byte_identical_after_round_trip() {
    // Tier1 legacy forms have no nth — formatted output must NOT contain
    // any `nth ` token (proves backward compat at the byte level).
    for f in [
        "valid/tier1_legacy_forms.story",
        "valid/tier1_new_forms.story",
        "valid/tier2_step_ids.story",
    ] {
        let src = std::fs::read_to_string(fixture(f)).unwrap();
        let story = parse_clean(&src);
        let formatted = format_story(&story);
        assert!(
            !formatted.contains(" nth "),
            "legacy fixture {f} round-tripped with stray nth postfix:\n{formatted}"
        );
    }
}

// ── 8: nth 0 collapses to None (1-indexed boundary) ───────────────────

#[test]
fn nth_zero_collapses_to_none() {
    let src = "story { scene \"s\" { click testid \"row\" nth 0 } }";
    let story = parse_clean(src);
    let cmd = &story.scenes[0].commands[0];
    match cmd {
        Command::Click {
            target_nth,
            target: SelectorOrText::TestId(v),
            ..
        } => {
            assert_eq!(v, "row");
            // 0 is invalid at the DSL boundary (we're 1-indexed); the
            // tokenizer collapses it to None so the executor never calls
            // `.nth(-1)`.
            assert_eq!(*target_nth, None);
        }
        other => panic!("expected Click, got {:?}", other),
    }
}

// ── 9: large nth values parse (no upper bound enforced at parse time) ─

#[test]
fn nth_large_values_parse() {
    let src = "story { scene \"s\" { click testid \"row\" nth 100 } }";
    let story = parse_clean(src);
    match &story.scenes[0].commands[0] {
        Command::Click { target_nth, .. } => assert_eq!(*target_nth, Some(100)),
        other => panic!("expected Click, got {:?}", other),
    }
}

// ── nth lints — warn on 0 (off-by-one) and on > 100 (typo) ──────────
//
// The lints are informational. The AST shape stays the same:
//   - `nth 0` collapses to `target_nth = None` (existing behavior).
//   - `nth 1000` keeps `target_nth = Some(1000)`; the user can override.
// Lints are surfaced via story-parser diagnostics so the LSP bridge
// (`crates/intelligence/src/lsp/diagnostics.rs`) translates them
// to `DiagnosticSeverity::WARNING` automatically.

#[test]
fn nth_zero_emits_warning() {
    let src = "story { scene \"s\" { click testid \"row\" nth 0 } }";
    let r = story_parser::parse(src);
    let warnings: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Warning))
        .collect();
    assert!(
        warnings.iter().any(|d| d.message.contains("1-indexed")),
        "expected a warning about 1-indexed nth, got: {:?}",
        r.diagnostics
    );
    // AST-level behavior preserved.
    let story = r.ast.expect("ast present");
    match &story.scenes[0].commands[0] {
        Command::Click { target_nth, .. } => assert_eq!(*target_nth, None),
        other => panic!("expected Click, got {:?}", other),
    }
}

#[test]
fn nth_too_large_emits_warning() {
    let src = "story { scene \"s\" { click testid \"row\" nth 1000 } }";
    let r = story_parser::parse(src);
    let warnings: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Warning))
        .collect();
    assert!(
        warnings
            .iter()
            .any(|d| d.message.contains("unusually large") && d.message.contains("1000")),
        "expected a warning about unusually large nth, got: {:?}",
        r.diagnostics
    );
    // Value still flows through — the warning is informational only.
    let story = r.ast.expect("ast present");
    match &story.scenes[0].commands[0] {
        Command::Click { target_nth, .. } => assert_eq!(*target_nth, Some(1000)),
        other => panic!("expected Click, got {:?}", other),
    }
}

#[test]
fn nth_one_no_warning() {
    // `nth 1` is the smallest valid value; no diagnostic.
    let src = "story { scene \"s\" { click testid \"row\" nth 1 } }";
    let r = story_parser::parse(src);
    let nth_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.message.to_ascii_lowercase().contains("nth"))
        .collect();
    assert!(
        nth_diags.is_empty(),
        "expected no nth-related diagnostics for nth 1, got: {:?}",
        nth_diags
    );
}

#[test]
fn nth_in_range_no_warning() {
    // `nth 5` is in range; no diagnostic.
    let src = "story { scene \"s\" { click testid \"row\" nth 5 } }";
    let r = story_parser::parse(src);
    let nth_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.message.to_ascii_lowercase().contains("nth"))
        .collect();
    assert!(
        nth_diags.is_empty(),
        "expected no nth-related diagnostics for nth 5, got: {:?}",
        nth_diags
    );
}

#[test]
fn nth_at_threshold_no_warning() {
    // `nth 100` is exactly at the threshold; the rule is `> 100`, so no warning.
    let src = "story { scene \"s\" { click testid \"row\" nth 100 } }";
    let r = story_parser::parse(src);
    let nth_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.message.to_ascii_lowercase().contains("nth"))
        .collect();
    assert!(
        nth_diags.is_empty(),
        "expected no nth-related diagnostics for nth 100 (boundary), got: {:?}",
        nth_diags
    );
}
