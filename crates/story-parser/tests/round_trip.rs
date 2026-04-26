//! Parse-format-parse structural fixpoint.
//!
//! Guarantees that [`story_parser::format_story`] emits DSL text which
//! reparses to an AST structurally equal to the input (ignoring byte spans).
//!
//! Fixtures covered:
//!   - tier2_step_ids: trailing `# @id=<uuidv7>` comments round-trip
//!   - tier1_new_forms: role/field/text-keyword accessibility-first forms
//!   - tier1_legacy_forms: selector / testid / aria / bare-text forms

use std::path::PathBuf;

use story_parser::ast::Story;
use story_parser::{format_story, parse, Severity};

fn fixture(relative: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(relative);
    p
}

/// Zero every span in the story so AST equality ignores byte offsets.
fn strip_spans(story: &mut Story) {
    story.span = Default::default();
    story.meta.span = Default::default();
    for scene in &mut story.scenes {
        scene.span = Default::default();
        for cmd in &mut scene.commands {
            cmd.clear_span();
        }
    }
}

fn assert_round_trip(fixture_rel: &str) {
    let path = fixture(fixture_rel);
    let src = std::fs::read_to_string(&path).expect("fixture exists");

    let r1 = parse(&src);
    let errs1: Vec<_> = r1
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Error))
        .collect();
    assert!(
        errs1.is_empty(),
        "initial parse of {fixture_rel} produced errors: {:?}",
        errs1
    );
    let story1 = r1.ast.clone().expect("ast present");

    let formatted = format_story(&story1);

    let r2 = parse(&formatted);
    let errs2: Vec<_> = r2
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Error))
        .collect();
    assert!(
        errs2.is_empty(),
        "reparse of formatted output for {fixture_rel} produced errors: {:?}\n\
         formatted:\n{formatted}",
        errs2
    );
    let mut story2 = r2.ast.expect("reparse ast present");

    let mut story1_stripped = story1;
    strip_spans(&mut story1_stripped);
    strip_spans(&mut story2);

    assert_eq!(
        story1_stripped, story2,
        "parse-format-parse AST mismatch for {fixture_rel}\nformatted:\n{formatted}"
    );
}

#[test]
fn round_trip_tier2_step_ids() {
    assert_round_trip("valid/tier2_step_ids.story");
}

#[test]
fn round_trip_tier1_new_forms() {
    assert_round_trip("valid/tier1_new_forms.story");
}

#[test]
fn round_trip_tier1_legacy_forms() {
    assert_round_trip("valid/tier1_legacy_forms.story");
}

#[test]
fn format_output_snapshot_tier2_step_ids() {
    let src = std::fs::read_to_string(fixture("valid/tier2_step_ids.story"))
        .expect("tier2 fixture exists");
    let story = parse(&src).ast.expect("ast present");
    let formatted = format_story(&story);
    insta::assert_snapshot!("tier2_step_ids_formatted", formatted);
}
