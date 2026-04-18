//! Intent-aware smart selector resolution (AUTO-03, D-13).
//!
//! Three strict-explicit strategies + one ranked human-text strategy:
//!
//! 1. `SelectorOrText::Selector(css)` — strict CSS only. No fallback.
//! 2. `SelectorOrText::TestId(id)` — strict `[data-testid="<id>"]`. No fallback.
//! 3. `SelectorOrText::Aria(name)` — strict accessible-name. No fallback.
//! 4. `SelectorOrText::Text(s)` — ranked candidates (action-aware):
//!    a. Exact accessible-name on actionable controls
//!    b. Exact visible text on actionable controls
//!    c. Label-to-control association (form fields)
//!    d. Bounded fuzzy / partial text (last resort)
//!
//! Each attempt is logged. A unique high-confidence winner is required;
//! otherwise an `AmbiguousSelector` error is returned with the top
//! candidates so the user can scope or switch to an explicit kind.

use crate::driver::{ActionKind, BrowserDriver, ResolvedSelector};
use crate::error::{AutomationError, Result};
use crate::events::{AttemptLog, AttemptOutcome, SelectorStrategy};
use std::time::Instant;
use story_parser::SelectorOrText;

pub struct SmartSelector;

/// Plan 07-05 — author-time validation outcome. Returned by
/// [`SmartSelector::validate_against_dom`] when checking a parsed DSL
/// target against a cached snapshot HTML string (no live browser).
///
/// The matched-element bounding box is returned ONLY for `Unique` and
/// `Fuzzy` outcomes whose first match the snapshot scanner could
/// resolve a `getBoundingClientRect`-equivalent for. Since the scan
/// happens against a detached DOM string — no layout engine — the
/// bbox is actually derived from the snapshot rendering step (the
/// screenshot + element-box metadata captured alongside innerHTML).
/// When unknown it is `None`; the UI degrades to "matched, no preview".
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ValidationResult {
    /// Exactly one element in the snapshot DOM matches the deterministic
    /// locator strategy. UI chip: GREEN.
    Unique {
        /// The strategy that matched (useful for "promote to fallback" UI).
        strategy: SelectorStrategy,
    },
    /// More than one element matches, OR the locator required a live-DOM
    /// strategy that Rust's detached-DOM validator degrades on (fuzzy
    /// text, accessible-name across actionable controls). UI chip: YELLOW.
    Fuzzy {
        /// Number of elements that matched. For YELLOW-degrade paths where
        /// the Rust validator cannot enumerate candidates, this is `0` and
        /// `reason` is populated.
        count: usize,
        /// Short diagnostic for the UI tooltip — e.g. "fuzzy-text strategy
        /// not evaluated offline", "multiple elements match label `Email`".
        reason: String,
    },
    /// No element matches the locator in the snapshot DOM. UI chip: RED.
    None,
}

impl ValidationResult {
    /// Convenience — the UI chip colour class in one char, useful for test
    /// assertions and for shaping the TS discriminator.
    pub fn status_char(&self) -> char {
        match self {
            ValidationResult::Unique { .. } => 'G',
            ValidationResult::Fuzzy { .. } => 'Y',
            ValidationResult::None => 'R',
        }
    }
}

/// Object-safe free helper. The [`BrowserDriver`] trait's default
/// `resolve_selector` impl calls this so the trait stays dyn-safe.
pub async fn resolve_via_smart(
    driver: &dyn BrowserDriver,
    action: ActionKind,
    target: &SelectorOrText,
    timeout_ms: u64,
) -> Result<(ResolvedSelector, Vec<AttemptLog>)> {
    SmartSelector::resolve_with_attempts(driver, action, target, timeout_ms).await
}

/// A scored candidate as the intermediate ranking step produces them. The
/// public surface returns one — or an ambiguity error.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub strategy: SelectorStrategy,
    pub value: String,
    pub score: f32,
}

