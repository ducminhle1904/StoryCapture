// element-picker Tauri commands.
//
// Routes `picker_start` / `picker_cancel` / `picker_is_active` to the
// shared `PlaywrightSidecarDriver` populated by `launch_automation` in
// `AppState::playwright_driver`. The desktop UI (PickElementButton)
// disables itself unless `picker_is_active` confirms the sidecar is
// alive, so the "no driver" branch is reachable only via races at
// session-end.

use crate::author_driver::{AuthorDriverRegistry, AuthorDriverState, PickerResumeGuard, StreamId};
use crate::error::AppError;
use crate::state::AppState;
use async_trait::async_trait;
use automation::PickElementResponse;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

/// Per-URL ceiling for navigate-replay warm-up. The outer `timeout_ms`
/// (default 60s) backstops the entire picker run; this bound prevents
/// a single hung navigation (DNS stall, slow CDN, redirect loop) from
/// burning that whole budget before the user can even start clicking.
/// Replay is best-effort, so a per-URL timeout is logged-and-skipped,
/// not propagated.
const NAVIGATE_REPLAY_PER_URL_TIMEOUT: Duration = Duration::from_secs(5);

/// Typed mirror of `automation::targets_store::TargetRecord`. Each kind
/// fully specifies its `value` shape (string for most, `{ role, name }`
/// object for `role`) so specta can derive a real TS discriminated union
/// — the picker IPC no longer needs a JSON-string envelope.
///
/// On-the-wire shape per arm: `{ kind: "<kind>", value: <typed>, nth?: number }`
/// — matches the `.story.targets.json` schema byte-for-byte. The optional
/// `nth` field is 1-indexed and skipped on the wire when absent so legacy
/// stamps round-trip unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TargetRecordDto {
    Testid {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    Role {
        value: super::parse::RoleSelectorDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    Label {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    TextExact {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    Selector {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    Aria {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
    Text {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nth: Option<u32>,
    },
}

/// Return shape of `picker_stamp_step_id`. Splits the stamped UUID from
/// the stamping outcome so the renderer can dispatch UI-SPEC-locked
/// first-pick vs re-pick toasts without re-parsing the .story source.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PickerStampResultDto {
    /// UUIDv7 as a hyphenated string (matches existing on-the-wire shape).
    pub step_id: String,
    /// true iff the None-arm fired — fresh UUID minted AND source rewritten.
    /// false iff the line already carried `# @id=<uuid>`.
    pub was_freshly_stamped: bool,
}

impl From<TargetRecordDto> for automation::targets_store::TargetRecord {
    fn from(d: TargetRecordDto) -> Self {
        let (kind, value, nth) = match d {
            TargetRecordDto::Testid { value, nth } => {
                ("testid", serde_json::Value::String(value), nth)
            }
            TargetRecordDto::Role { value, nth } => (
                "role",
                serde_json::json!({ "role": value.role, "name": value.name }),
                nth,
            ),
            TargetRecordDto::Label { value, nth } => {
                ("label", serde_json::Value::String(value), nth)
            }
            TargetRecordDto::TextExact { value, nth } => {
                ("text_exact", serde_json::Value::String(value), nth)
            }
            TargetRecordDto::Selector { value, nth } => {
                ("selector", serde_json::Value::String(value), nth)
            }
            TargetRecordDto::Aria { value, nth } => ("aria", serde_json::Value::String(value), nth),
            TargetRecordDto::Text { value, nth } => ("text", serde_json::Value::String(value), nth),
        };
        automation::targets_store::TargetRecord {
            kind: kind.to_string(),
            value,
            nth,
        }
    }
}

/// Tauri / specta DTO wrapping `automation::PickElementResponse` as a
/// JSON string. The `automation` crate is pure-Rust (no Tauri / specta
/// deps), so we serialize at the boundary and let the TS wrapper
/// (`apps/desktop/src/ipc/picker.ts`) parse the typed union. Mirrors
/// the `AutomationEvent { json }` pattern.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PickElementResponseDto {
    /// JSON-stringified `automation::PickElementResponse`.
    pub json: String,
}

impl From<automation::PickElementResponse> for PickElementResponseDto {
    fn from(r: automation::PickElementResponse) -> Self {
        Self {
            json: serde_json::to_string(&r).unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// Start an element-picker session against the in-flight Playwright
/// sidecar. Returns the ranked DSL line (`emitted`) on a successful
/// pick, or a `Cancelled` variant on Esc / navigation / unsupported
/// URL / timeout. Wire contract — `emitted: String` — matches the
/// sidecar `pickElement.start` response.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "picker_start"), err(Debug))]
pub async fn picker_start(
    state: State<'_, AppState>,
    timeout_ms: u64,
) -> Result<PickElementResponseDto, AppError> {
    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref()
            .cloned()
            .ok_or_else(|| AppError::Automation("Playwright sidecar not launched".into()))?
    };
    let d = driver.lock().await;
    let r = d
        .pick_element_start(timeout_ms)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(r.into())
}

/// Cancel an in-flight pickElement session. Idempotent — no-op when no
/// session is active. The sidecar will resolve any pending start with
/// `{ cancelled: true, reason: "user-cancel" }`.
///
/// Routes by FSM state: when the registry reports `Picking { stream_id }`,
/// the in-flight pick belongs to that author session and we must cancel on
/// `author_preview_sessions[stream_id].driver` — the recorder-path
/// `playwright_driver` is a different sidecar process and would silently
/// drop the cancel. The recorder driver is only consulted as a fallback for
/// the legacy recorder-path `picker_start` flow (FSM not in Picking state).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "picker_cancel"), err(Debug))]
pub async fn picker_cancel(
    state: State<'_, AppState>,
    registry: State<'_, Arc<AuthorDriverRegistry>>,
) -> Result<(), AppError> {
    let picking_stream_id = {
        let s = registry.state.lock().await;
        match &*s {
            AuthorDriverState::Picking { stream_id, .. } => Some(stream_id.clone()),
            _ => None,
        }
    };

    if let Some(stream_id) = picking_stream_id {
        let driver_arc = {
            let sessions = state.author_preview_sessions.lock().await;
            sessions.get(&stream_id).map(|s| s.driver.clone())
        };
        match driver_arc {
            Some(driver) => {
                tracing::debug!(
                    target: "storycapture::picker",
                    stream_id = %stream_id,
                    "picker_cancel routed to author session",
                );
                driver
                    .pick_element_cancel()
                    .await
                    .map_err(|e| AppError::Automation(e.to_string()))?;
            }
            None => {
                tracing::warn!(
                    target: "storycapture::picker",
                    stream_id = %stream_id,
                    "picker_cancel: FSM Picking but author session entry missing — \
                     teardown race, returning idempotent no-op",
                );
            }
        }
        return Ok(());
    }

    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref().cloned()
    };
    match driver {
        Some(driver) => {
            let d = driver.lock().await;
            d.pick_element_cancel()
                .await
                .map_err(|e| AppError::Automation(e.to_string()))?;
        }
        None => {
            tracing::debug!(
                target: "storycapture::picker",
                "picker_cancel: no FSM pick and no recorder driver — no-op",
            );
        }
    }
    Ok(())
}

/// True iff a pickElement session is currently waiting for a click.
/// Returns `false` when no sidecar is launched (rather than erroring) so
/// the UI can poll cheaply.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "picker_is_active"), err(Debug))]
pub async fn picker_is_active(state: State<'_, AppState>) -> Result<bool, AppError> {
    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref().cloned()
    };
    match driver {
        Some(driver) => {
            let d = driver.lock().await;
            d.pick_element_is_active()
                .await
                .map_err(|e| AppError::Automation(e.to_string()))
        }
        None => Ok(false),
    }
}

/// stamp a UUIDv7 step id onto a picked `.story` line AND
/// seed the sibling `.story.targets.json` with the pick's primary +
/// fallback locators. Called fire-and-forget by `PickElementButton`
/// after a successful pick.
///
/// ## Protocol
///
/// 1. Read the `.story` source; parse via `story_parser::parse`.
/// 2. Locate the command whose `LineMeta.line` matches `line_offset`
///    (1-indexed). If already stamped, reuse its existing step id
///    (idempotent — re-picking the same line updates the targets JSON
///    without regenerating the UUID).
/// 3. If the line needs a fresh id, generate a `Uuid::now_v7`, set it on
///    the `Command`, re-serialize with `story_parser::format_story`, and
///    write back to the same path.
/// 4. Load (or create) the sibling `<story>.story.targets.json`, upsert
///    the step's `{ primary, fallbacks }` record, atomically write it
///    back via `targets_store::atomic_write`.
/// 5. Return the stamped UUID as a string.
///
/// ## Security
///
/// Rejects `story_path` that contains `..` (path-traversal guard). The
/// Tauri FS scope is still the primary boundary; this check is
/// defense-in-depth against a misconfigured scope or future refactor.
///
/// ## Error mapping
///
/// `AppError::Automation` carries the underlying parse / io / protocol
/// error as a string — the renderer toasts it without blocking the
/// pick flow (fire-and-forget semantics on the UI side).
/// `primary` and `fallbacks` are typed `TargetRecordDto`s — see below.
/// The shape mirrors `automation::targets_store::TargetRecord` exactly
/// so the TS caller passes a real discriminated union, not a stringified
/// envelope.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "picker_stamp_step_id"),
    err(Debug)
)]
pub async fn picker_stamp_step_id(
    story_path: String,
    line_offset: u32,
    primary: TargetRecordDto,
    fallbacks: Vec<TargetRecordDto>,
) -> Result<PickerStampResultDto, AppError> {
    stamp_step_id_impl(story_path, line_offset, primary, fallbacks)
}

/// Core stamping logic, factored out of the `#[tauri::command]` wrapper so
/// integration tests can drive it directly. Not public outside the crate
/// — the Tauri boundary is still the single external entry point.
pub fn stamp_step_id_impl(
    story_path: String,
    line_offset: u32,
    primary: TargetRecordDto,
    fallbacks: Vec<TargetRecordDto>,
) -> Result<PickerStampResultDto, AppError> {
    // Path-traversal guard. The Tauri FS scope is the
    // primary boundary; this is defense-in-depth.
    if story_path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(AppError::Automation(
            "path traversal rejected: story_path contains '..'".into(),
        ));
    }

    let path = std::path::PathBuf::from(&story_path);
    let src = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Automation(format!("read {}: {e}", path.display())))?;

    let parsed = story_parser::parse(&src);
    let mut story = parsed
        .ast
        .ok_or_else(|| AppError::Automation(format!("parse failed for {}", path.display())))?;

    // Locate command by line; if already stamped, reuse. Otherwise
    // generate a fresh UUIDv7 + rewrite the source.
    let mut existing_id: Option<uuid::Uuid> = None;
    let mut line_found = false;
    'scan: for scene in &story.scenes {
        for cmd in &scene.commands {
            if cmd.meta().line == line_offset {
                line_found = true;
                existing_id = cmd.step_id();
                break 'scan;
            }
        }
    }
    if !line_found {
        return Err(AppError::Automation(format!(
            "no command found at line {line_offset} in {}",
            path.display()
        )));
    }

    // Source bytes are rewritten ONLY on the None arm (fresh mint).
    // Re-stamp on an already-stamped line short-circuits with
    // `was_freshly_stamped=false`; targets.json is still (re)seeded.
    let (stamped_id, was_freshly_stamped) = match existing_id {
        Some(id) => (id, false),
        None => {
            let new_id = uuid::Uuid::now_v7();
            'stamp: for scene in &mut story.scenes {
                for cmd in &mut scene.commands {
                    if cmd.meta().line == line_offset {
                        cmd.set_step_id(Some(new_id));
                        break 'stamp;
                    }
                }
            }
            let formatted = story_parser::format_story(&story);
            std::fs::write(&path, formatted)
                .map_err(|e| AppError::Automation(format!("write {}: {e}", path.display())))?;
            (new_id, true)
        }
    };

    // Seed or update the sibling targets.json atomically.
    let targets_path = automation::targets_store::targets_path_for(&path);
    let mut store = automation::targets_store::load(&targets_path)
        .unwrap_or_else(|_| automation::targets_store::TargetsFile::empty());

    store.steps.insert(
        stamped_id,
        automation::targets_store::StepTargets {
            primary: primary.into(),
            fallbacks: fallbacks.into_iter().map(Into::into).collect(),
        },
    );

    automation::targets_store::atomic_write(&targets_path, &store)
        .map_err(|e| AppError::Automation(format!("targets_store write: {e}")))?;

    Ok(PickerStampResultDto {
        step_id: stamped_id.to_string(),
        was_freshly_stamped,
    })
}

