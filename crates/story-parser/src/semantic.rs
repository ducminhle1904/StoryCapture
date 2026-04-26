//! Layer 2 of the two-layer parse: take the lenient token stream,
//! validate semantic constraints, emit structured diagnostics, and
//! produce the typed `Story` AST.

use crate::ast::{
    AriaRole, Command, Meta, Scene, ScrollDir, SelectorOrText, Span, Story, Theme, Viewport,
};
use crate::diagnostic::Diagnostic;
use crate::lenient_tokenize::{
    LenientToken, MetaEntry, MetaRawValue, ParsedCommand, RawNth, RawTarget,
};
use crate::suggest::{did_you_mean, KNOWN_META_KEYS, KNOWN_ROLES, KNOWN_VERBS};
use uuid::Uuid;

/// Suspiciously large nth threshold. Locating the 100th match is virtually
/// always a typo (`nth 99` vs `nth 9`). Warning is informational; the value
/// still flows through to the AST so the user can override intentionally.
const NTH_LARGE_THRESHOLD: u32 = 100;

/// Validate a raw `nth N` modifier from layer 1.
/// - `nth 0` is invalid (DSL is 1-indexed) — emits a warning AND returns None
///   so the executor never calls Playwright's `.nth(-1)`. This preserves the
///   pre-Phase-F behavior of `nth 0` collapsing to None.
/// - `nth N` with N > 100 emits an informational warning but the value flows
///   through unchanged.
/// - Otherwise returns `Some(N)` with no diagnostic.
fn validate_nth(raw: Option<RawNth>, diagnostics: &mut Vec<Diagnostic>) -> Option<u32> {
    let r = raw?;
    if r.value == 0 {
        diagnostics.push(Diagnostic::warning(
            "nth is 1-indexed; `nth 0` is invalid and was ignored (use `nth 1` for the first match)",
            r.span,
        ));
        return None;
    }
    if r.value > NTH_LARGE_THRESHOLD {
        diagnostics.push(Diagnostic::warning(
            format!(
                "nth {} is unusually large — likely a typo (Playwright locators rarely have that many matches)",
                r.value
            ),
            r.span,
        ));
    }
    Some(r.value)
}

pub fn validate(tokens: Vec<LenientToken>, _source: &str) -> (Story, Vec<Diagnostic>) {
    let mut story = Story::default();
    let mut diagnostics = Vec::new();

    let mut current_scene: Option<Scene> = None;

    for tok in tokens {
        match tok {
            LenientToken::StoryStart { name, span } => {
                story.name = name;
                story.span = span;
            }
            LenientToken::StoryEnd => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
            }
            LenientToken::Meta { entries, span } => {
                let (meta, mut more) = build_meta(entries, span);
                story.meta = meta;
                diagnostics.append(&mut more);
            }
            LenientToken::SceneStart { name, span } => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
                current_scene = Some(Scene {
                    name,
                    commands: vec![],
                    span,
                });
            }
            LenientToken::SceneEnd => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
            }
            LenientToken::Command {
                pair_kind,
                span,
                step_id_raw,
            } => {
                if let Some(scene) = current_scene.as_mut() {
                    // Validate trailing `# @id=<uuidv7>` — invalid UUIDs degrade
                    // to `step_id = None` + a warn-level diagnostic (layer-2).
                    let step_id = match step_id_raw.as_deref() {
                        Some(raw) => match Uuid::parse_str(raw) {
                            Ok(u) => Some(u),
                            Err(_) => {
                                diagnostics.push(Diagnostic::warning(
                                    format!("invalid step id '{}' — expected UUIDv7, ignored", raw),
                                    span,
                                ));
                                None
                            }
                        },
                        None => None,
                    };
                    let (cmd, mut more) = build_command(pair_kind, span, step_id);
                    diagnostics.append(&mut more);
                    if let Some(c) = cmd {
                        scene.commands.push(c);
                    }
                } else {
                    diagnostics.push(Diagnostic::error("command outside of scene block", span));
                }
            }
            LenientToken::Unknown { text, span } => {
                let first_word = text
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
                if first_word.is_empty() {
                    continue;
                }
                let mut diag = Diagnostic::error(format!("unknown command '{}'", first_word), span);
                if let Some(suggestion) = did_you_mean(first_word, KNOWN_VERBS) {
                    diag = diag.with_suggestion(suggestion.clone()).clone();
                    diag.message = format!(
                        "unknown command '{}' — did you mean '{}'?",
                        first_word, suggestion
                    );
                }
                diagnostics.push(diag);
            }
        }
    }

    (story, diagnostics)
}

