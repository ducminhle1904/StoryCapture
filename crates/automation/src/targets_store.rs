//! Self-healing targets sidecar file — `.story.targets.json`.
//!
//! Plan 07-04c (PHASE-7.5). A sibling JSON file to each `.story` source that
//! carries per-step primary + fallback locator candidates keyed by UUIDv7
//! `step_id` (see `story_parser::LineMeta.step_id`, plan 07-04b). The
//! executor consults this file when a primary locator's `wait_actionable`
//! call times out — it iterates the step's fallbacks in order and promotes
//! the first one that passes `wait_actionable`, rewriting the targets JSON
//! atomically (via temp-file + `fs::rename`) while leaving the `.story`
//! source **untouched**.
//!
//! ## Contract
//!
//! ```text
//! foo.story           ← DSL source — NEVER modified by self-healing
//! foo.story.targets.json  ← sidecar — rewritten atomically on fallback promotion
//! ```
//!
//! Schema version `1`. Each step id maps to a [`StepTargets`] holding a
//! [`TargetRecord`] primary + ordered fallback list. `kind` is one of
//! `"role" | "testid" | "label" | "text_exact" | "selector" | "text" | "aria"`
//! matching `story_parser::SelectorOrText` tags.
//!
//! ## Atomic write
//!
//! [`atomic_write`] writes to `<path>.tmp.<pid>` first, calls `sync_data()`,
//! then `fs::rename` to the final path. Orphaned tmp files from a crashed
//! process are cleaned on the next successful write (the temp name embeds
//! the current process id so we never clobber another live writer's temp).
//!
//! ## Missing-file semantics
//!
//! [`load`] returns [`TargetsFile::empty`] when the file does not exist —
//! legacy `.story` files (no `step_id` comments) never cause the targets
//! store to error. A malformed JSON body or version mismatch IS an error,
//! surfaced via [`AutomationError::Protocol`].

use crate::error::AutomationError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, AutomationError>;

/// Current on-disk schema version. Bump + migrate if the shape changes.
pub const CURRENT_VERSION: u32 = 1;

/// The top-level `.story.targets.json` body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetsFile {
    pub version: u32,
    #[serde(default)]
    pub steps: HashMap<Uuid, StepTargets>,
}

impl TargetsFile {
    /// An empty store with the current schema version — used as the fallback
    /// when the sidecar file is absent.
    pub fn empty() -> Self {
        Self {
            version: CURRENT_VERSION,
            steps: HashMap::new(),
        }
    }
}

impl Default for TargetsFile {
    fn default() -> Self {
        Self::empty()
    }
}

/// A single step's primary + fallback locator candidates.
///
/// On self-healing promotion, the old primary is pushed to `fallbacks[0]`
/// and the winning fallback is moved to `primary` (see the executor hook
/// in `executor.rs`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StepTargets {
    pub primary: TargetRecord,
    #[serde(default)]
    pub fallbacks: Vec<TargetRecord>,
}

/// A single locator candidate — one of the `SelectorOrText` tags encoded
/// as `{ kind, value }` to stay forward-compatible with future selector
/// strategies without requiring a schema bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetRecord {
    /// One of: `role`, `testid`, `label`, `text_exact`, `selector`, `text`, `aria`.
    pub kind: String,
    /// For `selector`/`testid`/`label`/`text_exact`/`text`/`aria`: a JSON string.
    /// For `role`: an object `{ "role": "<role>", "name": "<name>" }`.
    pub value: serde_json::Value,
}

/// Load the sidecar targets file. Returns [`TargetsFile::empty`] when
/// `path` does not exist (legacy-story forward compat); errors on a
/// malformed body or unsupported version.
pub fn load(path: &Path) -> Result<TargetsFile> {
    if !path.exists() {
        return Ok(TargetsFile::empty());
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| AutomationError::Io(format!("read {}: {e}", path.display())))?;
    let file: TargetsFile = serde_json::from_str(&raw)
        .map_err(|e| AutomationError::Protocol(format!("decode {}: {e}", path.display())))?;
    if file.version != CURRENT_VERSION {
        return Err(AutomationError::Protocol(format!(
            "unsupported targets file version {} (expected {})",
            file.version, CURRENT_VERSION
        )));
    }
    Ok(file)
}

