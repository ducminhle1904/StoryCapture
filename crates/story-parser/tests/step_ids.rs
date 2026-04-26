//! Step-id round-trip integration tests.
//!
//! Covers:
//!   - Trailing `# @id=<uuidv7>` comments parse into `Command::step_id`.
//!   - Legacy fixtures (no step-id comments) retain `step_id == None`.
//!   - Invalid UUIDs emit a warn-level diagnostic (not an error), and
//!     step_id stays `None`.

use std::path::PathBuf;
use story_parser::{parse, Severity};

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

#[test]
fn step_id_comment_is_parsed_into_line_meta() {
    let src = std::fs::read_to_string(fixture("valid/tier2_step_ids.story"))
        .expect("tier2 fixture exists");
    let r = parse(&src);
    assert!(
        r.diagnostics
            .iter()
            .all(|d| !matches!(d.severity, Severity::Error)),
        "unexpected errors parsing tier2_step_ids: {:?}",
        r.diagnostics
    );
    let cmds = &r.ast.unwrap().scenes[0].commands;
    assert_eq!(
        cmds[0].meta().step_id.map(|u| u.to_string()).as_deref(),
        Some("018f4c1e-7b3a-7000-8000-000000000001"),
        "first command must carry its step id"
    );
    assert_eq!(
        cmds[1].meta().step_id.map(|u| u.to_string()).as_deref(),
        Some("018f4c1e-7b3a-7000-8000-000000000002"),
        "second command must carry its step id"
    );
    assert!(
        cmds[2].meta().step_id.is_none(),
        "third (bare) command must have no step id"
    );
}

#[test]
fn legacy_fixtures_have_no_step_ids() {
    // Regression: legacy fixtures all have step_id == None after parse.
    for p in [
        "valid/tier1_new_forms.story",
        "valid/tier1_legacy_forms.story",
        "valid/all-verbs.story",
        "valid/simple.story",
    ] {
        let src = std::fs::read_to_string(fixture(p)).expect("fixture exists");
        let r = parse(&src);
        let cmds: Vec<_> = r
            .ast
            .unwrap()
            .scenes
            .into_iter()
            .flat_map(|s| s.commands.into_iter())
            .collect();
        assert!(
            !cmds.is_empty(),
            "fixture {p} should produce at least one command"
        );
        assert!(
            cmds.iter().all(|c| c.meta().step_id.is_none()),
            "fixture {p} unexpectedly has step_ids"
        );
    }
}

#[test]
fn invalid_uuid_emits_warn_not_error() {
    let src = "story \"x\" {\n  scene \"s\" {\n    click \"a\"  # @id=not-a-uuid\n  }\n}\n";
    let r = parse(src);
    assert!(r.ast.is_some(), "parser must still produce an AST");
    let errors: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Error))
        .collect();
    assert!(
        errors.is_empty(),
        "invalid UUID must NOT be an error; got errors: {:?}",
        errors
    );
    let warns: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| matches!(d.severity, Severity::Warning))
        .collect();
    assert!(
        warns
            .iter()
            .any(|d| d.message.contains("invalid step id") || d.message.contains("UUIDv7")),
        "expected warn-level diagnostic about invalid step id, got: {:?}",
        warns
    );
    // And the command itself parsed fine, with step_id = None.
    let cmds = &r.ast.unwrap().scenes[0].commands;
    assert_eq!(cmds.len(), 1);
    assert!(cmds[0].meta().step_id.is_none());
}