fn build_meta(entries: Vec<MetaEntry>, span: Span) -> (Meta, Vec<Diagnostic>) {
    let mut meta = Meta {
        span,
        ..Default::default()
    };
    let mut diagnostics = Vec::new();

    for entry in entries {
        match entry.key.as_str() {
            "app" => match &entry.value {
                MetaRawValue::String(s) => {
                    if !s.starts_with("http://") && !s.starts_with("https://") {
                        diagnostics.push(Diagnostic::warning(
                            format!("meta.app '{}' has no http(s) scheme", s),
                            entry.value_span,
                        ));
                    }
                    meta.app = Some(s.clone());
                }
                _ => diagnostics.push(Diagnostic::error(
                    "meta.app must be a quoted string URL",
                    entry.value_span,
                )),
            },
            "viewport" => match &entry.value {
                MetaRawValue::ViewportPair { width, height }
                | MetaRawValue::ViewportStruct { width, height } => {
                    meta.viewport = Some(Viewport { width: *width, height: *height });
                }
                MetaRawValue::Ident(name) => {
                    let preset = match name.as_str() {
                        "desktop" => Some((1280u32, 800u32)),
                        "tablet" => Some((1024, 768)),
                        "mobile" => Some((375, 667)),
                        _ => None,
                    };
                    match preset {
                        Some((w, h)) => meta.viewport = Some(Viewport { width: w, height: h }),
                        None => diagnostics.push(Diagnostic::error(
                            format!(
                                "invalid viewport '{}' (expected WIDTHxHEIGHT, e.g. 1280x800, or one of: desktop|tablet|mobile)",
                                name
                            ),
                            entry.value_span,
                        )),
                    }
                }
                _ => diagnostics.push(Diagnostic::error(
                    "viewport must be WIDTHxHEIGHT (e.g. 1280x800) or one of: desktop|tablet|mobile",
                    entry.value_span,
                )),
            },
            "theme" => match &entry.value {
                MetaRawValue::Ident(name) | MetaRawValue::String(name) => {
                    let theme = match name.as_str() {
                        "light" => Some(Theme::Light),
                        "dark" => Some(Theme::Dark),
                        "auto" => Some(Theme::Auto),
                        _ => None,
                    };
                    match theme {
                        Some(t) => meta.theme = Some(t),
                        None => diagnostics.push(Diagnostic::error(
                            format!(
                                "invalid theme '{}' (expected one of: light|dark|auto)",
                                name
                            ),
                            entry.value_span,
                        )),
                    }
                }
                _ => diagnostics.push(Diagnostic::error(
                    "theme must be one of: light|dark|auto",
                    entry.value_span,
                )),
            },
            "speed" => match &entry.value {
                MetaRawValue::Number(n) => {
                    if *n < 0.1 || *n > 3.0 {
                        diagnostics.push(Diagnostic::warning(
                            format!("speed {} is outside the supported range 0.1-3.0", n),
                            entry.value_span,
                        ));
                    }
                    meta.speed = Some(*n as f32);
                }
                _ => diagnostics.push(Diagnostic::error(
                    "speed must be a number between 0.1 and 3.0",
                    entry.value_span,
                )),
            },
            other => {
                let mut diag = Diagnostic::error(
                    format!("unknown meta key '{}'", other),
                    entry.key_span,
                );
                if let Some(suggestion) = did_you_mean(other, KNOWN_META_KEYS) {
                    diag.message = format!(
                        "unknown meta key '{}' — did you mean '{}'?",
                        other, suggestion
                    );
                    diag.suggestion = Some(suggestion);
                }
                diagnostics.push(diag);
            }
        }
    }

    (meta, diagnostics)
}

