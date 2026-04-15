//! Auto-annotate: derive a short annotation string from a DSL step's
//! verb + target (+ optional comment). Phase 2 D-27 mandates
//! **off-by-default** — the UI surfaces a toggle; the authored text
//! always wins if supplied.
//!
//! We do not depend on `crates/story-parser` directly; instead, the
//! caller adapts the parser's `Step` to the [`StepAstRef`] trait. This
//! keeps the `effects` crate free of upstream DSL churn.

/// Minimal read-only adapter over a parser's Step AST.
pub trait StepAstRef {
    /// Lowercase verb identifier ("click", "type", "navigate", …).
    fn verb(&self) -> &str;
    /// Target string (selector label, URL, form field, …), if any.
    fn target(&self) -> Option<&str>;
    /// Author-supplied inline comment, if any (takes precedence when
    /// `prefer_comment_over_synthesis = true`).
    fn comment(&self) -> Option<&str>;
}

/// Options controlling [`auto_annotate_step`]. `enabled: false` is the
/// default (D-27).
#[derive(Debug, Clone, Copy)]
pub struct AutoAnnotateOptions {
    pub enabled: bool,
    pub prefer_comment_over_synthesis: bool,
}

impl Default for AutoAnnotateOptions {
    fn default() -> Self {
        // D-27: auto-annotate is OFF unless the user explicitly opts in.
        Self {
            enabled: false,
            prefer_comment_over_synthesis: true,
        }
    }
}

/// Produce an annotation string for a step, or `None` if the user has
/// disabled auto-annotate or the step has no usable metadata.
pub fn auto_annotate_step<S: StepAstRef>(step: &S, opts: &AutoAnnotateOptions) -> Option<String> {
    if !opts.enabled {
        return None;
    }
    if opts.prefer_comment_over_synthesis {
        if let Some(c) = step.comment() {
            let trimmed = c.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    let target = step.target()?;
    let phrase = match step.verb() {
        "click" => format!("Click {}", target),
        "type" => format!("Type into {}", target),
        "navigate" | "goto" => format!("Go to {}", target),
        "hover" => format!("Hover {}", target),
        "scroll" => format!("Scroll to {}", target),
        "assert" => format!("Expect {}", target),
        _ => return None,
    };
    Some(phrase)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeStep<'a> {
        v: &'a str,
        t: Option<&'a str>,
        c: Option<&'a str>,
    }
    impl<'a> StepAstRef for FakeStep<'a> {
        fn verb(&self) -> &str {
            self.v
        }
        fn target(&self) -> Option<&str> {
            self.t
        }
        fn comment(&self) -> Option<&str> {
            self.c
        }
    }

    #[test]
    fn disabled_returns_none() {
        let s = FakeStep { v: "click", t: Some("Save"), c: None };
        assert_eq!(auto_annotate_step(&s, &AutoAnnotateOptions::default()), None);
    }
}
