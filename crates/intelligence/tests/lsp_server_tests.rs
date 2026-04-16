//! In-process tests for `StoryLanguageServer` (plan 03-13, task 1).
//!
//! Uses the `InProcessServer` test facade which shares all logic with
//! the real `tower-lsp::LanguageServer` impl but skips the JSON-RPC
//! transport. This exercises:
//!
//! 1. `did_open` stores the doc + publishes diagnostics
//! 2. `did_change` (INCREMENTAL) updates rope + re-publishes diagnostics
//! 3. `did_close` removes doc; subsequent hover is None
//! 4. Grammar error produces a precise ERROR Diagnostic
//! 5. Unknown verb produces a WARNING with "Did you mean …" suggestion
//! 6. Completion filters verbs by prefix

use intelligence::lsp::server::testing::InProcessServer;
use tower_lsp::lsp_types::{
    CompletionItemKind, DiagnosticSeverity, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, HoverContents, Position, Range,
    TextDocumentContentChangeEvent, TextDocumentIdentifier, TextDocumentItem, Url,
    VersionedTextDocumentIdentifier,
};

fn uri(path: &str) -> Url {
    Url::parse(&format!("file:///tmp/{path}")).unwrap()
}

fn open(server: &InProcessServer, u: &Url, text: &str) {
    server.did_open(DidOpenTextDocumentParams {
        text_document: TextDocumentItem {
            uri: u.clone(),
            language_id: "story".into(),
            version: 1,
            text: text.into(),
        },
    });
}

fn change_incremental(
    server: &InProcessServer,
    u: &Url,
    version: i32,
    edits: Vec<(Range, &str)>,
) {
    server.did_change(DidChangeTextDocumentParams {
        text_document: VersionedTextDocumentIdentifier { uri: u.clone(), version },
        content_changes: edits
            .into_iter()
            .map(|(r, t)| TextDocumentContentChangeEvent {
                range: Some(r),
                range_length: None,
                text: t.into(),
            })
            .collect(),
    });
}

// ---------------------------------------------------------------------
// Test 1: did_open stores doc; hover on `click` returns verb catalog doc.
// ---------------------------------------------------------------------
#[test]
fn did_open_stores_doc_and_hover_returns_verb_doc() {
    let server = InProcessServer::new();
    let u = uri("t1.story");
    let src = "story \"t\" {\n  scene \"s\" {\n    click \"Login\"\n  }\n}\n";
    open(&server, &u, src);

    assert!(server.docs.contains_key(&u));
    assert!(server.latest(&u).is_some(), "did_open should publish diagnostics");

    // Position on 'click' (line 2 = "    click \"Login\"", char 6 is inside 'click').
    let hover = server.hover_at(&u, Position { line: 2, character: 6 }).unwrap();
    match hover.contents {
        HoverContents::Markup(m) => {
            assert!(
                m.value.contains("click"),
                "hover content should mention `click`, got: {}",
                m.value
            );
        }
        _ => panic!("expected Markup hover"),
    }
}

// ---------------------------------------------------------------------
// Test 2: did_change applies incremental edits; diagnostics re-published.
// ---------------------------------------------------------------------
#[test]
fn did_change_applies_incremental_edits_and_publishes_diagnostics() {
    let server = InProcessServer::new();
    let u = uri("t2.story");
    // Start with a valid doc.
    let src = "story \"t\" {\n  scene \"s\" {\n    click \"Login\"\n  }\n}\n";
    open(&server, &u, src);
    let initial_count = server.published().len();

    // Replace `click` with `clik` (unknown verb → should produce diagnostic).
    // Line 2 = `    click "Login"` — `click` spans char 4..9.
    change_incremental(
        &server,
        &u,
        2,
        vec![(
            Range {
                start: Position { line: 2, character: 4 },
                end: Position { line: 2, character: 9 },
            },
            "clik",
        )],
    );

    let after = server.published();
    assert!(after.len() > initial_count, "did_change should publish diagnostics");
    let last = after.last().unwrap();
    assert_eq!(last.uri, u);
    // Rope should now contain "clik".
    let text = server.docs.get(&u).unwrap().to_string();
    assert!(text.contains("clik"), "rope text after edit: {text}");
    assert!(!text.contains("click"), "old text should be gone: {text}");
}

