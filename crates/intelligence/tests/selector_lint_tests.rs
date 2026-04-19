//! E11 confusion-matrix test for the selector heuristic analyzer.
//!
//! Loads `known_broken.yaml` and `known_good.yaml` fixture corpora,
//! runs `analyze_selector` on each entry, and asserts precision >= 0.80
//! and recall >= 0.70 per AI-SPEC E11.

use intelligence::lsp::selector_lint::{analyze_selector, SelectorIssue};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Deserialize)]
struct FixtureEntry {
    selector: String,
    has_fallback: bool,
    expected: Vec<String>,
}

fn parse_issue(s: &str) -> SelectorIssue {
    match s {
        "TooGeneric" => SelectorIssue::TooGeneric,
        "MissingFallback" => SelectorIssue::MissingFallback,
        "DeepNthChild" => SelectorIssue::DeepNthChild,
        "AbsoluteXPath" => SelectorIssue::AbsoluteXPath,
        "OverlyDynamicClass" => SelectorIssue::OverlyDynamicClass,
        "BrittleAttribute" => SelectorIssue::BrittleAttribute,
        other => panic!("unknown SelectorIssue variant in fixture: {other}"),
    }
}

fn load_yaml(filename: &str) -> Vec<FixtureEntry> {
    let path = format!(
        "{}/tests/fixtures/selectors/{filename}",
        env!("CARGO_MANIFEST_DIR")
    );
    let content =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    serde_yaml::from_str(&content).unwrap_or_else(|e| panic!("failed to parse {path}: {e}"))
}

#[test]
fn e11_confusion_matrix_meets_thresholds() {
    let broken = load_yaml("known_broken.yaml");
    let good = load_yaml("known_good.yaml");

    let total_entries = broken.len() + good.len();
    assert!(
        total_entries >= 30,
        "fixture corpus must have >= 30 entries, got {total_entries}"
    );

    let mut tp = 0u32;
    let mut fp = 0u32;
    let mut fnn = 0u32;

    for entry in broken.iter().chain(good.iter()) {
        let found: HashSet<SelectorIssue> = analyze_selector(&entry.selector, entry.has_fallback)
            .into_iter()
            .map(|w| w.issue)
            .collect();
        let expected: HashSet<SelectorIssue> =
            entry.expected.iter().map(|s| parse_issue(s)).collect();

        let entry_tp = found.intersection(&expected).count() as u32;
        let entry_fp = found.difference(&expected).count() as u32;
        let entry_fn = expected.difference(&found).count() as u32;

        if entry_fp > 0 || entry_fn > 0 {
            eprintln!(
                "MISMATCH: selector={:?} has_fallback={} expected={:?} found={:?} tp={} fp={} fn={}",
                entry.selector, entry.has_fallback, expected, found,
                entry_tp, entry_fp, entry_fn
            );
        }

        tp += entry_tp;
        fp += entry_fp;
        fnn += entry_fn;
    }

    let precision = tp as f64 / (tp + fp).max(1) as f64;
    let recall = tp as f64 / (tp + fnn).max(1) as f64;

    eprintln!("--- E11 Confusion Matrix ---");
    eprintln!("TP={tp} FP={fp} FN={fnn}");
    eprintln!("Precision: {precision:.4} (threshold >= 0.80)");
    eprintln!("Recall:    {recall:.4} (threshold >= 0.70)");
    eprintln!("Entries:   {total_entries} (threshold >= 30)");

    assert!(
        precision >= 0.80,
        "E11 FAILED: precision {precision:.4} < 0.80 (TP={tp} FP={fp})"
    );
    assert!(
        recall >= 0.70,
        "E11 FAILED: recall {recall:.4} < 0.70 (TP={tp} FN={fnn})"
    );
}

/// Verify all 6 SelectorIssue variants appear at least twice in the broken corpus.
#[test]
fn broken_corpus_covers_all_variants_at_least_twice() {
    let broken = load_yaml("known_broken.yaml");

    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for entry in &broken {
        for issue in &entry.expected {
            *counts.entry(issue.clone()).or_default() += 1;
        }
    }

    let required = [
        "TooGeneric",
        "MissingFallback",
        "DeepNthChild",
        "AbsoluteXPath",
        "OverlyDynamicClass",
        "BrittleAttribute",
    ];

    for variant in required {
        let count = counts.get(variant).copied().unwrap_or(0);
        assert!(
            count >= 2,
            "variant {variant} appears only {count} times in broken corpus (need >= 2)"
        );
    }
}

/// Verify good corpus entries all expect empty issue sets.
#[test]
fn good_corpus_entries_all_expect_empty() {
    let good = load_yaml("known_good.yaml");
    for entry in &good {
        assert!(
            entry.expected.is_empty(),
            "good corpus entry {:?} has non-empty expected: {:?}",
            entry.selector,
            entry.expected
        );
    }
}