/// Indirection trait for side-effects under `picker_start_author`. Production
/// wires `SidecarAuthorPreviewControl` which delegates to the real Playwright
/// sidecar; tests substitute a counter-tracking stub to exercise the D-12
/// pause/resume invariant on every exit path without a live Chromium.
#[async_trait]
pub trait AuthorPreviewControl: Send + Sync {
    async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<(), AppError>;
    async fn pause_author_preview(&self, stream_id: &str) -> Result<(), AppError>;
    async fn resume_author_preview(&self, stream_id: &str) -> Result<(), AppError>;
    async fn pick_element_start_author(
        &self,
        stream_id: &str,
        timeout_ms: u64,
    ) -> Result<PickElementResponse, AppError>;
    async fn author_current_url(&self, _stream_id: &str) -> Result<String, AppError> {
        Ok(String::new())
    }
}

/// Production adapter — holds an Arc'd per-session driver and invokes the
/// PlaywrightSidecarDriver methods directly. One instance per picker run.
///
/// NOTE: `driver` is `Arc<PlaywrightSidecarDriver>` (no outer Mutex). The
/// driver's methods use `&self` with internal fine-grained locking, so
/// `pick_element_start_author` (long-lived, up to 60 s) can run concurrently
/// with `author_dispatch_input` (60 Hz pointer forwarding from the canvas).
/// An outer Mutex would serialize them and freeze the picker overlay.
pub struct SidecarAuthorPreviewControl {
    pub driver: Arc<automation::PlaywrightSidecarDriver>,
}

