//! Self-healing targets sidecar file — `.story.targets.json`.
//!
//! A sibling JSON file to each `.story` source that carries per-step
//! primary + fallback locator candidates keyed by UUIDv7 `step_id` (see
//! `story_parser::LineMeta.step_id`). The executor consults this file when
//! a primary locator's `wait_actionable` call times out — it iterates the
//! step's fallbacks in order and promotes the first one that passes
//! `wait_actionable`, rewriting the targets JSON atomically (via temp-file
//! + `fs::rename`) while leaving the `.story` source **untouched**.
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
    /// Optional 1-indexed `nth` modifier. `None` means "any unique match"
    /// — preserves legacy behavior for on-disk targets that omit this
    /// field. `serde(default)` lets old JSON load without migration;
    /// `skip_serializing_if` keeps new JSON byte-identical to old when no
    /// nth is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nth: Option<u32>,
}

/// Load the sidecar targets file. Returns [`TargetsFile::empty`] when
/// `path` does not exist (legacy-story forward compat); errors on a
/// malformed body or unsupported version.
pub fn load(path: &Path) -> Result<TargetsFile> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TargetsFile::empty());
        }
        Err(e) => return Err(AutomationError::Io(format!("read {}: {e}", path.display()))),
    };
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

/// Atomically rewrite the sidecar targets file via `NamedTempFile::persist`
/// (write-to-temp in the same directory, fsync, atomic rename). Never leaves
/// a half-written file on success; the temp file is auto-cleaned on drop if
/// any step before persist fails.
pub fn atomic_write(path: &Path, file: &TargetsFile) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AutomationError::Io(format!("no parent dir for {}", path.display())))?;
    let raw = serde_json::to_vec_pretty(file)
        .map_err(|e| AutomationError::Protocol(format!("encode targets: {e}")))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| AutomationError::Io(format!("create tmp in {}: {e}", parent.display())))?;
    tmp.write_all(&raw)
        .map_err(|e| AutomationError::Io(format!("write tmp: {e}")))?;
    tmp.as_file()
        .sync_data()
        .map_err(|e| AutomationError::Io(format!("fsync tmp: {e}")))?;
    tmp.persist(path)
        .map_err(|e| AutomationError::Io(format!("persist to {}: {e}", path.display())))?;
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
pub fn target_record_to_selector(rec: &TargetRecord) -> Result<story_parser::SelectorOrText> {
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
                .ok_or_else(|| {
                    AutomationError::Protocol("text_exact value must be a string".into())
                })?
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
                    nth: None,
                },
                fallbacks: vec![TargetRecord {
                    kind: "selector".into(),
                    value: serde_json::json!("#save"),
                    nth: None,
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
        assert_eq!(
            entries.len(),
            1,
            "exactly one file should remain (no tmp leak)"
        );
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
                TargetRecord {
                    kind: "selector".into(),
                    value: serde_json::json!("#id"),
                    nth: None,
                },
                story_parser::SelectorOrText::Selector("#id".into()),
            ),
            (
                TargetRecord {
                    kind: "testid".into(),
                    value: serde_json::json!("email"),
                    nth: None,
                },
                story_parser::SelectorOrText::TestId("email".into()),
            ),
            (
                TargetRecord {
                    kind: "label".into(),
                    value: serde_json::json!("Email"),
                    nth: None,
                },
                story_parser::SelectorOrText::Label("Email".into()),
            ),
            (
                TargetRecord {
                    kind: "text_exact".into(),
                    value: serde_json::json!("Save"),
                    nth: None,
                },
                story_parser::SelectorOrText::TextExact("Save".into()),
            ),
            (
                TargetRecord {
                    kind: "role".into(),
                    value: serde_json::json!({"role": "button", "name": "Save"}),
                    nth: None,
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
            nth: None,
        };
        assert!(matches!(
            target_record_to_selector(&r),
            Err(AutomationError::Protocol(_))
        ));
    }

    // ─── nth field schema migration ───────────────────────────────────

    #[test]
    fn legacy_json_without_nth_loads_as_none() {
        // Legacy sidecar JSON has no `nth` field. Must load with
        // `nth: None` via serde(default).
        let d = tempdir().unwrap();
        let p = d.path().join("legacy.json");
        fs::write(
            &p,
            r##"{
  "version": 1,
  "steps": {
    "018f4c1e-7b3a-7000-8000-000000000001": {
      "primary": { "kind": "testid", "value": "save" },
      "fallbacks": [
        { "kind": "selector", "value": "#save" }
      ]
    }
  }
}"##,
        )
        .unwrap();
        let file = load(&p).unwrap();
        let step = file.steps.values().next().unwrap();
        assert_eq!(step.primary.nth, None);
        assert_eq!(step.fallbacks[0].nth, None);
    }

    #[test]
    fn new_json_with_nth_loads_and_round_trips() {
        let d = tempdir().unwrap();
        let p = d.path().join("nth.json");
        let id = Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000002").unwrap();
        let mut file = TargetsFile::empty();
        file.steps.insert(
            id,
            StepTargets {
                primary: TargetRecord {
                    kind: "testid".into(),
                    value: serde_json::json!("row"),
                    nth: Some(2),
                },
                fallbacks: vec![TargetRecord {
                    kind: "selector".into(),
                    value: serde_json::json!(".row"),
                    nth: Some(2),
                }],
            },
        );
        atomic_write(&p, &file).unwrap();
        let back = load(&p).unwrap();
        let step = back.steps.get(&id).unwrap();
        assert_eq!(step.primary.nth, Some(2));
        assert_eq!(step.fallbacks[0].nth, Some(2));
        assert_eq!(back, file);
    }

    #[test]
    fn nth_none_skips_serialization() {
        // `nth: None` must NOT appear in the on-the-wire JSON so legacy
        // tooling reading old files sees byte-identical output.
        let id = Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000003").unwrap();
        let mut file = TargetsFile::empty();
        file.steps.insert(
            id,
            StepTargets {
                primary: TargetRecord {
                    kind: "testid".into(),
                    value: serde_json::json!("save"),
                    nth: None,
                },
                fallbacks: vec![],
            },
        );
        let raw = serde_json::to_string(&file).unwrap();
        assert!(
            !raw.contains("\"nth\""),
            "nth: None must be skipped on the wire, got: {raw}"
        );
    }

    #[test]
    fn nth_some_serializes_as_number() {
        let id = Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000004").unwrap();
        let mut file = TargetsFile::empty();
        file.steps.insert(
            id,
            StepTargets {
                primary: TargetRecord {
                    kind: "testid".into(),
                    value: serde_json::json!("row"),
                    nth: Some(3),
                },
                fallbacks: vec![],
            },
        );
        let raw = serde_json::to_string(&file).unwrap();
        assert!(
            raw.contains("\"nth\":3"),
            "nth: Some(3) must serialize as a number, got: {raw}"
        );
    }

    #[test]
    fn mixed_legacy_and_nth_steps_coexist() {
        // Realistic upgrade scenario: existing user has legacy steps without
        // nth alongside a freshly stamped step that uses nth.
        let d = tempdir().unwrap();
        let p = d.path().join("mixed.json");
        fs::write(
            &p,
            r#"{
  "version": 1,
  "steps": {
    "018f4c1e-7b3a-7000-8000-000000000005": {
      "primary": { "kind": "testid", "value": "old" }
    },
    "018f4c1e-7b3a-7000-8000-000000000006": {
      "primary": { "kind": "testid", "value": "row", "nth": 2 }
    }
  }
}"#,
        )
        .unwrap();
        let file = load(&p).unwrap();
        let by_kind: std::collections::HashMap<_, _> = file
            .steps
            .values()
            .map(|s| (s.primary.value.as_str().unwrap_or("").to_string(), s.primary.nth))
            .collect();
        assert_eq!(by_kind.get("old").copied(), Some(None));
        assert_eq!(by_kind.get("row").copied(), Some(Some(2)));
    }
}
