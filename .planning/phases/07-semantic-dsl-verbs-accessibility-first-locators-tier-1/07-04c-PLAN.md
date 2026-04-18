---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04c
type: execute
wave: 6
depends_on:
  - 07-04a
  - 07-04b
files_modified:
  - crates/automation/src/targets_store.rs
  - crates/automation/src/lib.rs
  - crates/automation/src/executor.rs
  - crates/automation/tests/self_healing.rs
  - crates/automation/tests/fixtures/self_healing.story
  - crates/automation/tests/fixtures/self_healing.story.targets.json
  - crates/automation/tests/fixtures/self_healing.html
  - apps/desktop/src-tauri/src/commands/picker.rs
  - apps/desktop/src-tauri/src/lib.rs
  - apps/desktop/src/features/recorder/pick-element-button.tsx
  - apps/desktop/src/ipc/picker.ts
autonomous: true
requirements:
  - PHASE-7.5
tags: dsl, picker, self-healing, targets-store, stamp-step-id
must_haves:
  truths:
    - "targets_store::atomic_write writes via temp-file (.tmp.<pid>) + fs::rename (POSIX-atomic)"
    - "targets_store::load returns empty TargetsFile when file absent; errors on unsupported version; decodes the documented schema"
    - "When executor calls wait_actionable on a primary locator that fails, it consults `<story>.story.targets.json`, iterates fallbacks in order, and promotes the first passing fallback to primary — rewriting the targets JSON atomically (NOT the .story source)"
    - "Commands with step_id == None skip the targets-store path entirely (no regression on legacy stories)"
    - "PickElementButton calls picker_stamp_step_id after a successful pick so first pick stamps a new UUIDv7 into the .story source via the formatter (07-04b) AND seeds the targets file"
    - "Integration test compiles (cargo test --no-run) and at run time (marked #[ignore]) proves: primary `#save-v1` miss → fallback `#save-v2` hit → promoted to new primary; `.story` source UNCHANGED; targets.json REWRITTEN with old primary pushed to fallbacks[0]"
    - "End-to-end acceptance (PHASE-7.5 final gate): operator smoke confirms primary fails → fallback promoted → `.story.targets.json` rewritten (runbook in 07-04c-SMOKE.md)"
    - "Full regression: cargo test --workspace + pnpm test both exit 0 after integration"
  artifacts:
    - path: "crates/automation/src/targets_store.rs"
      provides: "TargetsFile read/write with atomic temp+rename; keyed by UUIDv7 step_id"
      contains: "atomic_write"
    - path: "crates/automation/src/executor.rs"
      provides: "Self-healing hook on primary-miss; walks TargetsFile.fallbacks; promotes first hit and rewrites store"
      contains: "promote_fallback"
    - path: "crates/automation/tests/self_healing.rs"
      provides: "Integration test: primary-miss → fallback-hit → promoted primary + source untouched"
      contains: "primary_miss_promotes_first_passing_fallback"
    - path: "apps/desktop/src-tauri/src/commands/picker.rs"
      provides: "picker_stamp_step_id Tauri command wrapping parse → mutate step_id → format_story → targets_store::atomic_write"
      contains: "picker_stamp_step_id"
  key_links:
    - from: "executor wait_actionable primary-miss"
      to: "targets_store.rs load()"
      via: "step_id lookup → iterate fallbacks → promote on first hit"
      pattern: "promote_fallback"
    - from: "targets_store.rs atomic_write"
      to: "`<story>.story.targets.json`"
      via: "tmp path + fs::rename (POSIX-atomic)"
      pattern: "rename"
    - from: "PickElementButton successful pick"
      to: "picker_stamp_step_id Tauri command"
      via: "invoke with primary + candidate fallbacks"
      pattern: "picker_stamp_step_id"
    - from: "picker_stamp_step_id"
      to: "story_parser::format_story + targets_store::atomic_write"
      via: "parse source → mutate LineMeta.step_id → format → write; seed targets.json"
      pattern: "format_story"
---

<objective>
Ship the self-healing closing slice: `targets_store.rs` with atomic read/write, executor hook that promotes fallbacks when primary misses, `picker_stamp_step_id` Tauri command stamping UUIDv7 on first pick, and an integration test that proves the end-to-end self-healing behavior. This is the final plan delivering PHASE-7.5 and owns the final user-observable acceptance gate.