#[async_trait]
impl AuthorPreviewControl for SidecarAuthorPreviewControl {
    async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<(), AppError> {
        self.driver
            .author_navigate_to(stream_id, url)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))
    }
    async fn author_current_url(&self, stream_id: &str) -> Result<String, AppError> {
        self.driver
            .author_current_url(stream_id)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))
    }
    async fn pause_author_preview(&self, stream_id: &str) -> Result<(), AppError> {
        self.driver
            .call_pause_stream(stream_id)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))
    }
    async fn resume_author_preview(&self, stream_id: &str) -> Result<(), AppError> {
        self.driver
            .call_resume_stream(stream_id)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))
    }
    async fn pick_element_start_author(
        &self,
        stream_id: &str,
        timeout_ms: u64,
    ) -> Result<PickElementResponse, AppError> {
        self.driver
            .pick_element_start_author(stream_id, timeout_ms)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))
    }
}

/// Walk `story.scenes[*].commands[*]` in document order, collect every
/// `Navigate` URL whose line is `<= cursor_line`. If no navigates appear
/// above the cursor, fall back to `story.meta.app` (single-URL list).
/// Result is the navigate-replay sequence for author-browser warm-up.
///
/// This helper is pure (no I/O) so it can be unit-tested against fixture
/// .story sources without any sidecar or Tauri plumbing.
pub fn compute_navigate_urls(story_src: &str, cursor_line: u32) -> Result<Vec<String>, AppError> {
    let parsed = story_parser::parse(story_src);
    let story = parsed
        .ast
        .ok_or_else(|| AppError::Automation("story parse failed".into()))?;
    let mut nav_urls: Vec<String> = Vec::new();
    'walk: for scene in &story.scenes {
        for cmd in &scene.commands {
            if cmd.meta().line > cursor_line {
                break 'walk;
            }
            if let story_parser::Command::Navigate { url, .. } = cmd {
                nav_urls.push(url.clone());
            }
        }
    }
    if nav_urls.is_empty() {
        if let Some(app_url) = story.meta.app.clone() {
            nav_urls.push(app_url);
        }
    }
    Ok(nav_urls)
}

