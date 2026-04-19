//! Author-time snapshot store + selector validator IPC.
//!
//! The editor hovers a DSL step → the renderer asks "do I have a snapshot
//! for this Navigate's URL?" If yes, run `SmartSelector::validate_against_dom`
//! and return the chip status + bbox; if no, the UI renders a GREY chip
//! with a "Refresh snapshot" action that invokes `author_snapshot_capture`.
//!
//! ## On-disk layout
//!
//! Snapshots live under `<project-dir>/.story.snapshots/`:
//!
//! ```text
//! <project>/.story.snapshots/
//!   <sha256(url)>.json       ← {url, domHash, capturedAt, innerHTMLRef}
//!   <sha256(url)>.html       ← full innerHTML (split to keep JSON small)
//!   <sha256(url)>.png        ← screenshot
//! ```
//!
//! The URL hash keys the entry so the exact URL string is never written
//! into filesystem paths (avoids OS path-char restrictions + keeps
//! access-log cardinality bounded).
//!
//! ## Commands
//!
//! - `author_snapshot_capture({ project_dir, url })` — call sidecar,
//!   persist the three files, return the manifest entry.
//! - `author_snapshot_get({ project_dir, url })` — load-or-None.
//! - `author_snapshot_list({ project_dir })` — enumerate manifest files.
//! - `author_snapshot_validate({ project_dir, url, target_json })` —
//!   run the Rust-side validator against the cached HTML and return the
//!   typed `ValidationResult`.

use crate::error::AppError;
use crate::state::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

const SNAPSHOT_DIR_NAME: &str = ".story.snapshots";

/// Manifest entry persisted alongside the HTML + PNG snapshot files.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AuthorSnapshotEntry {
    /// Original URL this snapshot was captured for.
    pub url: String,
    /// SHA-256(innerHTML) — cheap staleness check for the UI.
    pub dom_hash: String,
    /// ISO-8601 when the snapshot was captured.
    pub captured_at: String,
    /// Absolute path to the saved PNG.
    pub screenshot_path: String,
    /// Absolute path to the saved innerHTML text file.
    pub html_path: String,
}

/// Validator status for one DSL step target against the cached snapshot DOM.
/// Shape mirrors `automation::ValidationResult` so the renderer can pattern
/// match on `status` directly.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthorValidationDto {
    Unique { strategy: String },
    Fuzzy { count: u32, reason: String },
    None,
    NoSnapshot,
}

impl From<automation::ValidationResult> for AuthorValidationDto {
    fn from(v: automation::ValidationResult) -> Self {
        match v {
            automation::ValidationResult::Unique { strategy } => Self::Unique {
                strategy: strategy.as_str().to_string(),
            },
            automation::ValidationResult::Fuzzy { count, reason } => Self::Fuzzy {
                count: count as u32,
                reason,
            },
            automation::ValidationResult::None => Self::None,
        }
    }
}

/// SHA-256 hex digest of a URL string — used as the filename stem for
/// the snapshot trio (`.json`/`.html`/`.png`).
fn url_key(url: &str) -> String {
    util::sha256_hex(&[url.as_bytes()])
}

/// Validate that `project_dir` is absolute and does NOT contain `..`
/// segments. Defense-in-depth against a misconfigured Tauri FS scope —
/// the UI should only ever pass the open project folder.
fn guard_project_dir(project_dir: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(project_dir);
    if !path.is_absolute() {
        return Err(AppError::Automation(format!(
            "project_dir must be absolute: {project_dir}"
        )));
    }
    if project_dir.split(['/', '\\']).any(|s| s == "..") {
        return Err(AppError::Automation(
            "path traversal rejected: project_dir contains '..'".into(),
        ));
    }
    Ok(path)
}

fn snapshot_dir(project_dir: &str) -> Result<PathBuf, AppError> {
    let root = guard_project_dir(project_dir)?;
    Ok(root.join(SNAPSHOT_DIR_NAME))
}