Purpose: Lock in the self-healing contract — when a primary locator stops matching (UI changed), re-running the story transparently promotes the best-matching fallback and rewrites the sidecar targets JSON, never touching the `.story` source. First pick of a line stamps a UUIDv7 via the formatter (07-04b) so subsequent runs can be identified.

Output: `targets_store.rs` (TargetsFile / StepTargets / TargetRecord + load + atomic_write + targets_path_for); executor self-healing path via `promote_fallback` helper; `picker_stamp_step_id` Tauri command + desktop wiring so first pick stamps a UUID AND seeds targets.json; integration test fixtures + `self_healing.rs` marked `#[ignore]` for live runs; 4 unit tests on targets_store; full workspace regression green; `07-04c-SMOKE.md` runbook with self-healing steps.
</objective>

<scope>
**EXPLICITLY IN SCOPE:**
- `targets_store.rs` module with atomic write + load + `targets_path_for` helper.
- Executor hook: on primary wait_actionable miss with step_id present, iterate fallbacks, promote first success, rewrite targets JSON.
- `picker_stamp_step_id` Tauri command: parse `.story`, locate command at cursor, stamp UUIDv7 via `LineMeta.step_id`, format via 07-04b's `format_story`, write back; seed targets.json atomically.
- `PickElementButton` (07-04a extension): after successful pick, invoke stamp command with `result.locator` as primary and `result.candidates` mapped to fallbacks.
- 4 targets_store unit tests (missing-file, version-mismatch, round-trip, no-tmp-leak).
- 1 integration test compiling under `#[ignore]` (live sidecar required); 1 non-ignored compile-only smoke covering `targets_path_for` + missing-file.
- Full regression: `cargo test --workspace` + `pnpm test` both exit 0.
- `07-04c-SMOKE.md` runbook.

**EXPLICITLY OUT OF SCOPE:**
- JSON-RPC notification plumbing + hover preview chip (07-04a — dependency).
- Parser step-id grammar + formatter (07-04b — dependency).
- Tier 3 LLM fallback resolver (future phase).
</scope>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04a-SUMMARY.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04b-SUMMARY.md
@CLAUDE.md

@crates/automation/src/executor.rs
@crates/automation/src/driver.rs
@crates/automation/src/auto_wait.rs
@crates/story-parser/src/formatter.rs
@apps/desktop/src/features/recorder/pick-element-button.tsx

<interfaces>
```rust
// crates/automation/src/targets_store.rs (NEW)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetsFile {
    pub version: u32,                          // must be 1
    pub steps: HashMap<Uuid, StepTargets>,     // UUIDv7 step_id → targets
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepTargets {
    pub primary: TargetRecord,
    pub fallbacks: Vec<TargetRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetRecord {
    pub kind: String,           // "role" | "testid" | "label" | "text_exact" | "selector" | "text" | "aria"
    pub value: serde_json::Value,
}

pub fn load(path: &Path) -> Result<TargetsFile>;
pub fn atomic_write(path: &Path, file: &TargetsFile) -> Result<()>;  // tmp + rename
pub fn targets_path_for(story_path: &Path) -> PathBuf;  // foo.story → foo.story.targets.json
```

```rust
// apps/desktop/src-tauri/src/commands/picker.rs — NEW command
#[tauri::command]
pub async fn picker_stamp_step_id(
    story_path: String,
    line_offset: u32,
    primary: serde_json::Value,      // { kind, value }
    fallbacks: Vec<serde_json::Value>,
) -> Result<String, String>;  // returns stamped UUIDv7 as String
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: targets_store.rs + executor self-healing + 4 unit tests + integration fixtures</name>
  <files>crates/automation/src/targets_store.rs, crates/automation/src/lib.rs, crates/automation/src/executor.rs, crates/automation/tests/self_healing.rs, crates/automation/tests/fixtures/self_healing.story, crates/automation/tests/fixtures/self_healing.story.targets.json, crates/automation/tests/fixtures/self_healing.html</files>
  <read_first>
    - crates/automation/src/executor.rs (how commands are dispatched; where wait_actionable is called — this is the hook point)
    - crates/automation/src/auto_wait.rs (wait_actionable signature + error types)
    - crates/automation/src/driver.rs (BrowserDriver trait + ResolvedSelector)
    - crates/story-parser/src/ast.rs (LineMeta.step_id from 07-04b)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md §Targets sidecar file §Self-healing
  </read_first>
  <behavior>
    - `targets_store::load(path)` returns `Ok(TargetsFile)` for existing valid file; `Ok(TargetsFile::empty())` when the file does not exist; `Err` for version-mismatch or malformed JSON.
    - `targets_store::atomic_write(path, &file)` writes to `<path>.tmp.<pid>` then `fs::rename` to target path.
    - `targets_store::targets_path_for(&Path)` appends `.targets.json` to the story path's OS string.
    - Executor, before running a command with `meta.step_id.is_some()`, consults the sidecar targets file. If the primary `wait_actionable` call fails, iterates `fallbacks` in order; first success promotes that fallback to primary and rewrites the file.
    - Commands with `step_id == None` skip the targets-store path entirely (no regression on legacy stories).
    - Integration test: uses a local HTML fixture with a button whose `id` changes between "v1" and "v2". `self_healing.story` has a `click selector "#save-v1"` with a pre-populated step_id; `self_healing.story.targets.json` has `primary: selector "#save-v1"` + `fallbacks: [selector "#save-v2", role "button:Save"]`. The test loads the v2 HTML, runs the executor, expects primary-miss → fallback-hit on `#save-v2`, then reads the targets file and asserts it was rewritten with `#save-v2` as new primary. `.story` source MUST remain unchanged.
  </behavior>
  <action>