fn build_command(
    parsed: ParsedCommand,
    span: Span,
    step_id: Option<Uuid>,
) -> (Option<Command>, Vec<Diagnostic>) {
    let mut diagnostics = Vec::new();
    let cmd = match parsed {
        ParsedCommand::Navigate { url } => {
            if url.is_empty() {
                diagnostics.push(Diagnostic::error("navigate URL must not be empty", span));
            } else if !url.starts_with("http://")
                && !url.starts_with("https://")
                && !url.starts_with("file://")
                && !url.starts_with("about:")
            {
                diagnostics.push(Diagnostic::warning(
                    format!("navigate URL '{}' has no scheme", url),
                    span,
                ));
            }
            Command::Navigate { url, span, step_id }
        }
        ParsedCommand::Click { target, target_nth } => Command::Click {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            span,
            step_id,
        },
        ParsedCommand::Type {
            target,
            target_nth,
            text,
        } => Command::Type {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            text,
            span,
            step_id,
        },
        ParsedCommand::Scroll { direction, amount } => Command::Scroll {
            direction: parse_scroll_dir(&direction),
            amount,
            span,
            step_id,
        },
        ParsedCommand::Hover { target, target_nth } => Command::Hover {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            span,
            step_id,
        },
        ParsedCommand::Drag {
            from,
            from_nth,
            to,
            to_nth,
        } => Command::Drag {
            from: to_target(from, span, &mut diagnostics),
            from_nth: validate_nth(from_nth, &mut diagnostics),
            to: to_target(to, span, &mut diagnostics),
            to_nth: validate_nth(to_nth, &mut diagnostics),
            span,
            step_id,
        },
        ParsedCommand::Select {
            target,
            target_nth,
            value,
        } => Command::Select {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            value,
            span,
            step_id,
        },
        ParsedCommand::Upload {
            target,
            target_nth,
            path,
        } => Command::Upload {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            path,
            span,
            step_id,
        },
        ParsedCommand::Wait { duration_ms } => Command::Wait {
            duration_ms,
            span,
            step_id,
        },
        ParsedCommand::WaitFor {
            target,
            target_nth,
            timeout_ms,
        } => Command::WaitFor {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            timeout_ms,
            span,
            step_id,
        },
        ParsedCommand::Assert { target, target_nth } => Command::Assert {
            target: to_target(target, span, &mut diagnostics),
            target_nth: validate_nth(target_nth, &mut diagnostics),
            span,
            step_id,
        },
        ParsedCommand::Screenshot { name } => Command::Screenshot {
            name,
            span,
            step_id,
        },
        ParsedCommand::Pause => Command::Pause { span, step_id },
    };
    (Some(cmd), diagnostics)
}

fn parse_scroll_dir(s: &str) -> ScrollDir {
    match s {
        "up" => ScrollDir::Up,
        "down" => ScrollDir::Down,
        "left" => ScrollDir::Left,
        "right" => ScrollDir::Right,
        _ => ScrollDir::Down,
    }
}

fn to_target(t: RawTarget, span: Span, diagnostics: &mut Vec<Diagnostic>) -> SelectorOrText {
    match t {
        RawTarget::Text(s) => SelectorOrText::Text(s),
        RawTarget::Selector(s) => SelectorOrText::Selector(s),
        RawTarget::TestId(s) => SelectorOrText::TestId(s),
        RawTarget::Aria(s) => SelectorOrText::Aria(s),
        RawTarget::Label(s) => SelectorOrText::Label(s),
        RawTarget::TextExact(s) => SelectorOrText::TextExact(s),
        RawTarget::Role { role, name } => {
            // DRIFT GUARD: because `role_kw` in grammar.pest is a closed
            // atomic rule, reaching this `None` branch means grammar.pest
            // and `AriaRole::from_keyword` have drifted apart.
            // `KNOWN_ROLES` mirrors the grammar keyword list.
            match AriaRole::from_keyword(&role) {
                Some(aria_role) => SelectorOrText::Role {
                    role: aria_role,
                    name,
                },
                None => {
                    let mut diag = Diagnostic::error(format!("unknown role '{}'", role), span);
                    if let Some(suggestion) = did_you_mean(&role, KNOWN_ROLES) {
                        diag.message =
                            format!("unknown role '{}' — did you mean '{}'?", role, suggestion);
                        diag.suggestion = Some(suggestion);
                    }
                    diagnostics.push(diag);
                    // Best-effort fallback so the command still produces an AST node
                    // and downstream passes can keep flowing (consistent with how
                    // unknown verbs degrade in `validate`).
                    SelectorOrText::Text(name)
                }
            }
        }
    }
}

/// Test-only re-export: lets unit tests in this module (and the integration
/// test harness in golden.rs) exercise the `to_target` KNOWN_ROLES drift
/// guard directly, bypassing the grammar (where `role_kw` is closed and
/// would never produce a `RawTarget::Role` with an unknown spelling).
#[cfg(test)]
pub(crate) fn to_target_for_test(
    t: RawTarget,
    span: Span,
    diagnostics: &mut Vec<Diagnostic>,
) -> SelectorOrText {
    to_target(t, span, diagnostics)
}

#[cfg(test)]
mod tier1_tests {
    use crate::ast::{AriaRole, Command, SelectorOrText};
    use crate::diagnostic::{Diagnostic, Severity};
    use crate::lenient_tokenize::RawTarget;
    use crate::parse;

    fn single_command(src: &str) -> Command {
        let r = parse(src);
        assert!(
            r.diagnostics
                .iter()
                .all(|d| !matches!(d.severity, Severity::Error)),
            "unexpected errors: {:?}",
            r.diagnostics
        );
        let story = r.ast.unwrap();
        story.scenes[0].commands[0].clone()
    }

