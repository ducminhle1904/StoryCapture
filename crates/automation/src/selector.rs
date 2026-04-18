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

fn explicit_strategy(target: &SelectorOrText) -> Option<(SelectorStrategy, String)> {
    match target {
        SelectorOrText::Selector(s) => Some((SelectorStrategy::Css, s.clone())),
        SelectorOrText::TestId(s) => {
            Some((SelectorStrategy::TestId, format!("[data-testid=\"{s}\"]")))
        }
        SelectorOrText::Aria(s) => Some((SelectorStrategy::Aria, s.clone())),
        SelectorOrText::Text(_) => None,
        // Phase 7 Tier 1 — short-circuit explicit strategies. Stub: encode
        // value with a stable prefix so the sidecar's `locate()` can route
        // (Tier 1 sidecar branches consume `role=<role>:<name>` / `label=…`
        // / `text=…`). Strategy enum lacks Role/Label/TextExact variants
        // pre-Tier-1; map to Aria as the closest existing semantic until
        // events.rs gains the new variants in 07-02.
        SelectorOrText::Role { role, name } => Some((
            SelectorStrategy::Aria,
            format!("role={}:{}", role.as_kebab(), name),
        )),
        SelectorOrText::Label(s) => Some((SelectorStrategy::Aria, format!("label={s}"))),
        SelectorOrText::TextExact(s) => Some((SelectorStrategy::Aria, format!("text={s}"))),
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