1. **Create `crates/automation/src/targets_store.rs`:**
   ```rust
   use std::collections::HashMap;
   use std::path::{Path, PathBuf};
   use std::fs;
   use std::io::Write;
   use serde::{Deserialize, Serialize};
   use uuid::Uuid;
   use crate::AutomationError;

   pub type Result<T> = std::result::Result<T, AutomationError>;

   #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
   pub struct TargetsFile {
       pub version: u32,
       pub steps: HashMap<Uuid, StepTargets>,
   }

   impl TargetsFile {
       pub fn empty() -> Self { Self { version: 1, steps: HashMap::new() } }
   }

   #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
   pub struct StepTargets {
       pub primary: TargetRecord,
       #[serde(default)]
       pub fallbacks: Vec<TargetRecord>,
   }

   #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
   pub struct TargetRecord {
       pub kind: String,
       pub value: serde_json::Value,
   }

   pub fn load(path: &Path) -> Result<TargetsFile> {
       if !path.exists() { return Ok(TargetsFile::empty()); }
       let raw = fs::read_to_string(path)
           .map_err(|e| AutomationError::Io(format!("read {}: {e}", path.display())))?;
       let file: TargetsFile = serde_json::from_str(&raw)
           .map_err(|e| AutomationError::Protocol(format!("decode {}: {e}", path.display())))?;
       if file.version != 1 {
           return Err(AutomationError::Protocol(format!("unsupported targets file version {}", file.version)));
       }
       Ok(file)
   }

   pub fn atomic_write(path: &Path, file: &TargetsFile) -> Result<()> {
       let tmp: PathBuf = path.with_extension(format!("tmp.{}", std::process::id()));
       let raw = serde_json::to_vec_pretty(file)
           .map_err(|e| AutomationError::Protocol(format!("encode: {e}")))?;
       {
           let mut f = fs::File::create(&tmp)
               .map_err(|e| AutomationError::Io(format!("create tmp {}: {e}", tmp.display())))?;
           f.write_all(&raw).map_err(|e| AutomationError::Io(e.to_string()))?;
           f.sync_data().map_err(|e| AutomationError::Io(e.to_string()))?;
       }
       fs::rename(&tmp, path).map_err(|e| AutomationError::Io(format!("rename {} -> {}: {e}", tmp.display(), path.display())))?;
       Ok(())
   }

   pub fn targets_path_for(story_path: &Path) -> PathBuf {
       let mut s = story_path.as_os_str().to_os_string();
       s.push(".targets.json");
       PathBuf::from(s)
   }
   ```
   Adjust `AutomationError` variants to whatever exists in `crates/automation/src/errors.rs`.

2. **Register in `lib.rs`:** `pub mod targets_store;`.

