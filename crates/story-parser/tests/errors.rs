//! Error-path tests for the Story DSL parser (Task 2):
//! - Levenshtein "did you mean" suggestions for unknown verbs / meta keys
//! - panic-mode recovery: multiple diagnostics from a single parse pass
//! - Diagnostics carry valid spans
//! - AST is still produced even when diagnostics exist (best-effort)

use std::path::PathBuf;
use story_parser::{parse, parse_file, Severity};

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

#[test]
fn typo_suggestion() {
    let r = parse_file(&fixture("invalid/typo.story")).expect("io ok");
    let typo_diags: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.message.contains("clik"))
        .collect();
    assert_eq!(typo_diags.len(), 1, "expected 1 'clik' diagnostic, got {:?}", r.diagnostics);
    let d = typo_diags[0];
    assert_eq!(d.severity, Severity::Error);
    assert_eq!(d.suggestion.as_deref(), Some("click"));
    assert!(
        d.message.contains("did you mean"),
        "expected 'did you mean' in message, got '{}'",
        d.message
    );
}

#[test]
fn multi_error_recovery() {
    let r = parse_file(&fixture("invalid/multi-error.story")).expect("io ok");
    let errs: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(
        errs.len() >= 6,
        "expected >= 6 error diagnostics from single parse pass (panic-mode recovery proven), got {}: {:?}",
        errs.len(),
        r.diagnostics
    );
    // Verify did-you-mean is firing for each typo
    let suggestions: Vec<&str> =
        errs.iter().filter_map(|d| d.suggestion.as_deref()).collect();
    for expected in &["click", "navigate", "assert", "scroll", "hover"] {
        assert!(
            suggestions.contains(expected),
            "expected suggestion '{}' in {:?}",
            expected,
            suggestions
        );
    }
}

#[test]
fn diagnostics_have_spans() {
    let r = parse_file(&fixture("invalid/multi-error.story")).expect("io ok");
    let source_len = std::fs::metadata(fixture("invalid/multi-error.story"))
        .unwrap()
        .len() as usize;
    for d in &r.diagnostics {
        assert!(
            d.span.start <= d.span.end,
            "span.start > span.end in {:?}",
            d
        );
        assert!(d.span.end <= source_len, "span.end out of source: {:?}", d);
        assert!(d.span.line >= 1, "span.line must be 1-indexed");
    }
}

#[test]
fn ast_present_with_errors() {
    let r = parse_file(&fixture("invalid/multi-error.story")).expect("io ok");
    assert!(
        r.ast.is_some(),
        "AST must be Some even with diagnostics (best-effort recovery)"
    );
    assert!(
        !r.diagnostics.is_empty(),
        "diagnostics should be populated for multi-error fixture"
    );
}

#[test]
fn unknown_meta_key() {
    let src = r#"story {
  meta { foo: "bar" }
  scene "s" { pause }
}
"#;
    let r = parse(src);
    let foo_diag = r
        .diagnostics
        .iter()
        .find(|d| d.message.contains("foo"))
        .expect("expected diagnostic for unknown meta key 'foo'");
    assert_eq!(foo_diag.severity, Severity::Error);
}

#[test]
fn unknown_meta_key_suggestion() {
    let src = r#"story {
  meta { spped: 1.0 }
  scene "s" { pause }
}
"#;
    let r = parse(src);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.message.contains("spped"))
        .expect("diagnostic for spped");
    assert_eq!(d.suggestion.as_deref(), Some("speed"));
}

#[test]
fn speed_out_of_range_warning() {
    let src = r#"story {
  meta { speed: 99.0 }
  scene "s" { pause }
}
"#;
    let r = parse(src);
    let warn = r
        .diagnostics
        .iter()
        .find(|d| d.severity == Severity::Warning && d.message.contains("speed"))
        .expect("expected speed range warning");
    assert!(warn.message.contains("99"), "got message: {}", warn.message);
}

#[test]
fn viewport_pair_parses() {
    let src = r#"story {
  meta { viewport: 1920x1080 }
  scene "s" { pause }
}
"#;
    let r = parse(src);
    let ast = r.ast.unwrap();
    let v = ast.meta.viewport.expect("viewport set");
    assert_eq!(v.width, 1920);
    assert_eq!(v.height, 1080);
}

#[test]
fn missing_brace_recovers() {
    // Missing closing `}` for the scene; pest will reject but recover.rs
    // should still emit a diagnostic + a best-effort token stream.
    let src = "story {\n  scene \"s\" {\n    click \"Save\"\n";
    let r = parse(src);
    assert!(r.ast.is_some(), "ast still produced for missing brace");
    assert!(
        r.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error),
        "expected at least one error diagnostic"
    );
}
