//! Selector heuristic analyzer for `.story` DSL selectors.
//!
//! Flags brittle patterns (single `.class`/`#id`, deep `nth-child`,
//! absolute XPath, dynamically-hashed classes, brittle attribute
//! selectors) and missing fallback chains. Surfaces as LSP WARNING
//! diagnostics with source `selector-lint` (D-17, AI-SPEC E11).
//!
//! Uses the `regex` crate which provides linear-time guarantees
//! (no backtracking), mitigating T-03-15-01 ReDoS risk.

use regex::Regex;
use std::sync::LazyLock;

/// Categories of selector issues detected by the heuristic analyzer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SelectorIssue {
    /// Single `.class` or `#id` token with no combinators or attributes.
    TooGeneric,
    /// Selector is generic and has no fallback chain (`alt_selectors`).
    MissingFallback,
    /// `:nth-child(...)` appears 3+ times — fragile positional dependency.
    DeepNthChild,
    /// Starts with `/html/` or `/body/` — absolute XPath breaks on any DOM change.
    AbsoluteXPath,
    /// Contains hashed token pattern typical of CSS Modules / styled-components.
    OverlyDynamicClass,
    /// `[style=...]` or `[class=...]` with long value, or `[data-*]` with hex hash value.
    BrittleAttribute,
}

/// A warning produced by the selector heuristic analyzer.
#[derive(Debug, Clone)]
pub struct SelectorWarning {
    pub issue: SelectorIssue,
    pub message: String,
    pub suggestion: Option<String>,
}

// Precompiled regexes (linear-time, no backtracking — T-03-15-01)
static RE_TOO_GENERIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[.#][A-Za-z][A-Za-z0-9_\-]*$").unwrap());

static RE_NTH_CHILD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":nth-child\([^)]*\)").unwrap());

static RE_DYNAMIC_CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"_[a-f0-9]{6,}_|__[a-zA-Z0-9]{5,}__").unwrap());

static RE_BRITTLE_STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[style="[^"]*"\]"#).unwrap());

static RE_BRITTLE_CLASS_LONG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[class="[^"]{20,}"\]"#).unwrap());

static RE_DATA_ATTR_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[data-[a-z\-]+=['"]\s*[a-f0-9]{8,}\s*['"]\]"#).unwrap());

/// Analyze a CSS/XPath selector string and return a list of warnings.
///
/// `has_fallback` indicates whether the DSL step has `alt_selectors`.
/// When `true`, `MissingFallback` is suppressed even for generic selectors.
pub fn analyze_selector(selector: &str, has_fallback: bool) -> Vec<SelectorWarning> {
    let mut warnings = Vec::new();
    let trimmed = selector.trim();

    // Rule 1: Too generic — single .class or #id token
    let too_generic = is_too_generic(trimmed);
    if too_generic {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::TooGeneric,
            message: "Selector is too generic (single class or ID) — consider adding \
                      attribute predicates or combinators for resilience."
                .to_string(),
            suggestion: Some(
                "Add a data-testid, aria-label, or structural combinator.".to_string(),
            ),
        });
    }

    // Rule 2: Missing fallback — too generic and no alt_selectors
    if too_generic && !has_fallback {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::MissingFallback,
            message: "Generic selector has no fallback chain — add alt_selectors \
                      for retry resilience."
                .to_string(),
            suggestion: Some(
                "Provide alt_selectors with a data-testid or aria-label fallback.".to_string(),
            ),
        });
    }

    // Rule 3: Deep nth-child — 3+ occurrences
    if is_deep_nth_child(trimmed) {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::DeepNthChild,
            message: "Selector uses 3+ :nth-child() levels — highly fragile to DOM changes."
                .to_string(),
            suggestion: Some(
                "Replace positional selectors with data-testid or semantic attributes."
                    .to_string(),
            ),
        });
    }

    // Rule 4: Absolute XPath
    if is_absolute_xpath(trimmed) {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::AbsoluteXPath,
            message: "Absolute XPath breaks on any DOM restructuring — use relative \
                      selectors or data-testid."
                .to_string(),
            suggestion: Some(
                "Use a CSS selector with data-testid or a relative XPath.".to_string(),
            ),
        });
    }

    // Rule 5: Overly dynamic class (CSS Modules / styled-components hash)
    if is_overly_dynamic_class(trimmed) {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::OverlyDynamicClass,
            message: "Selector contains a hashed class token (CSS Modules / styled-components) \
                      — will break across builds."
                .to_string(),
            suggestion: Some(
                "Use a data-testid or aria-label instead of build-generated class names."
                    .to_string(),
            ),
        });
    }

    // Rule 6: Brittle attribute
    if is_brittle_attr(trimmed) {
        warnings.push(SelectorWarning {
            issue: SelectorIssue::BrittleAttribute,
            message: "Attribute selector uses a brittle value (inline style, long class \
                      string, or hex hash) — likely to change."
                .to_string(),
            suggestion: Some(
                "Prefer data-testid or semantic attributes over style/class/hex values."
                    .to_string(),
            ),
        });
    }

    warnings
}