    #[test]
    fn click_button_parses_to_role_button() {
        let cmd = single_command("story { scene \"s\" { click button \"Save\" } }");
        match cmd {
            Command::Click {
                target: SelectorOrText::Role { role, name },
                ..
            } => {
                assert_eq!(role, AriaRole::Button);
                assert_eq!(name, "Save");
            }
            other => panic!("expected Role(Button), got {:?}", other),
        }
    }

    #[test]
    fn click_img_alias_maps_to_image_role() {
        let cmd = single_command("story { scene \"s\" { click img \"Hero\" } }");
        match cmd {
            Command::Click {
                target: SelectorOrText::Role { role, .. },
                ..
            } => {
                assert_eq!(role, AriaRole::Image);
            }
            other => panic!("expected Role(Image), got {:?}", other),
        }
    }

    #[test]
    fn fill_field_desugars_to_type_label() {
        let cmd = single_command("story { scene \"s\" { fill field \"Email\" with \"a@x\" } }");
        match cmd {
            Command::Type {
                target: SelectorOrText::Label(name),
                text,
                ..
            } => {
                assert_eq!(name, "Email");
                assert_eq!(text, "a@x");
            }
            other => panic!("expected Type(Label), got {:?}", other),
        }
    }

    #[test]
    fn click_text_keyword_is_text_exact() {
        let cmd = single_command("story { scene \"s\" { click text \"Learn more\" } }");
        match cmd {
            Command::Click {
                target: SelectorOrText::TextExact(s),
                ..
            } => {
                assert_eq!(s, "Learn more");
            }
            other => panic!("expected TextExact, got {:?}", other),
        }
    }

    #[test]
    fn bare_text_still_maps_to_text_variant() {
        // Backwards-compat regression guard.
        let cmd = single_command("story { scene \"s\" { click \"Learn more\" } }");
        match cmd {
            Command::Click {
                target: SelectorOrText::Text(s),
                ..
            } => {
                assert_eq!(s, "Learn more");
            }
            other => panic!("expected Text (bare), got {:?}", other),
        }
    }

    #[test]
    fn legacy_selector_testid_aria_unchanged() {
        // Backwards-compat: every legacy explicit-kind form must map to its
        // original variant.
        let src = r##"story { scene "s" {
            click selector "#save"
            click testid "save"
            click aria "Save"
        } }"##;
        let r = parse(src);
        assert!(r
            .diagnostics
            .iter()
            .all(|d| !matches!(d.severity, Severity::Error)));
        let cmds = &r.ast.unwrap().scenes[0].commands;
        assert!(matches!(
            cmds[0],
            Command::Click { target: SelectorOrText::Selector(ref s), .. } if s == "#save"
        ));
        assert!(matches!(
            cmds[1],
            Command::Click { target: SelectorOrText::TestId(ref s), .. } if s == "save"
        ));
        assert!(matches!(
            cmds[2],
            Command::Click { target: SelectorOrText::Aria(ref s), .. } if s == "Save"
        ));
    }

    // DIRECT drift-guard test — bypasses the grammar (where `role_kw` is a
    // closed atomic rule and `buton` would fall to unknown-verb recovery)
    // and exercises the `to_target` KNOWN_ROLES + did_you_mean path by
    // constructing a `RawTarget::Role` in-process. This is the ONLY path
    // that actually proves the `KNOWN_ROLES` drift guard fires its
    // diagnostic; asserting on the full parse pipeline would instead hit
    // the verb-level recovery.
    #[test]
    fn unknown_role_emits_did_you_mean_direct() {
        use crate::ast::Span;
        use crate::semantic::to_target_for_test;

        let mut diags: Vec<Diagnostic> = Vec::new();
        let span = Span::default();
        let result = to_target_for_test(
            RawTarget::Role {
                role: "buton".into(),
                name: "Save".into(),
            },
            span,
            &mut diags,
        );
        // Fallback: degraded to Text("Save") so pipeline keeps flowing.
        assert!(
            matches!(result, SelectorOrText::Text(ref s) if s == "Save"),
            "expected Text(Save) fallback, got {:?}",
            result
        );
        // Diagnostic: error severity, mentions `button` (the KNOWN_ROLES
        // Levenshtein hit).
        let has_did_you_mean = diags.iter().any(|d| {
            matches!(d.severity, Severity::Error)
                && d.message.contains("unknown role 'buton'")
                && d.message.contains("button")
        });
        assert!(
            has_did_you_mean,
            "expected KNOWN_ROLES did-you-mean diagnostic, got: {:?}",
            diags
        );
    }
}