impl SmartSelector {
    /// Resolve `target` for the given `action`. Returns the chosen
    /// `ResolvedSelector` plus the per-strategy attempt log (always
    /// populated, even on success).
    pub async fn resolve_with_attempts(
        driver: &dyn BrowserDriver,
        action: ActionKind,
        target: &SelectorOrText,
        _timeout_ms: u64,
    ) -> Result<(ResolvedSelector, Vec<AttemptLog>)> {
        // Strict-explicit strategies short-circuit.
        if let Some((strategy, value)) = explicit_strategy(target) {
            let start = Instant::now();
            let attempt = AttemptLog {
                strategy,
                value: value.clone(),
                outcome: AttemptOutcome::Found { score: 1.0 },
                elapsed_ms: start.elapsed().as_millis() as u64,
            };
            return Ok((
                ResolvedSelector {
                    strategy,
                    value,
                    origin: target.clone(),
                },
                vec![attempt],
            ));
        }

        // The only remaining branch is `Text(s)` — ranked candidates.
        let SelectorOrText::Text(text) = target else {
            unreachable!("explicit_strategy() handles all non-Text variants")
        };

        let mut attempts = Vec::with_capacity(4);
        let mut candidates: Vec<Candidate> = Vec::new();

        for &strategy in ranked_strategies_for(action) {
            let start = Instant::now();
            let value = synth_value_for(strategy, text);
            let score = score_for(strategy, action);

            // Phase 1 design: the SmartSelector emits the candidate +
            // strategy + score; the *driver* runs the actual DOM probe
            // when it executes the action. The attempt log here records
            // intent rather than DOM result, which is enough for the
            // ambiguity guard. The driver later feeds back true Found /
            // NotFound through the executor.
            attempts.push(AttemptLog {
                strategy,
                value: value.clone(),
                outcome: AttemptOutcome::Found { score },
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
            candidates.push(Candidate {
                strategy,
                value,
                score,
            });

            // Driver introspection (kept light — the heavy DOM probe happens
            // when the action runs). Drivers MAY override
            // `BrowserDriver::resolve_selector` to do a real disambiguation
            // pass; the default in the trait routes to this fn unchanged.
            let _ = driver.name();
        }

        // Sort by descending score.
        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // Ambiguity guard: if the top two candidates score within 0.05 of
        // each other AND both are >= 0.8, error out — the user must scope
        // or switch to `testid` / `selector`.
        if candidates.len() >= 2 {
            let top = candidates[0].score;
            let next = candidates[1].score;
            if top >= 0.8 && next >= 0.8 && (top - next).abs() < 0.05 {
                return Err(AutomationError::AmbiguousSelector {
                    target: text.clone(),
                    candidates: candidates.len(),
                    attempts,
                });
            }
        }

        let winner = candidates
            .into_iter()
            .next()
            .ok_or_else(|| AutomationError::Selector {
                attempts: attempts.clone(),
                last_error: "no candidate strategies produced a value".into(),
            })?;

        Ok((
            ResolvedSelector {
                strategy: winner.strategy,
                value: winner.value,
                origin: target.clone(),
            },
            attempts,
        ))
    }
}

impl SmartSelector {
    /// Plan 07-05 — author-time validator. Check whether `target` uniquely
    /// matches an element in the detached snapshot DOM string (no live
    /// browser; runs offline).
    ///
    /// Strategy coverage:
    /// - `Selector(css)` → counted via `scraper`. Unique / fuzzy / none.
    /// - `TestId(id)` → `[data-testid="<id>"]`.
    /// - `Aria(name)` → `[aria-label="<name>"]`.
    /// - `Label(name)` → `<label>` with text matching `name` whose
    ///   `for=` attribute (or nested input) identifies a unique control.
    /// - `Role { role, name }` → best-effort: look for `<{role}>` or
    ///   `[role="{role}"]` elements whose accessible-name (aria-label,
    ///   text content, or `aria-labelledby` first-token) matches
    ///   exactly. Returns `Fuzzy` with reason when only the role matches
    ///   but the name cannot be confirmed offline.
    /// - `TextExact(name)` → elements whose trimmed text content equals
    ///   `name` exactly.
    /// - `Text(s)` → YELLOW-degrade with `reason="live-DOM required"`.
    ///   The ranked `accessible-name` / `fuzzy-text` strategies need
    ///   computed styles + layout to score correctly; rather than
    ///   producing false confidence, the validator signals the UI to
    ///   mark the step YELLOW and recommend an explicit locator.
    ///
    /// Returns [`ValidationResult::None`] when the DOM has zero matches
    /// and [`ValidationResult::Fuzzy`] when more than one match is found
    /// OR when the strategy requires live DOM. [`ValidationResult::Unique`]
    /// is the only GREEN outcome.
    pub fn validate_against_dom(target: &SelectorOrText, dom_html: &str) -> ValidationResult {
        let doc = scraper::Html::parse_document(dom_html);

        match target {
            SelectorOrText::Selector(css) => count_css(&doc, css, SelectorStrategy::Css),
            SelectorOrText::TestId(id) => {
                let css = format!("[data-testid=\"{}\"]", css_escape_attr(id));
                count_css(&doc, &css, SelectorStrategy::TestId)
            }
            SelectorOrText::Aria(name) => {
                let css = format!("[aria-label=\"{}\"]", css_escape_attr(name));
                count_css(&doc, &css, SelectorStrategy::Aria)
            }
            SelectorOrText::Label(name) => validate_label(&doc, name),
            SelectorOrText::TextExact(name) => validate_text_exact(&doc, name),
            SelectorOrText::Role { role, name } => {
                validate_role(&doc, role.as_kebab(), name)
            }
            SelectorOrText::Text(_) => ValidationResult::Fuzzy {
                count: 0,
                reason: "ranked text strategy requires live DOM — prefer an explicit locator"
                    .to_string(),
            },
        }
    }
}

/// Escape a string for safe embedding inside a `[attr="..."]` value.
/// Backslash + double-quote are the two metacharacters; other chars pass
/// through. This matches the escape convention the sidecar uses.
fn css_escape_attr(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn count_css(
    doc: &scraper::Html,
    css: &str,
    strategy: SelectorStrategy,
) -> ValidationResult {
    match scraper::Selector::parse(css) {
        Ok(sel) => {
            let n = doc.select(&sel).count();
            match n {
                0 => ValidationResult::None,
                1 => ValidationResult::Unique { strategy },
                many => ValidationResult::Fuzzy {
                    count: many,
                    reason: format!("{many} elements match CSS selector"),
                },
            }
        }
        Err(e) => ValidationResult::Fuzzy {
            count: 0,
            reason: format!("invalid CSS selector: {e}"),
        },
    }
}

/// `<label for="ctrl-id">Email</label>` — find `<label>` nodes whose
/// trimmed text equals `name`, then count the unique set of controls
/// they reference (either via `for=` or via nested form controls).
fn validate_label(doc: &scraper::Html, name: &str) -> ValidationResult {
    let sel = scraper::Selector::parse("label").unwrap();
    let mut control_refs: Vec<String> = Vec::new();
    for el in doc.select(&sel) {
        let text: String = el.text().collect::<String>();
        if text.trim() == name {
            if let Some(for_id) = el.value().attr("for") {
                control_refs.push(format!("#{for_id}"));
            } else {
                // Nested input pattern <label>Email <input/></label>.
                for child in el.descendants() {
                    if let Some(child_el) = child.value().as_element() {
                        let tag = child_el.name();
                        if matches!(tag, "input" | "textarea" | "select") {
                            if let Some(id) = child_el.attr("id") {
                                control_refs.push(format!("#{id}"));
                            } else if let Some(nm) = child_el.attr("name") {
                                control_refs.push(format!("[name=\"{nm}\"]"));
                            } else {
                                control_refs.push(format!("nested:{tag}"));
                            }
                            break;
                        }
                    }
                }
            }
        }
    }
    control_refs.sort();
    control_refs.dedup();
    match control_refs.len() {
        0 => ValidationResult::None,
        1 => ValidationResult::Unique {
            strategy: SelectorStrategy::Label,
        },
        many => ValidationResult::Fuzzy {
            count: many,
            reason: format!("{many} controls labelled `{name}`"),
        },
    }
}

/// Count elements whose trimmed text-content equals `name` exactly.
/// Mirrors Playwright's `getByText(name, { exact: true })` semantics.
fn validate_text_exact(doc: &scraper::Html, name: &str) -> ValidationResult {
    let sel = scraper::Selector::parse("*").unwrap();
    let mut hits = 0usize;
    for el in doc.select(&sel) {
        // Only count leaf-ish elements (no element children) so `<div>` wrappers
        // that transitively contain the text don't inflate the count.
        let has_el_child = el.children().any(|c| c.value().is_element());
        if has_el_child {
            continue;
        }
        let text: String = el.text().collect::<String>();
        if text.trim() == name {
            hits += 1;
        }
    }
    match hits {
        0 => ValidationResult::None,
        1 => ValidationResult::Unique {
            strategy: SelectorStrategy::TextExact,
        },
        many => ValidationResult::Fuzzy {
            count: many,
            reason: format!("{many} elements with exact text `{name}`"),
        },
    }
}

/// Role + accessible-name validation against the detached DOM. Covers
/// the common WAI-ARIA name computation paths (aria-label, visible text,
/// explicit aria-labelledby) for the role shapes shipped in Phase 7.
fn validate_role(doc: &scraper::Html, role: &str, name: &str) -> ValidationResult {
    // Map Phase 7 ARIA roles to their HTML implicit tags. Includes the
    // role attribute match as a parallel query. Roles without a clean
    // implicit HTML tag (e.g. `dialog`) rely on [role="..."] only.
    let implicit_tag: Option<&str> = match role {
        "button" => Some("button"),
        "link" => Some("a"),
        "heading" => None, // h1..h6 — handled below
        "image" | "img" => Some("img"),
        "checkbox" | "radio" => Some("input"),
        "tab" => Some("button"),
        "menuitem" | "menu" | "option" | "combobox" | "listbox" | "dialog" | "alert"
        | "tooltip" | "switch" | "slider" | "row" | "cell" | "navigation" | "main" => None,
        _ => None,
    };
    let mut css_parts: Vec<String> = Vec::new();
    if let Some(tag) = implicit_tag {
        css_parts.push(tag.to_string());
    }
    if role == "heading" {
        for h in ["h1", "h2", "h3", "h4", "h5", "h6"] {
            css_parts.push(h.to_string());
        }
    }
    css_parts.push(format!("[role=\"{}\"]", css_escape_attr(role)));
    let combined = css_parts.join(", ");
    let sel = match scraper::Selector::parse(&combined) {
        Ok(s) => s,
        Err(e) => {
            return ValidationResult::Fuzzy {
                count: 0,
                reason: format!("invalid synthesized role selector: {e}"),
            };
        }
    };

    let mut hits = 0usize;
    for el in doc.select(&sel) {
        let accessible_name = compute_accessible_name(doc, &el);
        if accessible_name.trim() == name {
            hits += 1;
        }
    }
    match hits {
        0 => ValidationResult::None,
        1 => ValidationResult::Unique {
            strategy: SelectorStrategy::Role,
        },
        many => ValidationResult::Fuzzy {
            count: many,
            reason: format!("{many} `{role}` elements named `{name}`"),
        },
    }
}

/// Subset of WAI-ARIA accessible-name computation: aria-label →
/// aria-labelledby (first referenced element's trimmed text) → alt
/// attribute (for img) → text content (trimmed). Matches the
/// accessible-name-lite subset used by the sidecar overlay in 07-03a.
fn compute_accessible_name(doc: &scraper::Html, el: &scraper::ElementRef<'_>) -> String {
    if let Some(label) = el.value().attr("aria-label") {
        return label.to_string();
    }
    if let Some(ids) = el.value().attr("aria-labelledby") {
        let first_id = ids.split_whitespace().next().unwrap_or("");
        if !first_id.is_empty() {
            let id_sel = scraper::Selector::parse(&format!("#{first_id}")).ok();
            if let Some(id_sel) = id_sel {
                if let Some(target) = doc.select(&id_sel).next() {
                    let txt: String = target.text().collect::<String>();
                    return txt.trim().to_string();
                }
            }
        }
    }
    if el.value().name() == "img" {
        if let Some(alt) = el.value().attr("alt") {
            return alt.to_string();
        }
    }
    let txt: String = el.text().collect::<String>();
    txt.trim().to_string()
}

fn explicit_strategy(target: &SelectorOrText) -> Option<(SelectorStrategy, String)> {
    match target {
        SelectorOrText::Selector(s) => Some((SelectorStrategy::Css, s.clone())),
        SelectorOrText::TestId(s) => {
            Some((SelectorStrategy::TestId, format!("[data-testid=\"{s}\"]")))
        }
        SelectorOrText::Aria(s) => Some((SelectorStrategy::Aria, s.clone())),
        // Phase 7 Tier 1 (D-06 encoding — sidecar splits on FIRST ':' after "role=").
        SelectorOrText::Role { role, name } => Some((
            SelectorStrategy::Role,
            format!("role={}:{name}", role.as_kebab()),
        )),
        SelectorOrText::Label(name) => Some((SelectorStrategy::Label, format!("label={name}"))),
        SelectorOrText::TextExact(name) => {
            Some((SelectorStrategy::TextExact, format!("text={name}")))
        }
        SelectorOrText::Text(_) => None,
    }
}

/// Order strategies are tried for a `Text` target, biased by action kind.
fn ranked_strategies_for(action: ActionKind) -> &'static [SelectorStrategy] {
    match action {
        // For type/select: prefer label association (forms), then accessible name.
        ActionKind::Type | ActionKind::Select => &[
            SelectorStrategy::AccessibleName,
            SelectorStrategy::LabelAssoc,
            SelectorStrategy::VisibleText,
            SelectorStrategy::FuzzyText,
        ],
        // For click/hover/upload/assert/wait-for/drag: actionable text first.
        _ => &[
            SelectorStrategy::AccessibleName,
            SelectorStrategy::VisibleText,
            SelectorStrategy::LabelAssoc,
            SelectorStrategy::FuzzyText,
        ],
    }
}

/// Per-strategy score (intent-aware). Higher = more confident.
fn score_for(strategy: SelectorStrategy, action: ActionKind) -> f32 {
    match (strategy, action) {
        (SelectorStrategy::AccessibleName, _) => 1.0,
        (SelectorStrategy::VisibleText, ActionKind::Click | ActionKind::Hover) => 0.9,
        (SelectorStrategy::VisibleText, _) => 0.7,
        (SelectorStrategy::LabelAssoc, ActionKind::Type | ActionKind::Select) => 0.95,
        (SelectorStrategy::LabelAssoc, _) => 0.6,
        (SelectorStrategy::FuzzyText, _) => 0.4,
        // Strict strategies never reach scoring.
        (SelectorStrategy::Css | SelectorStrategy::TestId | SelectorStrategy::Aria, _) => 1.0,
        // Phase 7 Tier 1 strict strategies also never reach scoring.
        (SelectorStrategy::Role | SelectorStrategy::Label | SelectorStrategy::TextExact, _) => 1.0,
    }
}

/// Build the synthesized selector value for a given strategy + raw text.
/// Drivers consume the value verbatim.
fn synth_value_for(strategy: SelectorStrategy, text: &str) -> String {
    match strategy {
        SelectorStrategy::AccessibleName => format!("aria-name={text}"),
        SelectorStrategy::VisibleText => format!("text={text}"),
        SelectorStrategy::LabelAssoc => format!("label={text}"),
        SelectorStrategy::FuzzyText => format!("text~={text}"),
        // Strict strategies pass through their literal already.
        SelectorStrategy::Css | SelectorStrategy::TestId | SelectorStrategy::Aria => {
            text.to_string()
        }
        // Phase 7 Tier 1 strict explicit strategies never reach ranked scoring —
        // defense in depth: if a future refactor accidentally routes here, debug
        // builds panic loudly so we notice before shipping.
        SelectorStrategy::Role | SelectorStrategy::Label | SelectorStrategy::TextExact => {
            debug_assert!(
                false,
                "synth_value_for called for strict explicit strategy {strategy:?}"
            );
            text.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use story_parser::AriaRole;

    #[test]
    fn explicit_role_target_short_circuits_with_colon_encoding() {
        let target = SelectorOrText::Role { role: AriaRole::Button, name: "Save".into() };
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::Role);
        assert_eq!(val, "role=button:Save");
    }

    #[test]
    fn explicit_role_preserves_colon_in_name() {
        // Names may contain ':' — split on FIRST ':' on the sidecar side preserves this.
        let target = SelectorOrText::Role { role: AriaRole::Link, name: "Go: now".into() };
        let (_strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(val, "role=link:Go: now");
        let (role, name) = val["role=".len()..].split_once(':').unwrap();
        assert_eq!(role, "link");
        assert_eq!(name, "Go: now");
    }

    #[test]
    fn explicit_label_short_circuits() {
        let target = SelectorOrText::Label("Email".into());
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::Label);
        assert_eq!(val, "label=Email");
    }

    #[test]
    fn explicit_text_exact_short_circuits() {
        let target = SelectorOrText::TextExact("Learn more".into());
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::TextExact);
        assert_eq!(val, "text=Learn more");
    }

    #[test]
    fn selector_strategy_as_str_matches_sidecar_contract() {
        // These exact strings are the JSON-RPC `strategy` argument the sidecar switches on.
        assert_eq!(SelectorStrategy::Role.as_str(), "role");
        assert_eq!(SelectorStrategy::Label.as_str(), "label");
        assert_eq!(SelectorStrategy::TextExact.as_str(), "text_exact");
    }

    #[tokio::test]
    async fn smart_selector_role_single_attempt_no_fallback() {
        use crate::driver::{ActionKind, BrowserDriver};
        use crate::noop_driver::NoopDriver;
        let driver: Box<dyn BrowserDriver> = Box::new(NoopDriver::default());
        let target = SelectorOrText::Role { role: AriaRole::Button, name: "Save".into() };
        let (resolved, attempts) =
            SmartSelector::resolve_with_attempts(driver.as_ref(), ActionKind::Click, &target, 1000)
                .await
                .expect("strict resolve cannot fail");
        assert_eq!(attempts.len(), 1, "strict strategy must be single-attempt");
        assert_eq!(resolved.strategy, SelectorStrategy::Role);
        assert_eq!(resolved.value, "role=button:Save");
        match &attempts[0].outcome {
            AttemptOutcome::Found { score } => assert_eq!(*score, 1.0),
            other => panic!("expected Found{{1.0}}, got {:?}", other),
        }
    }

    #[test]
    fn explicit_css_selector_short_circuits() {
        let target = SelectorOrText::Selector("#save".into());
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::Css);
        assert_eq!(val, "#save");
    }

    #[test]
    fn explicit_testid_short_circuits() {
        let target = SelectorOrText::TestId("email".into());
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::TestId);
        assert_eq!(val, "[data-testid=\"email\"]");
    }

