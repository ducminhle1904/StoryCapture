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

/// Host-side mirror of `BROWSER_TITLE_HINTS` (features/recorder/title-hints.ts).
/// Keys are lowercase preset tokens; values are the title substrings.
const PRESET_TOKENS: &[(&str, &str)] = &[
    ("chromium", "Chromium"),
    ("chrome-canary", "Google Chrome Canary"),
    ("chrome-beta", "Google Chrome Beta"),
    ("chrome-dev", "Google Chrome Dev"),
    ("chrome", "Google Chrome"),
    ("msedge-canary", "Microsoft Edge Canary"),
    ("msedge-beta", "Microsoft Edge Beta"),
    ("msedge-dev", "Microsoft Edge Dev"),
    ("msedge", "Microsoft Edge"),
    ("brave", "Brave Browser"),
    ("arc", "Arc"),
];

/// Path-basename fragments ordered most-specific first. Mirrors the TS
/// `titleHintFor` fallback branch: "chrome canary" must match before
/// "chrome"; "microsoft edge" matches before the Chrome branch; Brave
/// binaries don't contain "chrome" so they're an independent check.
const PATH_FRAGMENTS: &[(&str, &str)] = &[
    ("chrome canary", "Google Chrome Canary"),
    ("chrome beta", "Google Chrome Beta"),
    ("chrome dev", "Google Chrome Dev"),
    ("microsoft edge canary", "Microsoft Edge Canary"),
    ("microsoft edge beta", "Microsoft Edge Beta"),
    ("microsoft edge dev", "Microsoft Edge Dev"),
    ("microsoft edge", "Microsoft Edge"),
    ("brave", "Brave Browser"),
    ("arc", "Arc"),
    ("google chrome", "Google Chrome"),
    ("chromium", "Chromium"),
];

/// Safe lookup. Returns `Some(hint)` on a recognized preset/exec-path;
/// `None` otherwise. Never panics.
pub fn title_hint_for(preset: Option<&str>) -> Option<String> {
    let input = preset?.trim();
    if input.is_empty() {
        return None;
    }
    let lower = input.to_lowercase();

    // Direct preset-token lookup.
    for (tok, hint) in PRESET_TOKENS {
        if &lower == tok {
            return Some((*hint).to_string());
        }
    }

    // Exec-path basename heuristic.
    let basename = lower
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("");
    if basename.is_empty() {
        return None;
    }
    for (frag, hint) in PATH_FRAGMENTS {
        if basename.contains(frag) {
            return Some((*hint).to_string());
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
            let end = s
                .char_indices()
                .nth(40)
                .map(|(i, _)| i)
                .unwrap_or(s.len());
            format!("{}\u{2026}", &s[..end])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_token_lookup_exact() {
        assert_eq!(title_hint_for(Some("msedge")).as_deref(), Some("Microsoft Edge"));
        assert_eq!(title_hint_for(Some("chrome")).as_deref(), Some("Google Chrome"));
        assert_eq!(
            title_hint_for(Some("chrome-canary")).as_deref(),
            Some("Google Chrome Canary")
        );
        assert_eq!(title_hint_for(Some("brave")).as_deref(), Some("Brave Browser"));
        assert_eq!(title_hint_for(Some("arc")).as_deref(), Some("Arc"));
    }

    #[test]
    fn preset_token_lookup_case_insensitive() {
        assert_eq!(title_hint_for(Some("MSEDGE")).as_deref(), Some("Microsoft Edge"));
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
}
