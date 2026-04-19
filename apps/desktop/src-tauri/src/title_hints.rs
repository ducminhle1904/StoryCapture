//! Plan 06-03 — preset-driven Chromium window-title hints for the
//! Playwright auto-follow path. Host-side analog of
//! `apps/desktop/src/features/recorder/title-hints.ts`.
//!
//! `find_window_by_pid` in `crates/capture/src/{macos,windows}/window.rs`
//! does a case-insensitive substring match on `SCWindow::title` /
//! WGC `GetWindowText`. This module maps the persisted
//! `AppSettings.browser_executable` (a raw exec path) to the title
//! substring Chromium uses for its own top-level frames on that
//! channel.
//!
//! D-15 invariant: when we return `None`, the capture start path MUST
//! fall back to "any window owned by the Playwright pid". No hard gate.
//!
//! T-06-15 mitigation: `redact_title_hint` truncates long hints before
//! they hit tracing fields; callers MUST route through it.
//!
//! Backlog #9: the preset data (ids, titles, basename fragments) is no
//! longer hand-maintained here. `build.rs` reads
//! `packages/shared-types/browser-presets.json` and emits a
//! `BROWSER_PRESETS: &[PresetEntry]` slice into `$OUT_DIR/browser_presets.rs`
//! which is `include!`d below. Edit the JSON to add/rename presets.

include!(concat!(env!("OUT_DIR"), "/browser_presets.rs"));

/// Safe lookup. Returns `Some(hint)` on a recognized preset/exec-path;
/// `None` otherwise. Never panics.
///
/// Iteration uses the generated slice's order, which mirrors JSON order
/// (specific-first: `chrome-canary` before `chrome`, `msedge-canary`
/// before `msedge`). Adding a variant in the wrong position would let
/// the parent preset's basename fragment shadow the variant — the JSON
/// documents this invariant in its `_comment`.
pub fn title_hint_for(preset: Option<&str>) -> Option<String> {
    let input = preset?.trim();
    if input.is_empty() {
        return None;
    }
    let lower = input.to_lowercase();

    // Direct preset-id lookup.
    if let Some(p) = BROWSER_PRESETS.iter().find(|p| p.id == lower) {
        return Some(p.title.to_string());
    }

    // Exec-path basename heuristic.
    let basename = lower.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    if basename.is_empty() {
        return None;
    }
    for p in BROWSER_PRESETS {
        if p.basenames.iter().any(|b| basename.contains(b)) {
            return Some(p.title.to_string());
        }
    }
    None
}

/// T-06-15 log redaction: truncate to 40 chars + ellipsis marker.
pub fn redact_title_hint(h: Option<&str>) -> String {
    match h {
        None => "<none>".to_string(),
        Some(s) if s.chars().count() <= 40 => s.to_string(),
        Some(s) => {
            // Keep first 40 chars, then append ellipsis. Walk by
            // char_indices to stay on a char boundary under multi-byte UTF-8.
            let end = s.char_indices().nth(40).map(|(i, _)| i).unwrap_or(s.len());
            format!("{}\u{2026}", &s[..end])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_token_lookup_exact() {
        assert_eq!(
            title_hint_for(Some("msedge")).as_deref(),
            Some("Microsoft Edge")
        );
        assert_eq!(
            title_hint_for(Some("chrome")).as_deref(),
            Some("Google Chrome")
        );
        assert_eq!(
            title_hint_for(Some("chrome-canary")).as_deref(),
            Some("Google Chrome Canary")
        );
        assert_eq!(
            title_hint_for(Some("brave")).as_deref(),
            Some("Brave Browser")
        );
        assert_eq!(title_hint_for(Some("arc")).as_deref(), Some("Arc"));
    }

    #[test]
    fn preset_token_lookup_case_insensitive() {
        assert_eq!(
            title_hint_for(Some("MSEDGE")).as_deref(),
            Some("Microsoft Edge")
        );
        assert_eq!(
            title_hint_for(Some("Chrome-Canary")).as_deref(),
            Some("Google Chrome Canary")
        );
    }

    #[test]
    fn none_for_empty_input() {
        assert_eq!(title_hint_for(None), None);
        assert_eq!(title_hint_for(Some("")), None);
        assert_eq!(title_hint_for(Some("   ")), None);
    }

    #[test]
    fn none_for_unknown_preset() {
        assert_eq!(title_hint_for(Some("firefox")), None);
        assert_eq!(title_hint_for(Some("safari")), None);
    }

    #[test]
    fn exec_path_macos_chrome() {
        assert_eq!(
            title_hint_for(Some(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ))
            .as_deref(),
            Some("Google Chrome")
        );
    }

    #[test]
    fn exec_path_macos_edge() {
        assert_eq!(
            title_hint_for(Some(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
            ))
            .as_deref(),
            Some("Microsoft Edge")
        );
    }

    #[test]
    fn exec_path_canary_beats_chrome() {
        assert_eq!(
            title_hint_for(Some(
                "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
            ))
            .as_deref(),
            Some("Google Chrome Canary")
        );
    }

    /// Backlog #9 regression: msedge-canary was previously present in the
    /// frontend CHROMIUM_PRESETS set but missing from both title-hint tables,
    /// so Edge Canary auto-follow silently fell back to pid-only matching.
    #[test]
    fn exec_path_edge_canary_beats_generic_edge() {
        assert_eq!(
            title_hint_for(Some("msedge-canary")).as_deref(),
            Some("Microsoft Edge Canary")
        );
        assert_eq!(
            title_hint_for(Some(
                "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary"
            ))
            .as_deref(),
            Some("Microsoft Edge Canary")
        );
    }

    #[test]
    fn exec_path_brave() {
        assert_eq!(
            title_hint_for(Some(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
            ))
            .as_deref(),
            Some("Brave Browser")
        );
    }

    #[test]
    fn redact_short_passthrough() {
        assert_eq!(redact_title_hint(Some("Microsoft Edge")), "Microsoft Edge");
    }

    #[test]
    fn redact_long_truncates_with_ellipsis() {
        let long = "A".repeat(80);
        let out = redact_title_hint(Some(&long));
        assert!(out.chars().count() <= 41);
        assert!(out.ends_with('\u{2026}'));
    }

    #[test]
    fn redact_none_placeholder() {
        assert_eq!(redact_title_hint(None), "<none>");
    }

    /// Backlog #9 — codegen sanity: the generated table must contain the
    /// 11 canonical presets including `msedge-canary` (the variant whose
    /// absence originally motivated backlog #9). Catches accidental JSON
    /// edits that drop an entry.
    #[test]
    fn codegen_table_contains_canonical_presets() {
        assert_eq!(BROWSER_PRESETS.len(), 11);
        let ids: Vec<&str> = BROWSER_PRESETS.iter().map(|p| p.id).collect();
        for expected in [
            "chromium",
            "chrome-canary",
            "chrome-beta",
            "chrome-dev",
            "chrome",
            "msedge-canary",
            "msedge-beta",
            "msedge-dev",
            "msedge",
            "brave",
            "arc",
        ] {
            assert!(
                ids.contains(&expected),
                "BROWSER_PRESETS missing id {expected}; generated ids = {ids:?}"
            );
        }
        // Specific-first invariant: variants precede their parent preset.
        let pos = |id: &str| ids.iter().position(|x| *x == id).expect(id);
        assert!(pos("chrome-canary") < pos("chrome"));
        assert!(pos("msedge-canary") < pos("msedge"));
    }
}
