//! Golden tests for the Story DSL parser (Task 1).

use std::path::PathBuf;
use story_parser::{parse, parse_file, Command, Severity};

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    p.push(name);
    p
}

#[test]
fn empty_input_is_valid() {
    let r = parse("");
    assert!(
        r.diagnostics.is_empty(),
        "empty input must produce no diagnostics; got {:?}",
        r.diagnostics
    );
    let ast = r.ast.expect("ast must be Some for empty input");
    assert!(ast.scenes.is_empty());
}

#[test]
fn whitespace_only_is_valid() {
    let r = parse("   \n  \n\t\n");
    assert!(r.diagnostics.is_empty());
    assert!(r.ast.unwrap().scenes.is_empty());
}

#[test]
fn parses_simple_fixture() {
    let r = parse_file(&fixture("valid/simple.story")).expect("io ok");
    assert!(
        r.diagnostics.iter().all(|d| d.severity != Severity::Error),
        "simple.story must have no errors, got {:?}",
        r.diagnostics
    );
    let ast = r.ast.expect("ast some");
    assert_eq!(ast.name.as_deref(), Some("Onboarding Flow"));
    assert_eq!(ast.meta.app.as_deref(), Some("https://app.example.com"));
    let viewport = ast.meta.viewport.expect("viewport set");
    assert_eq!(viewport.width, 1280);
    assert_eq!(viewport.height, 800);
    assert_eq!(ast.scenes.len(), 1);
    let scene = &ast.scenes[0];
    assert_eq!(scene.name, "Login");
    assert!(
        scene.commands.len() >= 4,
        "got {} commands",
        scene.commands.len()
    );
}

#[test]
fn parses_all_verbs_fixture() {
    let r = parse_file(&fixture("valid/all-verbs.story")).expect("io ok");
    assert!(
        r.diagnostics.iter().all(|d| d.severity != Severity::Error),
        "all-verbs.story must have no errors, got {:?}",
        r.diagnostics
    );
    let ast = r.ast.unwrap();
    assert_eq!(ast.scenes.len(), 1);
    let scene = &ast.scenes[0];
    // 13 verbs.
    assert_eq!(
        scene.commands.len(),
        13,
        "expected 13 commands, got {}",
        scene.commands.len()
    );
    let verbs: Vec<&str> = scene.commands.iter().map(|c| c.verb()).collect();
    let expected = [
        "navigate",
        "click",
        "type",
        "scroll",
        "hover",
        "drag",
        "select",
        "upload",
        "wait",
        "wait-for",
        "assert",
        "screenshot",
        "pause",
    ];
    assert_eq!(verbs, expected);
}

#[test]
fn every_node_has_nonzero_span() {
    let r = parse_file(&fixture("valid/all-verbs.story")).expect("io ok");
    let ast = r.ast.unwrap();
    for scene in &ast.scenes {
        assert!(
            scene.span.start < scene.span.end,
            "scene span empty: {:?}",
            scene.span
        );
        for cmd in &scene.commands {
            let s = cmd.span();
            assert!(
                s.start < s.end,
                "command span empty for verb {:?}: {:?}",
                cmd.verb(),
                s
            );
        }
    }
}

#[test]
fn span_invariant_verb_in_substring() {
    let path = fixture("valid/all-verbs.story");
    let source = std::fs::read_to_string(&path).unwrap();
    let r = parse(&source);
    let ast = r.ast.unwrap();
    for scene in &ast.scenes {
        for cmd in &scene.commands {
            let s = cmd.span();
            let slice = &source[s.start..s.end];
            // wait-for has dash so contains check works
            assert!(
                slice.contains(cmd.verb()),
                "span text '{}' did not contain verb '{}'",
                slice.trim(),
                cmd.verb(),
            );
        }
    }
}