/// True when the author page is "same-site" with one of the script's nav
/// URLs and the user has navigated somewhere meaningful — replay would
/// yank them back to the start page, so skip it.
///
/// Same-site is judged by host suffix after stripping a leading `www.`,
/// not by `Url::origin()`. Strict origin breaks the common subdomain-hop
/// pattern: a story with `meta.app = https://www.wikipedia.org` whose
/// flow lands the user on `https://en.wikipedia.org/wiki/...` would
/// otherwise be detected as "different site" and replayed.
///
/// `about:blank`, file://, chrome:// and parse failures all return false
/// so cold-start sessions still warm up via replay.
fn current_url_supersedes_replay(current: &str, nav_urls: &[String]) -> bool {
    let Ok(cur) = url::Url::parse(current) else {
        return false;
    };
    if !matches!(cur.scheme(), "http" | "https") {
        return false;
    }
    let Some(cur_host) = cur.host_str() else {
        return false;
    };
    nav_urls.iter().any(|nav| {
        url::Url::parse(nav)
            .ok()
            .and_then(|n| n.host_str().map(str::to_owned))
            .is_some_and(|nav_host| same_site(cur_host, &nav_host))
    })
}

/// Two hosts are "same site" if their registrable-domain-ish suffixes
/// match — `www.` is stripped, then either equality or one is a
/// subdomain of the other. Avoids pulling in a public-suffix-list dep
/// for what's a UX heuristic, not a security boundary.
fn same_site(a: &str, b: &str) -> bool {
    let a = a.strip_prefix("www.").unwrap_or(a);
    let b = b.strip_prefix("www.").unwrap_or(b);
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

/// Execute the navigate-replay sequence against `control`. Each
/// `author_navigate_to` call is best-effort: a failure (DNS, 404, timeout)
/// emits a warn log and the walk continues. The picker must not fail
/// because a single upstream nav stalled.
///
/// Replay short-circuits when the author page is already at (or past) one
/// of the script's nav URLs — see `current_url_supersedes_replay`.
pub async fn replay_navigate_verbs(
    control: &dyn AuthorPreviewControl,
    stream_id: &str,
    story_src: &str,
    cursor_line: u32,
) -> Result<(), AppError> {
    let urls = compute_navigate_urls(story_src, cursor_line)?;
    if urls.is_empty() {
        return Ok(());
    }

    if let Ok(current) = control.author_current_url(stream_id).await {
        if current_url_supersedes_replay(&current, &urls) {
            tracing::info!(
                target: "storycapture::picker",
                stream_id,
                current = %current,
                "skip navigate-replay — author page already at/past script destination",
            );
            return Ok(());
        }
    }

    for url in urls {
        match tokio::time::timeout(
            NAVIGATE_REPLAY_PER_URL_TIMEOUT,
            control.author_navigate_to(stream_id, &url),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(
                    target: "storycapture::picker",
                    error = %e,
                    url = %url,
                    stream_id,
                    "navigate replay failed — continuing",
                );
            }
            Err(_elapsed) => {
                tracing::warn!(
                    target: "storycapture::picker",
                    url = %url,
                    stream_id,
                    timeout_secs = NAVIGATE_REPLAY_PER_URL_TIMEOUT.as_secs(),
                    "navigate replay timed out — continuing",
                );
            }
        }
    }
    Ok(())
}

