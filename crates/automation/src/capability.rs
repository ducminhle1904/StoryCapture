//! Verb → required-capability mapping.
//!
//! The executor calls [`required_for`] for every command and picks the
//! first driver whose [`CapabilitySet`] satisfies it (primary preferred,
//! fallback used when the primary lacks the capability).

use crate::driver::{BrowserDriver, Capability};
use story_parser::{Command, SelectorOrText};

/// Heuristics for "this target is in shadow DOM": the explicit `selector`
/// kind containing `::shadow` / `>>>` / `pierce/` / `cross-shadow` markers,
/// or the explicit `aria` kind with the `shadow:` prefix the executor docs
/// reserve for piercing access.
fn is_shadow_dom(target: &SelectorOrText) -> bool {
    match target {
        SelectorOrText::Selector(s) => {
            s.contains("::shadow")
                || s.contains(">>>")
                || s.starts_with("pierce/")
                || s.starts_with("cross-shadow:")
        }
        SelectorOrText::Aria(s) | SelectorOrText::TestId(s) | SelectorOrText::Text(s) => {
            s.starts_with("shadow:")
        }
        // accessibility-first kinds. The name/label/text string
        // may carry the conventional `shadow:` sentinel the DSL docs reserve.
        SelectorOrText::Role { name, .. }
        | SelectorOrText::Label(name)
        | SelectorOrText::TextExact(name) => name.starts_with("shadow:"),
    }
}

/// `wait-for` targeting a download object. The DSL doesn't have a dedicated
/// "wait-for-download" verb in v1, so we sniff the conventional sentinel
/// strings users embed: `download:`, `*.download`, `download://`.
fn is_download_target(target: &SelectorOrText) -> bool {
    let s = match target {
        SelectorOrText::Text(s)
        | SelectorOrText::Selector(s)
        | SelectorOrText::TestId(s)
        | SelectorOrText::Aria(s) => s,
        // the `name`/`value` string carries any sentinel.
        SelectorOrText::Role { name, .. }
        | SelectorOrText::Label(name)
        | SelectorOrText::TextExact(name) => name,
    };
    s.starts_with("download:") || s.starts_with("download://") || s.ends_with(".download")
}

/// OAuth-popup heuristic: `wait-for "oauth:..."` or `click "oauth:..."`.
/// Real popup detection is mid-flight; for now this lets the user opt the
/// verb into Playwright via a sentinel prefix.
fn is_oauth_target(target: &SelectorOrText) -> bool {
    let s = match target {
        SelectorOrText::Text(s)
        | SelectorOrText::Selector(s)
        | SelectorOrText::TestId(s)
        | SelectorOrText::Aria(s) => s,
        // the `name`/`value` string carries the sentinel.
        SelectorOrText::Role { name, .. }
        | SelectorOrText::Label(name)
        | SelectorOrText::TextExact(name) => name,
    };
    s.starts_with("oauth:")
        || s.contains("login.microsoftonline.com")
        || s.contains("accounts.google.com")
}

/// Map a [`Command`] to the [`Capability`] it requires from the driver.
///
/// The defaults are deliberately conservative: anything chromiumoxide
/// handles weakly is mapped to a non-`None` capability so the executor
/// routes to Playwright.
pub fn required_for(cmd: &Command) -> Capability {
    match cmd {
        // File upload — chromiumoxide's `Page::set_input_files` API is
        // present but flakier than Playwright's `setInputFiles`. Always
        // route to Playwright.
        Command::Upload { .. } => Capability::FileUpload,

        // Wait-for + download sentinel target.
        Command::WaitFor { target, .. } if is_download_target(target) => {
            Capability::WaitForDownload
        }

        // Click into shadow DOM — chromiumoxide doesn't pierce by default.
        Command::Click { target, .. } if is_shadow_dom(target) => Capability::ShadowDomPiercing,

        // OAuth popup sentinel on click or wait-for.
        Command::Click { target, .. } | Command::WaitFor { target, .. }
            if is_oauth_target(target) =>
        {
            Capability::OAuthPopup
        }

        // Everything else — chromiumoxide handles it.
        _ => Capability::None,
    }
}

/// Pick the right driver for the requested capability. Prefers `primary`
/// when it satisfies; falls back otherwise.
///
/// The function returns a `&dyn BrowserDriver` plus a tag (`"chromiumoxide"`
/// / `"playwright"`) that the executor includes in `StepStarted.driver_used`.
pub fn driver_for<'a>(
    primary: &'a dyn BrowserDriver,
    fallback: &'a dyn BrowserDriver,
    required: Capability,
) -> &'a dyn BrowserDriver {
    if primary.capabilities().satisfies(required) {
        primary
    } else if fallback.capabilities().satisfies(required) {
        fallback
    } else {
        // Neither driver claims it; pick fallback so the error originates
        // from the more capable driver (better diagnostics).
        fallback
    }
}