fn is_too_generic(s: &str) -> bool {
    RE_TOO_GENERIC.is_match(s)
}

fn is_deep_nth_child(s: &str) -> bool {
    RE_NTH_CHILD.find_iter(s).count() >= 3
}

fn is_absolute_xpath(s: &str) -> bool {
    let s = s.strip_prefix("xpath:").unwrap_or(s).trim();
    s.starts_with("/html/") || s.starts_with("/body/")
}

fn is_overly_dynamic_class(s: &str) -> bool {
    RE_DYNAMIC_CLASS.is_match(s)
}

fn is_brittle_attr(s: &str) -> bool {
    if RE_BRITTLE_STYLE.is_match(s) || RE_BRITTLE_CLASS_LONG.is_match(s) {
        return true;
    }
    // Check for data-attr with hex hash, but exclude data-testid (stable anchor)
    if RE_DATA_ATTR_HEX.is_match(s) && !s.contains("data-testid") {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn issues(selector: &str, has_fallback: bool) -> HashSet<SelectorIssue> {
        analyze_selector(selector, has_fallback)
            .into_iter()
            .map(|w| w.issue)
            .collect()
    }

    #[test]
    fn test1_btn_too_generic_and_missing_fallback() {
        let result = issues(".btn", false);
        assert!(result.contains(&SelectorIssue::TooGeneric));
        assert!(result.contains(&SelectorIssue::MissingFallback));
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test2_data_testid_returns_empty() {
        let result = issues("button[data-testid='signup']", false);
        assert!(result.is_empty(), "data-testid selector should pass: {:?}", result);
    }

    #[test]
    fn test3_absolute_xpath() {
        let result = issues("/html/body/div[1]/div[2]/span", false);
        assert!(result.contains(&SelectorIssue::AbsoluteXPath));
    }

    #[test]
    fn test4_deep_nth_child() {
        let result = issues("div:nth-child(3):nth-child(2):nth-child(1)", false);
        assert!(result.contains(&SelectorIssue::DeepNthChild));
    }

    #[test]
    fn test5_overly_dynamic_class() {
        let result = issues("._a3f9b2_container", false);
        assert!(result.contains(&SelectorIssue::OverlyDynamicClass));
    }

    #[test]
    fn test6_data_testid_stable() {
        let result = issues("[data-testid='foo']", false);
        assert!(result.is_empty(), "data-testid is stable: {:?}", result);
    }

    #[test]
    fn test_has_fallback_suppresses_missing_fallback() {
        let result = issues(".btn", true);
        assert!(result.contains(&SelectorIssue::TooGeneric));
        assert!(!result.contains(&SelectorIssue::MissingFallback));
    }

    #[test]
    fn test_xpath_prefix() {
        let result = issues("xpath:/html/body/div", false);
        assert!(result.contains(&SelectorIssue::AbsoluteXPath));
    }

    #[test]
    fn test_brittle_style_attr() {
        let result = issues(r#"div[style="color: red; font-size: 14px"]"#, false);
        assert!(result.contains(&SelectorIssue::BrittleAttribute));
    }

    #[test]
    fn test_brittle_class_long() {
        let result = issues(r#"div[class="very-long-class-name-that-is-really-specific"]"#, false);
        assert!(result.contains(&SelectorIssue::BrittleAttribute));
    }

    #[test]
    fn test_data_attr_hex_hash() {
        let result = issues("[data-id='a3f9b2c4e5d6']", false);
        assert!(result.contains(&SelectorIssue::BrittleAttribute));
    }

    /// T-03-15-01 mitigation: large input must complete quickly (regex crate linear-time).
    #[test]
    fn test_adversarial_10kb_selector_completes_fast() {
        let large = "a".repeat(10_000);
        let start = std::time::Instant::now();
        let _ = analyze_selector(&large, false);
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 50,
            "10KB selector took {}ms (threshold 50ms)",
            elapsed.as_millis()
        );
    }

    /// T-03-15-02 mitigation: no panics on malformed input.
    #[test]
    fn test_no_panic_on_malformed() {
        let _ = analyze_selector("", false);
        let _ = analyze_selector("   ", false);
        let _ = analyze_selector("\0\0\0", false);
        let _ = analyze_selector("{{{{", false);
        let _ = analyze_selector("[[[", false);
    }
}