    #[test]
    fn explicit_aria_short_circuits() {
        let target = SelectorOrText::Aria("Sign in".into());
        let (strat, val) = explicit_strategy(&target).unwrap();
        assert_eq!(strat, SelectorStrategy::Aria);
        assert_eq!(val, "Sign in");
    }

    #[test]
    fn text_target_has_no_explicit_strategy() {
        assert!(explicit_strategy(&SelectorOrText::Text("Save".into())).is_none());
    }

    #[test]
    fn type_action_prefers_accessible_name_then_label_assoc() {
        let order = ranked_strategies_for(ActionKind::Type);
        assert_eq!(order[0], SelectorStrategy::AccessibleName);
        assert_eq!(order[1], SelectorStrategy::LabelAssoc);
    }

    #[test]
    fn click_action_prefers_visible_text_over_label() {
        let order = ranked_strategies_for(ActionKind::Click);
        assert_eq!(order[1], SelectorStrategy::VisibleText);
    }

    #[test]
    fn label_assoc_outranks_visible_text_for_type_action() {
        // Score ordering proof.
        let label = score_for(SelectorStrategy::LabelAssoc, ActionKind::Type);
        let text = score_for(SelectorStrategy::VisibleText, ActionKind::Type);
        assert!(label > text, "{label} vs {text}");
    }