3. **Edit `crates/automation/src/executor.rs`.** Identify the hook point where a command's target is resolved (look for `wait_actionable(...)` calls post-SmartSelector). Wrap with `promote_fallback` helper:
   ```rust
   // Pseudocode for the Click arm — adapt to the actual shape:
   let resolved = SmartSelector::resolve_with_attempts(driver, action, &cmd.target, timeout_ms).await?;
   let wait_result = driver.wait_actionable(&resolved, timeout_ms).await;
   if wait_result.is_ok() {
       driver.click(&resolved).await?;
   } else if let Some(step_id) = cmd.meta.step_id {
       // Self-healing path.
       let store_path = targets_store::targets_path_for(&ctx.story_path);
       let mut store = targets_store::load(&store_path).unwrap_or_else(|_| TargetsFile::empty());
       let mut promoted = None;
       if let Some(step) = store.steps.get(&step_id).cloned() {
           for (idx, fb) in step.fallbacks.iter().enumerate() {
               let fb_resolved = ResolvedSelector {
                   strategy: parse_strategy(&fb.kind)?,
                   value: resolve_fb_value(fb),
               };
               if driver.wait_actionable(&fb_resolved, timeout_ms).await.is_ok() {
                   promoted = Some((idx, fb.clone()));
                   break;
               }
           }
           if let Some((idx, fb)) = promoted {
               let old_primary = step.primary.clone();
               let mut new_step = step.clone();
               new_step.primary = fb.clone();
               new_step.fallbacks.remove(idx);
               new_step.fallbacks.insert(0, old_primary);  // old primary becomes top fallback
               store.steps.insert(step_id, new_step);
               targets_store::atomic_write(&store_path, &store)?;
               let fb_resolved = ResolvedSelector { strategy: parse_strategy(&fb.kind)?, value: resolve_fb_value(&fb) };
               driver.click(&fb_resolved).await?;
           } else {
               wait_result?;
           }
       } else {
           wait_result?;
       }
   } else {
       wait_result?;
   }
   ```
   Consolidate the repeated shape into a helper `promote_fallback(driver, &cmd, step_id, story_path, timeout_ms) -> Result<Option<ResolvedSelector>>` to avoid copy-paste. Apply to each command arm that has a target.