/// capture a fresh snapshot for `url`, persist the trio
/// under `<project>/.story.snapshots/`, return the manifest entry.
///
/// Requires the Playwright sidecar to be launched (via
/// `launch_automation`) — the capture routes to the SAME driver handle
/// but calls the dedicated `captureSnapshot` verb that the sidecar
/// implements against a SEPARATE browser context.
#[tauri::command]
#[specta::specta]
pub async fn author_snapshot_capture(
    state: State<'_, AppState>,
    project_dir: String,
    url: String,
) -> Result<AuthorSnapshotEntry, AppError> {
    let dir = snapshot_dir(&project_dir)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Automation(format!("create {}: {e}", dir.display())))?;

    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref().cloned().ok_or_else(|| {
            AppError::Automation(
                "Playwright sidecar not launched — start a recording session first".into(),
            )
        })?
    };
    let d = driver.lock().await;
    let resp = d
        .capture_snapshot(&url, None, Some(15_000))
        .await
        .map_err(|e| AppError::Automation(format!("captureSnapshot: {e}")))?;
    drop(d);

    let key = url_key(&url);
    let html_path = dir.join(format!("{key}.html"));
    let png_path = dir.join(format!("{key}.png"));
    let manifest_path = dir.join(format!("{key}.json"));

    std::fs::write(&html_path, &resp.inner_html)
        .map_err(|e| AppError::Automation(format!("write html {}: {e}", html_path.display())))?;

    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(&resp.screenshot_base64)
        .map_err(|e| AppError::Automation(format!("decode screenshot: {e}")))?;
    std::fs::write(&png_path, &png_bytes)
        .map_err(|e| AppError::Automation(format!("write png {}: {e}", png_path.display())))?;

    let entry = AuthorSnapshotEntry {
        url: resp.url,
        dom_hash: resp.dom_hash,
        captured_at: resp.captured_at,
        screenshot_path: png_path.to_string_lossy().into_owned(),
        html_path: html_path.to_string_lossy().into_owned(),
    };
    let manifest_json = serde_json::to_vec_pretty(&entry)
        .map_err(|e| AppError::Automation(format!("encode manifest: {e}")))?;
    std::fs::write(&manifest_path, &manifest_json).map_err(|e| {
        AppError::Automation(format!("write manifest {}: {e}", manifest_path.display()))
    })?;

    Ok(entry)
}

/// return the manifest entry for `url` if one exists.
/// Missing → `Ok(None)`. Corrupt JSON → `Err(AppError::Automation)`.
#[tauri::command]
#[specta::specta]
pub async fn author_snapshot_get(
    project_dir: String,
    url: String,
) -> Result<Option<AuthorSnapshotEntry>, AppError> {
    let dir = snapshot_dir(&project_dir)?;
    let manifest = dir.join(format!("{}.json", url_key(&url)));
    let raw = match std::fs::read_to_string(&manifest) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(AppError::Automation(format!(
                "read {}: {e}",
                manifest.display()
            )))
        }
    };
    let entry: AuthorSnapshotEntry = serde_json::from_str(&raw)
        .map_err(|e| AppError::Automation(format!("decode {}: {e}", manifest.display())))?;
    Ok(Some(entry))
}

/// enumerate every stored snapshot for `project_dir`.
/// Skips malformed manifests (logged at debug) rather than erroring the
/// whole list — one corrupt file shouldn't black out the UI.
#[tauri::command]
#[specta::specta]
pub async fn author_snapshot_list(
    project_dir: String,
) -> Result<Vec<AuthorSnapshotEntry>, AppError> {
    let dir = snapshot_dir(&project_dir)?;
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::Automation(format!(
                "read_dir {}: {e}",
                dir.display()
            )))
        }
    };
    let mut out = Vec::new();
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        match serde_json::from_str::<AuthorSnapshotEntry>(&raw) {
            Ok(e) => out.push(e),
            Err(e) => {
                tracing::debug!(
                    target: "storycapture::author_snapshot",
                    "skipping malformed manifest {}: {e}",
                    path.display()
                );
            }
        }
    }
    Ok(out)
}

