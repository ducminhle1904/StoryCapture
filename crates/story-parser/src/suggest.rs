//! Levenshtein-based "did you mean" lookup.

use strsim::levenshtein;

pub const KNOWN_VERBS: &[&str] = &[
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

pub const KNOWN_META_KEYS: &[&str] = &["app", "viewport", "theme", "speed"];

/// Role keywords — MUST stay in lockstep with
/// `ast::AriaRole::from_keyword`. Both `image` and `img` are listed
/// because both are valid DSL spellings.
pub const KNOWN_ROLES: &[&str] = &[
    "button",
    "link",
    "heading",
    "image",
    "img",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menu",
    "option",
    "combobox",
    "listbox",
    "dialog",
    "alert",
    "tooltip",
    "switch",
    "slider",
    "row",
    "cell",
    "navigation",
    "main",
];

/// Returns the best candidate within Levenshtein distance ≤ 2,
/// or `None` if nothing is close enough.
pub fn did_you_mean(input: &str, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .map(|c| (*c, levenshtein(input, c)))
        .filter(|(_, d)| *d <= 2 && *d > 0)
        .min_by_key(|(_, d)| *d)
        .map(|(c, _)| c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_verb_typo() {
        assert_eq!(did_you_mean("clik", KNOWN_VERBS), Some("click".into()));
        assert_eq!(
            did_you_mean("navigte", KNOWN_VERBS),
            Some("navigate".into())
        );
        assert_eq!(did_you_mean("scrol", KNOWN_VERBS), Some("scroll".into()));
    }

    #[test]
    fn rejects_far_input() {
        assert_eq!(did_you_mean("xyzzyfoobar", KNOWN_VERBS), None);
    }

    #[test]
    fn finds_meta_key_typo() {
        assert_eq!(did_you_mean("spped", KNOWN_META_KEYS), Some("speed".into()));
        assert_eq!(
            did_you_mean("viewprt", KNOWN_META_KEYS),
            Some("viewport".into())
        );
    }

    #[test]
    fn finds_role_typo() {
        assert_eq!(did_you_mean("buton", KNOWN_ROLES), Some("button".into()));
        assert_eq!(did_you_mean("lnk", KNOWN_ROLES), Some("link".into()));
        assert_eq!(did_you_mean("imag", KNOWN_ROLES), Some("image".into()));
    }
}
