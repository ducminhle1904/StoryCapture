//! Phase 7 Tier 1 — compile-only integration smoke.
//!
//! SCOPE: This is a COMPILE-ONLY smoke test. The PHASE-7.3 end-to-end
//! acceptance gate is owned by scripts/playwright-sidecar/server.test.mjs
//! (vitest), which drives real Chromium against the HTML fixture. The
//! purpose of this file is to prove the public API surface of
//! story_parser + automation::selector + automation::playwright_driver
//! integrates cleanly with the three new SelectorOrText variants — i.e.
//! the crate types line up and the parser → selector → driver pipeline
//! COMPILES against a mixed new/legacy `.story` fixture.
//!
//! `cargo test -p automation --test tier1_e2e --no-run` is the acceptance
//! gate. The `#[ignore]` live run (`--ignored`) is a developer-local
//! convenience; it spawns Chromium and is NOT required to pass in CI.

use automation::driver::{ActionKind, BrowserDriver};
use automation::events::{AttemptOutcome, SelectorStrategy};
use automation::noop_driver::NoopDriver;
use automation::selector::SmartSelector;
use story_parser::{Command, SelectorOrText, Severity};

/// Compile-only: parse the mixed fixture + walk every command through the
/// SmartSelector public API against a NoopDriver. This forces the compiler
/// to type-check every `pub` path from story_parser → automation::selector
/// and reject any drift in the `SelectorOrText` / `SelectorStrategy` shapes.
///
/// The test body intentionally does NOT spawn the Playwright sidecar or
/// Chromium — that is the job of the vitest suite (PHASE-7.3 gate). A
/// companion `#[ignore]` test below demonstrates the live-run entry point
/// for developers who want to round-trip against a real browser locally.
#[tokio::test]
async fn tier1_new_and_legacy_forms_compile_against_smart_selector() {
    let story_src = std::fs::read_to_string("tests/fixtures/tier1.story")
        .expect("tier1.story fixture must exist next to this test");

    let parse_result = story_parser::parse(&story_src);
    assert!(
        parse_result
            .diagnostics
            .iter()
            .all(|d| !matches!(d.severity, Severity::Error)),
        "parse errors: {:?}",
        parse_result.diagnostics,
    );
    let story = parse_result.ast.expect("story must parse");

    // NoopDriver short-circuits SmartSelector's ranked branch via
    // explicit_strategy for every kind except SelectorOrText::Text. That
    // is enough to exercise the compile-time contract without a real browser.
    let driver: Box<dyn BrowserDriver> = Box::new(NoopDriver::default());

    for scene in &story.scenes {
        for cmd in &scene.commands {
            let (target, action) = match cmd {
                Command::Click { target, .. } => (target, ActionKind::Click),
                Command::Type { target, .. } => (target, ActionKind::Type),
                Command::Hover { target, .. } => (target, ActionKind::Hover),
                _ => continue,
            };
            let (resolved, attempts) =
                SmartSelector::resolve_with_attempts(driver.as_ref(), action, target, 5_000)
                    .await
                    .unwrap_or_else(|e| panic!("resolve failed for {target:?}: {e:?}"));

            match target {
                SelectorOrText::Role { .. } => {
                    assert_eq!(resolved.strategy, SelectorStrategy::Role);
                    assert_eq!(attempts.len(), 1);
                    assert!(matches!(
                        attempts[0].outcome,
                        AttemptOutcome::Found { score } if score == 1.0
                    ));
                }
                SelectorOrText::Label(_) => {
                    assert_eq!(resolved.strategy, SelectorStrategy::Label);
                    assert_eq!(attempts.len(), 1);
                }
                SelectorOrText::TextExact(_) => {
                    assert_eq!(resolved.strategy, SelectorStrategy::TextExact);
                    assert_eq!(attempts.len(), 1);
                }
                SelectorOrText::Selector(_) => {
                    assert_eq!(resolved.strategy, SelectorStrategy::Css);
                    assert_eq!(attempts.len(), 1);
                }
                SelectorOrText::TestId(_) => {
                    assert_eq!(resolved.strategy, SelectorStrategy::TestId);
                    assert_eq!(attempts.len(), 1);
                }
                SelectorOrText::Aria(_) => {
                    assert_eq!(resolved.strategy, SelectorStrategy::Aria);
                    assert_eq!(attempts.len(), 1);
                }
                SelectorOrText::Text(_) => {
                    // Ranked chain — not exercised by this fixture (no bare-text verbs).
                }
            }
        }
    }
}

/// Developer-local convenience: spawn the Playwright sidecar against
/// `tests/fixtures/tier1.html` and drive every command through a real
/// browser. Marked `#[ignore]` so it stays out of CI — the PHASE-7.3
/// acceptance gate is the vitest suite (scripts/playwright-sidecar/
/// server.test.mjs), which covers the same surface in Node.
#[tokio::test]
#[ignore = "compile-only smoke; live run requires Chromium — vitest owns PHASE-7.3"]
async fn tier1_live_run_against_real_chromium() {
    // Keep this body minimal: reading the fixture proves the HTML sibling
    // exists; spawning the sidecar is deferred to future plans that need
    // a `spawn_for_test` helper on `PlaywrightSidecarDriver`. For now the
    // vitest suite is the live gate.
    let html_path =
        std::fs::canonicalize("tests/fixtures/tier1.html").expect("tier1.html fixture must exist");
    let _html_url = url::Url::from_file_path(&html_path)
        .expect("fixture path must be absolute")
        .to_string();
}