/// Atomically rewrite the sidecar targets file — writes to
/// `<path>.tmp.<pid>`, syncs, then `fs::rename`s over `path`. Never
/// leaves a half-written file on success.
pub fn atomic_write(path: &Path, file: &TargetsFile) -> Result<()> {
    let tmp: PathBuf = {
        let mut s = path.as_os_str().to_os_string();
        s.push(format!(".tmp.{}", std::process::id()));
        PathBuf::from(s)
    };
    let raw = serde_json::to_vec_pretty(file)
        .map_err(|e| AutomationError::Protocol(format!("encode targets: {e}")))?;
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| AutomationError::Io(format!("create tmp {}: {e}", tmp.display())))?;
        f.write_all(&raw)
            .map_err(|e| AutomationError::Io(format!("write tmp {}: {e}", tmp.display())))?;
        f.sync_data()
            .map_err(|e| AutomationError::Io(format!("fsync tmp {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup if rename fails.
        let _ = fs::remove_file(&tmp);
        AutomationError::Io(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

/// Compute the sibling targets path for a `.story` file:
/// `foo.story` → `foo.story.targets.json`.
pub fn targets_path_for(story_path: &Path) -> PathBuf {
    let mut s = story_path.as_os_str().to_os_string();
    s.push(".targets.json");
    PathBuf::from(s)
}

/// Convert a [`TargetRecord`] into a `story_parser::SelectorOrText` so the
/// executor can resolve it via the standard [`crate::selector::SmartSelector`]
/// path. Unknown `kind` values surface as [`AutomationError::Protocol`].
pub fn target_record_to_selector(
    rec: &TargetRecord,
) -> Result<story_parser::SelectorOrText> {
    use story_parser::SelectorOrText;
    match rec.kind.as_str() {
        "selector" => Ok(SelectorOrText::Selector(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("selector value must be a string".into()))?
                .to_string(),
        )),
        "testid" => Ok(SelectorOrText::TestId(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("testid value must be a string".into()))?
                .to_string(),
        )),
        "aria" => Ok(SelectorOrText::Aria(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("aria value must be a string".into()))?
                .to_string(),
        )),
        "label" => Ok(SelectorOrText::Label(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("label value must be a string".into()))?
                .to_string(),
        )),
        "text_exact" => Ok(SelectorOrText::TextExact(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("text_exact value must be a string".into()))?
                .to_string(),
        )),
        "text" => Ok(SelectorOrText::Text(
            rec.value
                .as_str()
                .ok_or_else(|| AutomationError::Protocol("text value must be a string".into()))?
                .to_string(),
        )),
        "role" => {
            let role_str = rec
                .value
                .get("role")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AutomationError::Protocol("role.role must be a string".into()))?;
            let name = rec
                .value
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AutomationError::Protocol("role.name must be a string".into()))?
                .to_string();
            let role = story_parser::AriaRole::from_keyword(role_str).ok_or_else(|| {
                AutomationError::Protocol(format!("unknown aria role `{role_str}`"))
            })?;
            Ok(SelectorOrText::Role { role, name })
        }
        other => Err(AutomationError::Protocol(format!(
            "unknown target kind `{other}`"
        ))),
    }
}

#[cfg(test)]
mod targets_store_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_returns_empty() {
        let d = tempdir().unwrap();
        let f = load(&d.path().join("missing.json")).unwrap();
        assert_eq!(f.version, CURRENT_VERSION);
        assert!(f.steps.is_empty());
    }

    #[test]
    fn version_mismatch_errors() {
        let d = tempdir().unwrap();
        let p = d.path().join("bad.json");
        fs::write(&p, r#"{"version":99,"steps":{}}"#).unwrap();
        let r = load(&p);
        assert!(matches!(r, Err(AutomationError::Protocol(_))));
    }

    #[test]
    fn atomic_write_round_trip() {
        let d = tempdir().unwrap();
        let p = d.path().join("t.json");
        let mut file = TargetsFile::empty();
        file.steps.insert(
            Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000001").unwrap(),
            StepTargets {
                primary: TargetRecord {
                    kind: "testid".into(),
                    value: serde_json::json!("save"),
                },
                fallbacks: vec![TargetRecord {
                    kind: "selector".into(),
                    value: serde_json::json!("#save"),
                }],
            },
        );
        atomic_write(&p, &file).unwrap();
        let back = load(&p).unwrap();
        assert_eq!(back, file);
    }

    #[test]
    fn atomic_write_does_not_leave_tmp_on_success() {
        let d = tempdir().unwrap();
        let p = d.path().join("t.json");
        atomic_write(&p, &TargetsFile::empty()).unwrap();
        let entries: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "exactly one file should remain (no tmp leak)");
        let name = entries[0].file_name();
        assert_eq!(name.to_string_lossy(), "t.json");
    }

    #[test]
    fn targets_path_for_appends_suffix() {
        let p = Path::new("/tmp/foo.story");
        let tp = targets_path_for(p);
        assert_eq!(tp.to_string_lossy(), "/tmp/foo.story.targets.json");
    }

    #[test]
    fn target_record_to_selector_handles_all_kinds() {
        let cases = [
            (
                TargetRecord { kind: "selector".into(), value: serde_json::json!("#id") },
                story_parser::SelectorOrText::Selector("#id".into()),
            ),
            (
                TargetRecord { kind: "testid".into(), value: serde_json::json!("email") },
                story_parser::SelectorOrText::TestId("email".into()),
            ),
            (
                TargetRecord { kind: "label".into(), value: serde_json::json!("Email") },
                story_parser::SelectorOrText::Label("Email".into()),
            ),
            (
                TargetRecord { kind: "text_exact".into(), value: serde_json::json!("Save") },
                story_parser::SelectorOrText::TextExact("Save".into()),
            ),
            (
                TargetRecord {
                    kind: "role".into(),
                    value: serde_json::json!({"role": "button", "name": "Save"}),
                },
                story_parser::SelectorOrText::Role {
                    role: story_parser::AriaRole::from_keyword("button").unwrap(),
                    name: "Save".into(),
                },
            ),
        ];
        for (rec, expected) in cases {
            assert_eq!(target_record_to_selector(&rec).unwrap(), expected);
        }
    }

    #[test]
    fn target_record_to_selector_rejects_unknown_kind() {
        let r = TargetRecord {
            kind: "moon-phase".into(),
            value: serde_json::json!(null),
        };
        assert!(matches!(
            target_record_to_selector(&r),
            Err(AutomationError::Protocol(_))
        ));
    }
}