/// validate a parsed DSL target against the cached snapshot
/// DOM. Returns `NoSnapshot` if no snapshot exists for `url`; otherwise
/// projects the Rust-side `ValidationResult` onto the wire DTO.
///
/// `target` is a typed mirror of `story_parser::SelectorOrText` —
/// see `commands::parse::SelectorOrTextDto` (carries Tier 1 `Role`
/// with structured `{ role, name }` fields rather than a packed string).
#[tauri::command]
#[specta::specta]
pub async fn author_snapshot_validate(
    project_dir: String,
    url: String,
    target: super::parse::SelectorOrTextDto,
) -> Result<AuthorValidationDto, AppError> {
    let target = target
        .into_selector_or_text()
        .map_err(AppError::Automation)?;

    let dir = snapshot_dir(&project_dir)?;
    let html_path = dir.join(format!("{}.html", url_key(&url)));
    let html = match std::fs::read_to_string(&html_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AuthorValidationDto::NoSnapshot);
        }
        Err(e) => {
            return Err(AppError::Automation(format!(
                "read {}: {e}",
                html_path.display()
            )))
        }
    };

    let result = automation::SmartSelector::validate_against_dom(&target, &html);
    Ok(result.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn url_key_is_deterministic_sha256() {
        let a = url_key("https://example.com/");
        let b = url_key("https://example.com/");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn guard_rejects_relative_path() {
        assert!(guard_project_dir("relative/path").is_err());
    }

    #[test]
    fn guard_rejects_parent_traversal() {
        assert!(guard_project_dir("/abs/../escape").is_err());
    }

    #[tokio::test]
    async fn validate_returns_nosnapshot_when_missing() {
        let d = tempdir().unwrap();
        let target =
            serde_json::to_string(&story_parser::SelectorOrText::TestId("x".into())).unwrap();
        let r = author_snapshot_validate(
            d.path().to_string_lossy().to_string(),
            "https://example.com/".into(),
            target,
        )
        .await
        .unwrap();
        assert!(matches!(r, AuthorValidationDto::NoSnapshot));
    }

    #[tokio::test]
    async fn validate_runs_against_cached_html() {
        let d = tempdir().unwrap();
        let dir = d.path().join(SNAPSHOT_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let url = "https://example.com/app";
        let key = url_key(url);
        let html = r#"<html><body><button data-testid="save">Save</button></body></html>"#;
        std::fs::write(dir.join(format!("{key}.html")), html).unwrap();

        // SelectorOrText uses tag "kind" with serde rename_all = "kebab-case" →
        // TestId serializes as {"kind":"test-id","value":"save"}.
        let target_json = serde_json::to_string(&story_parser::SelectorOrText::TestId(
            "save".into(),
        ))
        .unwrap();
        let r = author_snapshot_validate(
            d.path().to_string_lossy().to_string(),
            url.into(),
            target_json,
        )
        .await
        .unwrap();
        match r {
            AuthorValidationDto::Unique { strategy } => assert_eq!(strategy, "testid"),
            other => panic!("expected Unique, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn get_returns_none_when_missing() {
        let d = tempdir().unwrap();
        let r = author_snapshot_get(
            d.path().to_string_lossy().to_string(),
            "https://example.com/".into(),
        )
        .await
        .unwrap();
        assert!(r.is_none());
    }

    #[tokio::test]
    async fn list_returns_empty_when_no_dir() {
        let d = tempdir().unwrap();
        let r = author_snapshot_list(d.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn list_skips_non_json_and_malformed() {
        let d = tempdir().unwrap();
        let dir = d.path().join(SNAPSHOT_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("not-json.txt"), "hello").unwrap();
        std::fs::write(dir.join("bad.json"), "not valid json").unwrap();
        // One good entry.
        let good = AuthorSnapshotEntry {
            url: "https://x/".into(),
            dom_hash: "abc".into(),
            captured_at: "2026-04-17T00:00:00Z".into(),
            screenshot_path: "/tmp/x.png".into(),
            html_path: "/tmp/x.html".into(),
        };
        std::fs::write(
            dir.join("ok.json"),
            serde_json::to_vec_pretty(&good).unwrap(),
        )
        .unwrap();

        let r = author_snapshot_list(d.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://x/");
    }
}