#[test]
fn click_target_text_extracted() {
    let src = "story {\n  scene \"s\" {\n    click \"Save\"\n  }\n}\n";
    let r = parse(src);
    let ast = r.ast.unwrap();
    let cmd = &ast.scenes[0].commands[0];
    match cmd {
        Command::Click { target, .. } => match target {
            story_parser::SelectorOrText::Text(t) => assert_eq!(t, "Save"),
            other => panic!("expected Text target, got {:?}", other),
        },
        other => panic!("expected Click, got {:?}", other),
    }
}

// -------- Tier 1 golden fixtures --------

#[test]
fn tier1_new_forms_fixture_parses_clean_with_expected_variants() {
    use story_parser::{AriaRole, SelectorOrText};

    let path = fixture("valid/tier1_new_forms.story");
    let src = std::fs::read_to_string(&path).expect("fixture exists");
    let r = parse(&src);
    let errs: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errs.is_empty(), "unexpected errors: {:?}", errs);

    let ast = r.ast.as_ref().expect("ast some");
    let cmds: Vec<&Command> = ast.scenes.iter().flat_map(|s| &s.commands).collect();

    let role_count = cmds
        .iter()
        .filter(|c| {
            matches!(
                c,
                Command::Click {
                    target: SelectorOrText::Role { .. },

                    target_nth: None,
                    ..
                } | Command::Hover {
                    target: SelectorOrText::Role { .. },

                    target_nth: None,
                    ..
                }
            )
        })
        .count();
    let label_count = cmds
        .iter()
        .filter(|c| {
            matches!(
                c,
                Command::Type {
                    target: SelectorOrText::Label(_),

                    target_nth: None,
                    ..
                }
            )
        })
        .count();
    let text_exact_count = cmds
        .iter()
        .filter(|c| {
            matches!(
                c,
                Command::Click {
                    target: SelectorOrText::TextExact(_),

                    target_nth: None,
                    ..
                }
            )
        })
        .count();
    assert!(
        role_count >= 4,
        "expected ≥4 Role targets (button+link+image+img+hover), got {role_count}"
    );
    assert_eq!(
        label_count, 1,
        "expected exactly 1 fill→Label desugar, got {label_count}"
    );
    assert_eq!(
        text_exact_count, 1,
        "expected exactly 1 TextExact, got {text_exact_count}"
    );

    // Spot check the img-alias → AriaRole::Image normalization
    let has_img_role = cmds.iter().any(|c| {
        matches!(
            c,
            Command::Click {
                target: SelectorOrText::Role { role: AriaRole::Image, name },

                target_nth: None,
                ..
            } if name == "Hero"
        )
    });
    assert!(
        has_img_role,
        "expected `click img \"Hero\"` to normalize to AriaRole::Image"
    );
}

#[test]
fn tier1_legacy_forms_fixture_uses_only_pre_phase7_variants() {
    use story_parser::SelectorOrText;

    let path = fixture("valid/tier1_legacy_forms.story");
    let src = std::fs::read_to_string(&path).expect("fixture exists");
    let r = parse(&src);
    let errs: Vec<_> = r
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(
        errs.is_empty(),
        "legacy fixture must parse clean, got: {:?}",
        errs
    );

    let ast = r.ast.as_ref().expect("ast some");
    let cmds: Vec<&Command> = ast.scenes.iter().flat_map(|s| &s.commands).collect();
    let target_is_pre_phase7 = |t: &SelectorOrText| {
        matches!(
            t,
            SelectorOrText::Text(_)
                | SelectorOrText::Selector(_)
                | SelectorOrText::TestId(_)
                | SelectorOrText::Aria(_)
        )
    };
    for cmd in &cmds {
        match cmd {
            Command::Click { target, .. }
            | Command::Hover { target, .. }
            | Command::Assert { target, .. }
            | Command::WaitFor { target, .. } => {
                assert!(
                    target_is_pre_phase7(target),
                    "legacy form produced Phase-7 variant: {:?}",
                    target
                );
            }
            Command::Type { target, .. }
            | Command::Select { target, .. }
            | Command::Upload { target, .. } => {
                assert!(
                    target_is_pre_phase7(target),
                    "legacy form produced Phase-7 variant: {:?}",
                    target
                );
            }
            _ => {}
        }
    }
}