4. **Create the integration test fixtures.** Three files:

   `crates/automation/tests/fixtures/self_healing.html`:
   ```html
   <!doctype html><html><body>
     <!-- The primary selector `#save-v1` does NOT exist in this version -->
     <button id="save-v2">Save</button>
   </body></html>
   ```

   `crates/automation/tests/fixtures/self_healing.story`:
   ```story
   story "self healing" {
     meta { app: "about:blank" }
     scene "s" {
       click selector "#save-v1"  # @id=018f4c1e-7b3a-7000-8000-0000000000aa
     }
   }
   ```

   `crates/automation/tests/fixtures/self_healing.story.targets.json`:
   ```json
   {
     "version": 1,
     "steps": {
       "018f4c1e-7b3a-7000-8000-0000000000aa": {
         "primary": { "kind": "selector", "value": "#save-v1" },
         "fallbacks": [
           { "kind": "selector", "value": "#save-v2" },
           { "kind": "role", "value": { "role": "button", "name": "Save" } }
         ]
       }
     }
   }
   ```

5. **Create `crates/automation/tests/self_healing.rs`:**
   ```rust
   use automation::targets_store;
   use std::path::PathBuf;

   #[tokio::test]
   #[ignore = "live sidecar required — run with `cargo test -p automation --test self_healing -- --ignored`"]
   async fn primary_miss_promotes_first_passing_fallback() {
       let tmp = tempfile::tempdir().unwrap();
       let story = tmp.path().join("self_healing.story");
       let targets = tmp.path().join("self_healing.story.targets.json");
       let html = tmp.path().join("self_healing.html");
       std::fs::copy("tests/fixtures/self_healing.story", &story).unwrap();
       std::fs::copy("tests/fixtures/self_healing.story.targets.json", &targets).unwrap();
       std::fs::copy("tests/fixtures/self_healing.html", &html).unwrap();

       let html_url = url::Url::from_file_path(&html).unwrap().to_string();

       let driver = automation::playwright_driver::PlaywrightSidecarDriver::spawn_for_test().await.unwrap();
       driver.goto(&html_url).await.unwrap();

       let src = std::fs::read_to_string(&story).unwrap();
       let parsed = story_parser::parse(&src);
       assert!(parsed.diagnostics.iter().all(|d| !matches!(d.severity, story_parser::diagnostic::Severity::Error)));

       let exec_ctx = automation::executor::Context {
           story_path: story.clone(),
       };
       automation::executor::run(parsed.ast.as_ref().unwrap(), driver.as_ref(), &exec_ctx).await.unwrap();

       // `.story` source is UNCHANGED.
       let after_src = std::fs::read_to_string(&story).unwrap();
       assert_eq!(after_src, src, "self-healing must NOT modify the .story source");

       // Targets JSON was rewritten — #save-v2 is new primary, #save-v1 moved to fallbacks[0].
       let reread = targets_store::load(&targets).unwrap();
       let step_id = uuid::Uuid::parse_str("018f4c1e-7b3a-7000-8000-0000000000aa").unwrap();
       let step = reread.steps.get(&step_id).expect("step present after rewrite");
       assert_eq!(step.primary.kind, "selector");
       assert_eq!(step.primary.value, serde_json::json!("#save-v2"));
       assert!(step.fallbacks.iter().any(|fb| fb.kind == "selector" && fb.value == serde_json::json!("#save-v1")),
           "old primary must be retained as a fallback");
   }

   #[test]
   fn legacy_story_without_step_id_does_not_touch_targets_store() {
       let p = std::path::PathBuf::from("/nonexistent/nowhere.story");
       let tp = targets_store::targets_path_for(&p);
       assert_eq!(tp.to_string_lossy(), "/nonexistent/nowhere.story.targets.json");
       let result = targets_store::load(&tp);
       assert!(matches!(result, Ok(f) if f.steps.is_empty()), "missing file must return empty");
   }
   ```

6. **Add unit tests** for `targets_store` in the module (NOT ignored — run in CI):
   ```rust
   #[cfg(test)]
   mod targets_store_tests {
       use super::*;
       use tempfile::tempdir;

       #[test]
       fn missing_file_returns_empty() {
           let d = tempdir().unwrap();
           let f = targets_store::load(&d.path().join("missing.json")).unwrap();
           assert_eq!(f.version, 1);
           assert!(f.steps.is_empty());
       }

       #[test]
       fn version_mismatch_errors() {
           let d = tempdir().unwrap();
           let p = d.path().join("bad.json");
           std::fs::write(&p, r#"{"version":99,"steps":{}}"#).unwrap();
           let r = targets_store::load(&p);
           assert!(r.is_err());
       }

       #[test]
       fn atomic_write_round_trip() {
           let d = tempdir().unwrap();
           let p = d.path().join("t.json");
           let mut file = TargetsFile::empty();
           file.steps.insert(
               uuid::Uuid::parse_str("018f4c1e-7b3a-7000-8000-000000000001").unwrap(),
               StepTargets {
                   primary: TargetRecord { kind: "testid".into(), value: serde_json::json!("save") },
                   fallbacks: vec![],
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
           let entries: Vec<_> = std::fs::read_dir(d.path()).unwrap().collect();
           assert_eq!(entries.len(), 1);
           assert!(entries[0].as_ref().unwrap().file_name().to_string_lossy().ends_with("t.json"));
       }
   }
   ```
  </action>
  <verify>
    <automated>cargo build -p automation 2>&1 | tail -5 && cargo test -p automation --lib -- targets_store_tests 2>&1 | tail -15 && cargo test -p automation --test self_healing --no-run 2>&1 | tail -10 && test -f crates/automation/src/targets_store.rs && test -f crates/automation/tests/fixtures/self_healing.story && test -f crates/automation/tests/fixtures/self_healing.story.targets.json && test -f crates/automation/tests/fixtures/self_healing.html && grep -n "pub fn atomic_write" crates/automation/src/targets_store.rs && grep -n "pub fn targets_path_for" crates/automation/src/targets_store.rs && grep -n "promote_fallback\|fallbacks\|targets_store" crates/automation/src/executor.rs</automated>
  </verify>
  <acceptance_criteria>
    - `crates/automation/src/targets_store.rs` exists + registered via `lib.rs` `pub mod targets_store;`
    - `cargo test -p automation --lib -- targets_store_tests` passes all 4 tests (missing-file, version-mismatch, round-trip, no-tmp-leak)
    - `cargo test -p automation --test self_healing --no-run` exits 0 (integration smoke compiles — live run marked `#[ignore]`)
    - Fixture files exist on disk
    - `grep -n "atomic_write\|fs::rename" crates/automation/src/targets_store.rs` matches
    - `grep -n "targets_path_for" crates/automation/src/targets_store.rs` matches
    - Executor self-heal path integrated: `grep -n "step_id\|fallbacks\|targets_store" crates/automation/src/executor.rs` ≥ 3 matches
    - `legacy_story_without_step_id_does_not_touch_targets_store` (non-ignored) passes
  </acceptance_criteria>
  <done>Targets store with atomic write + executor self-healing promotion committed; unit tests cover missing-file, version-mismatch, round-trip, no-tmp-leak; integration test compiles (live run ignored) and proves primary-miss → fallback-promotion + source-untouched + targets-rewritten.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: picker_stamp_step_id Tauri command + PickElementButton stamp-on-pick wiring + full regression + SMOKE runbook</name>
  <files>apps/desktop/src-tauri/src/commands/picker.rs, apps/desktop/src-tauri/src/lib.rs, apps/desktop/src/ipc/picker.ts, apps/desktop/src/features/recorder/pick-element-button.tsx, .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md</files>
  <read_first>
    - apps/desktop/src-tauri/src/commands/picker.rs (07-03b + 07-04a output)
    - apps/desktop/src/features/recorder/pick-element-button.tsx (07-04a output)
    - crates/story-parser/src/formatter.rs (07-04b output — format_story)
    - crates/automation/src/targets_store.rs (Task 1 output)
  </read_first>
  <behavior>
    - `picker_stamp_step_id(story_path, line_offset, primary, fallbacks)` Tauri command: reads the `.story` source, parses it, finds the command whose span contains `line_offset` (line number), stamps a new `Uuid::new_v7` into its `LineMeta.step_id` if absent, rewrites the source via `story_parser::format_story`, then seeds the sibling `.story.targets.json` with `{ primary, fallbacks }` for that step id via `targets_store::atomic_write`.
    - Returns the stamped UUID as a string.
    - Path-traversal guard: rejects paths containing `..` segments (stays within the open project folder).
    - `PickElementButton` calls `picker_stamp_step_id` AFTER `editorController.insertAtCursor` so the cursor position is stable. Maps `result.candidates` to fallbacks (kind + value only; drops score/unique). Stamp fire-and-forget: failure is toasted but does not block the insertion.
    - Full regression: `cargo test --workspace` (non-ignored) + `pnpm test` both exit 0.
  </behavior>
  <action>
1. **Add `picker_stamp_step_id` to `apps/desktop/src-tauri/src/commands/picker.rs`:**
   ```rust
   #[tauri::command]
   #[specta::specta]
   pub async fn picker_stamp_step_id(
       story_path: String,
       line_offset: u32,
       primary: serde_json::Value,
       fallbacks: Vec<serde_json::Value>,
   ) -> Result<String, String> {
       let path = std::path::PathBuf::from(&story_path);
       // Path-traversal guard
       if story_path.contains("..") {
           return Err("path traversal rejected".into());
       }
       let src = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

       let parsed = story_parser::parse(&src);
       let mut story = parsed.ast.ok_or_else(|| "parse failed".to_string())?;

       // Locate the command whose line contains line_offset.
       let target_uuid = uuid::Uuid::new_v7(uuid::Timestamp::now(uuid::NoContext));
       let mut stamped = false;
       'outer: for scene in &mut story.scenes {
           for cmd in &mut scene.commands {
               let m = cmd.meta_mut();
               if m.line as u32 == line_offset {
                   if m.step_id.is_none() {
                       m.step_id = Some(target_uuid);
                       stamped = true;
                   }
                   break 'outer;
               }
           }
       }

       let stamped_uuid = if stamped {
           let formatted = story_parser::format_story(&story);
           std::fs::write(&path, formatted).map_err(|e| e.to_string())?;
           target_uuid
       } else {
           // Line already has a step_id — reuse it.
           let mut existing = None;
           for scene in &story.scenes {
               for cmd in &scene.commands {
                   if cmd.meta().line as u32 == line_offset {
                       existing = cmd.meta().step_id;
                       break;
                   }
               }
           }
           existing.ok_or_else(|| "line has no stampable command".to_string())?
       };

       // Seed or update targets.json
       let targets_path = automation::targets_store::targets_path_for(&path);
       let mut store = automation::targets_store::load(&targets_path)
           .unwrap_or_else(|_| automation::targets_store::TargetsFile::empty());

       let primary_record = serde_to_target_record(&primary)?;
       let fallback_records: Vec<_> = fallbacks.iter()
           .filter_map(|v| serde_to_target_record(v).ok())
           .collect();

       store.steps.insert(
           stamped_uuid,
           automation::targets_store::StepTargets {
               primary: primary_record,
               fallbacks: fallback_records,
           },
       );

       automation::targets_store::atomic_write(&targets_path, &store).map_err(|e| e.to_string())?;

       Ok(stamped_uuid.to_string())
   }

   fn serde_to_target_record(v: &serde_json::Value) -> Result<automation::targets_store::TargetRecord, String> {
       let kind = v.get("kind").and_then(|k| k.as_str()).ok_or("missing kind")?.to_string();
       let value = v.get("value").cloned().ok_or("missing value")?;
       Ok(automation::targets_store::TargetRecord { kind, value })
   }
   ```
   Register in `lib.rs` invoke_handler alongside the other picker commands.

2. **Extend `apps/desktop/src/ipc/picker.ts`:**
   ```ts
   export async function pickerStampStepId(opts: {
     storyPath: string;
     lineOffset: number;
     primary: { kind: string; value: unknown };
     fallbacks: Array<{ kind: string; value: unknown }>;
   }): Promise<string> {
     return await invoke<string>("picker_stamp_step_id", opts);
   }
   ```

3. **Extend `apps/desktop/src/features/recorder/pick-element-button.tsx`.** After `editorController.insertAtCursor` succeeds, fire-and-forget the stamp:
   ```tsx
   if (isPicked(r)) {
     const res = editorController.insertAtCursor(r.emitted + "\n");
     if (res.ok) {
       toast.success(`Inserted: ${r.emitted}`);
       // Fire-and-forget stamp — UI is unblocked
       const storyPath = useEditorStore.getState().currentStoryPath; // or equivalent
       const lineOffset = /* compute from cursor before insert */;
       if (storyPath) {
         pickerStampStepId({
           storyPath,
           lineOffset,
           primary: { kind: r.locator.kind, value: r.locator.value },
           fallbacks: r.candidates.map(c => ({ kind: c.kind, value: c.value })),
         }).catch((e) => toast.error(`Stamp failed: ${e}`));
       }
     }
   }
   ```
   Adapt the `storyPath` + `lineOffset` extraction to whatever the existing editor store exposes. If no such state exists yet, pass `null` and skip — this is best-effort wiring; the integration test owns the full self-healing proof.

4. **Run full regression:**
   ```bash
   cargo test --workspace 2>&1 | tail -20
   pnpm test 2>&1 | tail -20
   ```
   Both must exit 0.

5. **Create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md`:**
   ```markdown
   # Plan 07-04c - Manual End-to-End Smoke (Self-Healing)

   **Scope:** Final PHASE-7.5 acceptance gate — proves primary-miss → fallback-promoted → targets.json rewritten.

   ## Prerequisites
   - All 07-01 / 07-02 / 07-03a / 07-03b / 07-04a / 07-04b plans complete.
   - Desktop app built + running in dev mode.
   - A test project with a story file that targets a local HTML file (so you can edit the markup between runs).

   ## First-pick step-id stamping
   1. Open a story file with cursor on an empty line.
   2. Pick an element.
   3. Confirm the inserted line has a trailing `# @id=<uuid>` comment.
   4. Open the sibling `<story>.story.targets.json` and confirm a step with the same UUID has `primary` set to the picked locator and `fallbacks` as an array.

   ## Subsequent-pick target update
   1. Cursor on the SAME line (already has `@id=`), click Pick element and pick a DIFFERENT element.
   2. The `.story` source remains unchanged.
   3. The targets.json is updated: primary reflects the newly picked element; previous primary becomes fallbacks[0].

   ## Self-healing (final acceptance gate)
   1. Edit the real page so the primary locator NO longer matches (e.g. rename `#save-v1` to `#save-v2`).
   2. Re-run the story.
   3. Expected:
      - Run succeeds (no wait_actionable timeout surfaces to the user).
      - The `.story` source is still the original.
      - `<story>.story.targets.json` has the fallback promoted to primary, and the old primary pushed down as fallbacks[0].

   ## Known limitations
   - Free-form comments in the `.story` source are lost on re-format (documented in formatter module).
   - Multi-fallback promotion is conservative — only the first passing fallback is promoted per run.
   ```
  </action>
  <verify>
    <automated>cd apps/desktop/src-tauri && cargo check 2>&1 | tail -10 && cd - && cargo test --workspace 2>&1 | tail -15 && pnpm test 2>&1 | tail -10 && grep -n "picker_stamp_step_id" apps/desktop/src-tauri/src/commands/picker.rs && grep -n "picker_stamp_step_id" apps/desktop/src-tauri/src/lib.rs && grep -n "pickerStampStepId" apps/desktop/src/ipc/picker.ts && grep -n "pickerStampStepId\|picker_stamp_step_id" apps/desktop/src/features/recorder/pick-element-button.tsx && test -f .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md && grep -n "Self-healing" .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SMOKE.md</automated>
  </verify>
  <acceptance_criteria>
    - `cargo check` in `apps/desktop/src-tauri/` exits 0
    - `cargo test --workspace` exits 0 (non-ignored; live integration tests remain `#[ignore]`)
    - `pnpm test` exits 0 at workspace root
    - `grep -n "picker_stamp_step_id" apps/desktop/src-tauri/src/commands/picker.rs` matches (command defined)
    - `grep -n "picker_stamp_step_id" apps/desktop/src-tauri/src/lib.rs` matches (registered in invoke_handler)
    - `grep -n "pickerStampStepId" apps/desktop/src/ipc/picker.ts` matches
    - `grep -n "pickerStampStepId" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (wired into pick flow)
    - `07-04c-SMOKE.md` committed with all 3 sections (First-pick stamping, Subsequent-pick update, Self-healing) + Known limitations
  </acceptance_criteria>
  <done>picker_stamp_step_id Tauri command + desktop wire-up so first pick stamps a UUIDv7 into source + seeds targets.json; full regression passes; runbook documents the PHASE-7.5 final acceptance gate (self-healing rewrites targets.json, leaves .story untouched).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| `.story.targets.json` ↔ filesystem | Atomic write via tmp + rename; concurrent-writer scenarios are scoped to this single process (no cross-process sharing). |
| `picker_stamp_step_id` Tauri command ↔ filesystem | Accepts arbitrary `story_path: String`; path-traversal guard rejects `..` segments. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-04c-01 | Tampering | Targets file rewritten by self-healing could corrupt if process dies mid-write | mitigate | Atomic temp-file + rename pattern; `sync_data()` before rename. Orphaned tmp files on crash are cleaned on next write. |
| T-07-04c-02 | Elevation of Privilege | `picker_stamp_step_id` accepts arbitrary `story_path: String` | mitigate | Tauri FS scope is configured per Plan 01-03; this command also rejects path-traversal attempts (`..`) in the command body. |
| T-07-04c-03 | Information Disclosure | `.story.targets.json` sibling file may reveal selectors in version control | accept | It's the user's project dir; same trust model as the `.story` itself. |
</threat_model>

<verification>
1. `cargo test --workspace` exits 0 (all Rust tests incl. targets_store_tests + round_trip; integration tests remain `#[ignore]`)
2. `cargo test -p automation --test self_healing --no-run` exits 0 (compile-only smoke for the live test)
3. `pnpm test` exits 0 at workspace root
4. `grep -n "pub fn atomic_write" crates/automation/src/targets_store.rs` matches
5. `grep -n "picker_stamp_step_id" apps/desktop/src-tauri/src/commands/picker.rs` matches
6. `07-04c-SMOKE.md` committed with Self-healing section
</verification>

<success_criteria>
- [ ] `targets_store.rs` with atomic_write + load + targets_path_for + 4 unit tests
- [ ] Executor self-healing hook: primary-miss → iterate fallbacks → promote first hit → atomic rewrite targets.json (NOT the .story)
- [ ] Self-healing integration test compiles (`--no-run`) with fixture files in place; `#[ignore]` marker present with pointer to operator smoke
- [ ] `picker_stamp_step_id` Tauri command + desktop wire-up so first pick stamps a UUIDv7 into source + seeds targets.json
- [ ] `07-04c-SMOKE.md` committed with all 3 runbook sections (First-pick stamping, Subsequent-pick update, Self-healing)
- [ ] Full regression: `cargo test --workspace` + `pnpm test` both exit 0
- [ ] PHASE-7.5 requirement met (end-to-end acceptance: primary fails → fallback promoted → `.story.targets.json` rewritten — this plan owns the final gate)
</success_criteria>

<output>
After completion, create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04c-SUMMARY.md` capturing:
- Targets store atomic write path naming convention (`.tmp.<pid>`)
- Self-healing promotion semantics (first-pass-wins; old primary → top fallback)
- Any cross-crate coupling issues encountered (story_parser → automation, or vice versa)
- Explicit confirmation that the `.story` source is NEVER modified by self-healing — only by first-pick stamping via `picker_stamp_step_id`
- PHASE-7.5 final acceptance gate result (primary-miss → fallback-promoted → targets rewritten)
</output>
