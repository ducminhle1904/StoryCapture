//! eval_report: Compare eval_result.json against eval_thresholds.toml.
//!
//! Exits 0 if all metrics meet thresholds, 1 if any regression detected.
//! With --ci flag, emits GitHub Actions `::error::` annotations.

use std::collections::HashMap;
use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        process::exit(0);
    }

    let results_path = get_arg(&args, "--results")
        .unwrap_or_else(|| "eval_result.json".to_string());
    let thresholds_path = get_arg(&args, "--thresholds")
        .unwrap_or_else(|| "crates/intelligence/tests/fixtures/eval_thresholds.toml".to_string());
    let ci_mode = args.iter().any(|a| a == "--ci");

    // Load eval_result.json
    let results_content = match std::fs::read_to_string(&results_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: cannot read results file '{}': {}", results_path, e);
            process::exit(2);
        }
    };

    let results: EvalResult = match serde_json::from_str(&results_content) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: invalid eval_result.json: {}", e);
            process::exit(2);
        }
    };

    // Load eval_thresholds.toml
    let thresholds_content = match std::fs::read_to_string(&thresholds_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: cannot read thresholds file '{}': {}", thresholds_path, e);
            process::exit(2);
        }
    };

    let thresholds_doc: ThresholdsDoc = match toml::from_str(&thresholds_content) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: invalid eval_thresholds.toml: {}", e);
            process::exit(2);
        }
    };

    // Compare metrics against thresholds
    let mut regressions = Vec::new();
    let mut report_rows = Vec::new();

    for (key, threshold) in &thresholds_doc.thresholds {
        let actual = results.metrics.get(key).copied();

        let (status, actual_val) = match actual {
            Some(val) => {
                // For cost/latency metrics, lower is better (threshold is upper bound)
                let is_lower_better = key.contains("cost") || key.contains("_ms") || key.contains("drift");
                let passed = if is_lower_better {
                    val <= *threshold
                } else {
                    val >= *threshold
                };

                if passed {
                    ("PASS", val)
                } else {
                    regressions.push(format!(
                        "regression: {} {:.4} {} {:.4}",
                        key,
                        val,
                        if is_lower_better { ">" } else { "<" },
                        threshold
                    ));
                    ("FAIL", val)
                }
            }
            None => {
                regressions.push(format!("missing: {} not found in eval_result.json", key));
                ("MISS", 0.0)
            }
        };

        report_rows.push((key.clone(), *threshold, actual_val, status.to_string()));
    }

    // Print report table
    println!();
    println!("## Eval Report");
    println!();
    println!("| Metric | Threshold | Actual | Status |");
    println!("|--------|-----------|--------|--------|");
    for (key, threshold, actual, status) in &report_rows {
        println!("| {} | {:.4} | {:.4} | {} |", key, threshold, actual, status);
    }
    println!();

    // Print fixture summary
    let total = results.fixtures.len();
    let passed = results.fixtures.iter().filter(|f| f.pass).count();
    println!("Fixtures: {}/{} passed", passed, total);
    println!();

    if regressions.is_empty() {
        println!("PASS");
        process::exit(0);
    } else {
        for r in &regressions {
            if ci_mode {
                println!("::error::{}", r);
            } else {
                eprintln!("{}", r);
            }
        }
        process::exit(1);
    }
}

fn print_usage() {
    println!("eval_report - Compare eval_result.json against eval_thresholds.toml");
    println!();
    println!("USAGE:");
    println!("    eval_report [OPTIONS]");
    println!();
    println!("OPTIONS:");
    println!("    --results <PATH>      Path to eval_result.json (default: eval_result.json)");
    println!("    --thresholds <PATH>   Path to eval_thresholds.toml (default: crates/intelligence/tests/fixtures/eval_thresholds.toml)");
    println!("    --ci                  Emit GitHub Actions ::error:: annotations");
    println!("    -h, --help            Print this help message");
}

fn get_arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

#[derive(serde::Deserialize)]
struct ThresholdsDoc {
    thresholds: HashMap<String, f64>,
}

#[derive(serde::Deserialize)]
struct EvalResult {
    fixtures: Vec<FixtureResult>,
    metrics: HashMap<String, f64>,
}

#[derive(serde::Deserialize)]
struct FixtureResult {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    bucket: String,
    pass: bool,
}