// ---------------------------------------------------------------------
// Test 3: did_close removes doc; hover returns None afterwards.
// ---------------------------------------------------------------------
#[test]
fn did_close_removes_doc_and_stale_hover_returns_none() {
    let server = InProcessServer::new();
    let u = uri("t3.story");
    open(&server, &u, "story \"t\" {\n  scene \"s\" {\n    click \"x\"\n  }\n}\n");
    assert!(server.docs.contains_key(&u));

    server.did_close(DidCloseTextDocumentParams {
        text_document: TextDocumentIdentifier { uri: u.clone() },
    });

    assert!(!server.docs.contains_key(&u));
    let hover = server.hover_at(&u, Position { line: 2, character: 6 });
    assert!(hover.is_none());

    // did_close should have published an empty diagnostic set.
    let last = server.latest(&u).unwrap();
    assert!(last.diagnostics.is_empty());
}

// ---------------------------------------------------------------------
// Test 4: grammar error produces an ERROR Diagnostic with a span.
// ---------------------------------------------------------------------
#[test]
fn grammar_error_produces_error_diagnostic() {
    let server = InProcessServer::new();
    let u = uri("t4.story");
    // Missing closing quote — should trip the pest parser.
    // Top-level token other than `story` blows up the grammar entirely
    // (the `file` rule requires `story_block?` — any junk at SOI is a
    // hard parse error, not a recoverable statement).
    let src = "@@@ not a story file\n";
    open(&server, &u, src);

    let published = server.latest(&u).expect("should have published diagnostics");
    let errors: Vec<_> = published
        .diagnostics
        .iter()
        .filter(|d| d.severity == Some(DiagnosticSeverity::ERROR))
        .collect();
    assert!(
        !errors.is_empty(),
        "expected at least one ERROR diagnostic, got: {:?}",
        published.diagnostics
    );
    let err = errors[0];
    // Range must be well-formed (start <= end).
    assert!(
        err.range.start.line <= err.range.end.line
            || (err.range.start.line == err.range.end.line
                && err.range.start.character <= err.range.end.character),
        "range must be well-formed: {:?}",
        err.range
    );
    assert_eq!(err.source.as_deref(), Some("story-parser"));
}

// ---------------------------------------------------------------------
// Test 5: unknown verb `teleport` produces a WARNING with "Did you mean".
// ---------------------------------------------------------------------
#[test]
fn unknown_verb_produces_did_you_mean_warning() {
    let server = InProcessServer::new();
    let u = uri("t5.story");
    // "clik" is Levenshtein distance 1 from "click" — must trigger a
    // concrete "Did you mean 'click'?" suggestion from the parser.
    let src = "story \"t\" {\n  scene \"s\" {\n    clik \"x\"\n  }\n}\n";
    open(&server, &u, src);

    let published = server.latest(&u).expect("should have published diagnostics");
    let warnings: Vec<_> = published
        .diagnostics
        .iter()
        .filter(|d| d.severity == Some(DiagnosticSeverity::WARNING))
        .collect();
    assert!(
        !warnings.is_empty(),
        "expected WARNING diagnostic for unknown verb, got: {:?}",
        published.diagnostics
    );
    let w = warnings
        .iter()
        .find(|d| d.message.to_ascii_lowercase().contains("did you mean"))
        .unwrap_or_else(|| panic!("expected 'Did you mean' message, got: {:?}", warnings));
    // The parser's Levenshtein should find some real verb within distance 2 of
    // "teleport" (in practice: often "type" or similar). We only assert that
    // SOME known verb is suggested.
    let known = [
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
    let mentions_known = known.iter().any(|v| w.message.contains(v));
    assert!(
        mentions_known,
        "warning should reference a known verb in its suggestion; got: {}",
        w.message
    );
}

// ---------------------------------------------------------------------
// Test 6: completion after `cl` includes `click` with KEYWORD kind.
// ---------------------------------------------------------------------
#[test]
fn completion_filters_by_prefix() {
    let server = InProcessServer::new();
    let u = uri("t6.story");
    let src = "story \"t\" {\n  scene \"s\" {\n    cl\n  }\n}\n";
    open(&server, &u, src);

    // Line 2 = "    cl" — cursor at end of "cl" is char 6.
    let items = server.complete_at(&u, Position { line: 2, character: 6 });
    assert!(
        items.iter().any(|i| i.label == "click"),
        "completion should include `click`, got labels: {:?}",
        items.iter().map(|i| &i.label).collect::<Vec<_>>()
    );
    let click = items.iter().find(|i| i.label == "click").unwrap();
    assert_eq!(click.kind, Some(CompletionItemKind::KEYWORD));
    // Prefix filter should exclude unrelated verbs like `navigate`.
    assert!(
        !items.iter().any(|i| i.label == "navigate"),
        "completion with prefix `cl` should NOT include `navigate`"
    );
}