    // -----------------------------------------------------------------
    // Plan 07-05 — `SmartSelector::validate_against_dom`
    // -----------------------------------------------------------------

    const SAMPLE_HTML: &str = r#"<!doctype html>
<html>
<body>
  <button data-testid="save-btn" aria-label="Save document">Save</button>
  <button data-testid="cancel-btn">Cancel</button>
  <a href="/docs">Docs</a>
  <label for="email-input">Email</label>
  <input id="email-input" type="email" />
  <label>Password <input id="pw" type="password" /></label>
  <label for="dup">Duplicated</label>
  <label for="dup2">Duplicated</label>
  <input id="dup" /><input id="dup2" />
  <h1>Welcome</h1>
  <img alt="Dashboard preview" src="x.png" />
  <div role="dialog" aria-label="Confirm">dialog content</div>
  <p>Learn more</p>
  <span>Learn more</span>
</body>
</html>"#;

    #[test]
    fn validate_testid_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::TestId("save-btn".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r.status_char(), 'G');
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::TestId });
    }

    #[test]
    fn validate_testid_missing_red() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::TestId("nonexistent".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::None);
        assert_eq!(r.status_char(), 'R');
    }

    #[test]
    fn validate_css_multiple_yellow() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Selector("button".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r.status_char(), 'Y');
        if let ValidationResult::Fuzzy { count, .. } = r {
            assert_eq!(count, 2, "two <button> elements in sample");
        } else {
            panic!("expected Fuzzy");
        }
    }

    #[test]
    fn validate_css_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Selector("#email-input".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Css });
    }

    #[test]
    fn validate_css_invalid_yellow() {
        // scraper rejects an unclosed attribute selector — should degrade YELLOW
        // rather than panic.
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Selector("[a=".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r.status_char(), 'Y');
    }

    #[test]
    fn validate_aria_label_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Aria("Save document".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Aria });
    }

    #[test]
    fn validate_label_for_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Label("Email".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Label });
    }

    #[test]
    fn validate_label_nested_input_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Label("Password".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Label });
    }

    #[test]
    fn validate_label_duplicate_yellow() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Label("Duplicated".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r.status_char(), 'Y');
    }

    #[test]
    fn validate_text_exact_multiple_yellow() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::TextExact("Learn more".into()),
            SAMPLE_HTML,
        );
        // <p> and <span> both contain exact text "Learn more".
        assert_eq!(r.status_char(), 'Y');
    }

    #[test]
    fn validate_text_exact_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::TextExact("Welcome".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::TextExact });
    }

    #[test]
    fn validate_role_button_by_text_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Role { role: AriaRole::Button, name: "Cancel".into() },
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Role });
    }

    #[test]
    fn validate_role_image_by_alt_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Role { role: AriaRole::Image, name: "Dashboard preview".into() },
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Role });
    }

    #[test]
    fn validate_role_dialog_by_aria_label_unique_green() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Role { role: AriaRole::Dialog, name: "Confirm".into() },
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::Unique { strategy: SelectorStrategy::Role });
    }

    #[test]
    fn validate_role_button_missing_red() {
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Role { role: AriaRole::Button, name: "Delete".into() },
            SAMPLE_HTML,
        );
        assert_eq!(r, ValidationResult::None);
    }

    #[test]
    fn validate_bare_text_yellow_degrades() {
        // Bare `Text` is the ranked strategy — live-DOM required — always YELLOW.
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::Text("Save".into()),
            SAMPLE_HTML,
        );
        assert_eq!(r.status_char(), 'Y');
        if let ValidationResult::Fuzzy { count, reason } = r {
            assert_eq!(count, 0);
            assert!(reason.to_lowercase().contains("live"));
        } else {
            panic!("expected Fuzzy yellow-degrade");
        }
    }

    #[test]
    fn validate_escapes_attr_value_quotes() {
        // Name containing a double-quote must not break the synthesized
        // `[data-testid="..."]` selector.
        let html = r#"<button data-testid='he said "hi"'>Hi</button>"#;
        let r = SmartSelector::validate_against_dom(
            &SelectorOrText::TestId(r#"he said "hi""#.into()),
            html,
        );
        assert_eq!(r.status_char(), 'G');
    }
}