/// Core `picker_start_author` orchestration, factored so tests can drive it
/// with a mock `AuthorPreviewControl`. Public within the crate but not a
/// Tauri command — the thin `#[tauri::command]` wrapper below is the only
/// external entry point.
pub async fn picker_start_author_impl(
    registry: Arc<AuthorDriverRegistry>,
    control: Arc<dyn AuthorPreviewControl>,
    stream_id: StreamId,
    story_src: String,
    cursor_line: u32,
    timeout_ms: u64,
) -> Result<PickElementResponseDto, AppError> {
    // Step 1 — FSM transition: validate, then swap into Picking{resume_to}.
    // Lock is released before any awaited I/O.
    let prior_for_guard = {
        let mut g = registry.state.lock().await;
        g.can_start_pick()
            .map_err(|e| AppError::Automation(e.to_string()))?;
        let prior_snapshot = g.clone();
        g.begin_pick(stream_id.clone());
        prior_snapshot
    };

    // Step 2 — arm the RAII guard. On panic / early return / error from
    // here on, Drop restores `prior_for_guard` into the registry
    // asynchronously (uses Handle::try_current to stay shutdown-safe).
    // Disarmed on the happy path after explicit restore.
    let guard = PickerResumeGuard::new(registry.clone(), stream_id.clone(), prior_for_guard);

    // Step 3 — navigate-replay. Best-effort; individual failures are
    // logged and skipped inside replay_navigate_verbs.
    replay_navigate_verbs(control.as_ref(), &stream_id, &story_src, cursor_line).await?;

    // Steps 4/6 pause/resume intentionally skipped — the Preview-panel canvas
    // IS the user's input surface (via author_dispatch_input), so the CDP
    // screencast MUST stay active during picking. Otherwise the canvas
    // freezes and the user can't see the picker overlay highlights or which
    // element they're hovering.

    // Step 5 — run the picker. Canvas pointer events forward through
    // author_dispatch_input; the overlay (document-level click listener)
    // emits the DSL payload back via __sc_picker_emit.
    let pick_result = control
        .pick_element_start_author(&stream_id, timeout_ms)
        .await;

    // Step 7 — FSM transition back under the lock. end_pick() restores
    // LivePreview{stream_id} (or SimulatorPaused if resume_to was Some).
    {
        let mut g = registry.state.lock().await;
        g.end_pick();
    }

    // Step 8 — disarm guard: happy path restoration is done; Drop becomes
    // a no-op. Must happen AFTER end_pick() so a panic between steps 6
    // and 7 still fires the guard's restore.
    guard.disarm();

    let pick = pick_result?;
    Ok(pick.into())
}

/// Tauri command entry point for Preview-panel Pick. See
/// `picker_start_author_impl` for the orchestration. Accepts `story_src`
/// directly from the renderer (the renderer handles dirty-buffer toast
/// before invoking this command).
///
/// `stream_id` MUST match an entry in `AppState.author_preview_sessions`
/// (started via `start_author_preview`); unknown streamId surfaces as
/// `AppError::InvalidArgument`.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "picker_start_author"),
    err(Debug)
)]
pub async fn picker_start_author(
    state: State<'_, AppState>,
    registry: State<'_, Arc<AuthorDriverRegistry>>,
    stream_id: String,
    story_src: String,
    cursor_line: u32,
    timeout_ms: Option<u64>,
) -> Result<PickElementResponseDto, AppError> {
    let timeout = timeout_ms.unwrap_or(60_000);

    // Resolve the per-session driver from author_preview_sessions.
    // Use the author-session's own sidecar — never AppState.playwright_driver
    // (which is the recorder-path driver).
    let driver_arc = {
        let sessions = state.author_preview_sessions.lock().await;
        sessions
            .get(&stream_id)
            .map(|s| s.driver.clone())
            .ok_or_else(|| {
                AppError::InvalidArgument(format!("unknown author stream: {stream_id}"))
            })?
    };

    let control: Arc<dyn AuthorPreviewControl> =
        Arc::new(SidecarAuthorPreviewControl { driver: driver_arc });

    picker_start_author_impl(
        registry.inner().clone(),
        control,
        stream_id,
        story_src,
        cursor_line,
        timeout,
    )
    .await
}

/// forward id-absent JSON-RPC notifications from the
/// sidecar to Tauri events. One task per driver lifetime. The task exits
/// when the broadcast channel closes (driver dropped); caller owns the
/// `JoinHandle` so it can be aborted early on explicit teardown.
///
/// Currently forwards only `pickElement.hoverPreview` → Tauri event
/// `picker_hover_preview`. Other notification methods are logged at
/// debug and otherwise ignored — future hover/preview notifications can
/// add arms without changing the receiver contract.
///
/// Lagged subscribers get `RecvError::Lagged(n)` and are logged at warn,
/// not panicked. The channel capacity (128) is well above a rAF-throttled
/// (~60 Hz) emitter against a React consumer.
pub fn spawn_notification_forwarder(
    app: AppHandle,
    rx: tokio::sync::broadcast::Receiver<automation::Notification>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(note) if note.method == "pickElement.hoverPreview" => {
                    if let Err(e) = app.emit("picker_hover_preview", &note.params) {
                        tracing::warn!(
                            target: "storycapture::picker",
                            "failed to emit picker_hover_preview: {e}"
                        );
                    }
                }
                Ok(note) => {
                    tracing::debug!(
                        target: "storycapture::picker",
                        "ignoring unknown notification method: {}",
                        note.method
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        target: "storycapture::picker",
                        "hover subscriber lagged {n} messages"
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::debug!(
                        target: "storycapture::picker",
                        "notification channel closed — forwarder exiting"
                    );
                    break;
                }
            }
        }
    })
}
