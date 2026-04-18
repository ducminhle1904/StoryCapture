// element-picker Tauri commands.
//
// Routes `picker_start` / `picker_cancel` / `picker_is_active` to the
// shared `PlaywrightSidecarDriver` populated by `launch_automation` in
// `AppState::playwright_driver`. The desktop UI (PickElementButton)
// disables itself unless `picker_is_active` confirms the sidecar is
// alive, so the "no driver" branch is reachable only via races at
// session-end.

use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

/// Tauri / specta DTO wrapping `automation::PickElementResponse` as a
/// JSON string. The `automation` crate is pure-Rust (D-07: no Tauri /
/// specta deps), so we serialize at the boundary and let the TS wrapper
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
/// URL / timeout. Wire contract — `emitted: String` — matches sidecar
/// `pickElement.start` response (07-03a `server.mjs:414`).
#[tauri::command]
#[specta::specta]
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
#[tauri::command]
#[specta::specta]
pub async fn picker_cancel(state: State<'_, AppState>) -> Result<(), AppError> {
    let driver = {
        let slot = state.playwright_driver.lock().await;
        slot.as_ref().cloned()
    };
    if let Some(driver) = driver {
        let d = driver.lock().await;
        d.pick_element_cancel()
            .await
            .map_err(|e| AppError::Automation(e.to_string()))?;
    }
    Ok(())
}

/// True iff a pickElement session is currently waiting for a click.
/// Returns `false` when no sidecar is launched (rather than erroring) so
/// the UI can poll cheaply.
#[tauri::command]
#[specta::specta]
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
/// Rejects `story_path` that contains `..` (path-traversal guard,
/// 02). The Tauri FS scope (Plan 01-03) is still the primary
/// boundary; this check is a defense-in-depth against a misconfigured
/// scope or future refactor.
///
/// ## Error mapping
///
/// `AppError::Automation` carries the underlying parse / io / protocol
/// error as a string — the renderer toasts it without blocking the
/// pick flow (fire-and-forget semantics on the UI side).
/// Wire envelope: `primary_json` is a JSON-stringified
/// `{ kind: string, value: unknown }` and `fallbacks_json` is a
/// JSON-stringified `Array<{ kind, value }>`. Using strings keeps the
/// `specta::Type`-bound command signature free of `serde_json::Value`
/// (which specta 2.0.0-rc.22 rejects as a function arg).
#[tauri::command]
#[specta::specta]
pub async fn picker_stamp_step_id(
    story_path: String,
    line_offset: u32,
    primary_json: String,
    fallbacks_json: String,
) -> Result<String, AppError> {
    // Path-traversal guard (T-07-04c-02). The Tauri FS scope is the
    // primary boundary; this is defense-in-depth.
    if story_path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(AppError::Automation(
            "path traversal rejected: story_path contains '..'".into(),
        ));
    }

    let primary: serde_json::Value = serde_json::from_str(&primary_json)
        .map_err(|e| AppError::Automation(format!("decode primary_json: {e}")))?;
    let fallbacks: Vec<serde_json::Value> = serde_json::from_str(&fallbacks_json)
        .map_err(|e| AppError::Automation(format!("decode fallbacks_json: {e}")))?;

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

    let stamped_id = match existing_id {
        Some(id) => id,
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
            new_id
        }
    };

    // Seed or update the sibling targets.json atomically.
    let targets_path = automation::targets_store::targets_path_for(&path);
    let mut store = automation::targets_store::load(&targets_path)
        .unwrap_or_else(|_| automation::targets_store::TargetsFile::empty());

    let primary_record = target_record_from_json(&primary)?;
    let fallback_records: Vec<automation::targets_store::TargetRecord> = fallbacks
        .iter()
        .filter_map(|v| target_record_from_json(v).ok())
        .collect();

    store.steps.insert(
        stamped_id,
        automation::targets_store::StepTargets {
            primary: primary_record,
            fallbacks: fallback_records,
        },
    );

    automation::targets_store::atomic_write(&targets_path, &store)
        .map_err(|e| AppError::Automation(format!("targets_store write: {e}")))?;

    Ok(stamped_id.to_string())
}

/// Coerce an incoming `{ kind, value }` JSON payload into a
/// `targets_store::TargetRecord`. Emits `AppError::Automation` when the
/// envelope is malformed — callers on the TS side (see
/// `apps/desktop/src/ipc/picker.ts` `pickerStampStepId`) MUST pass the
/// documented shape.
fn target_record_from_json(
    v: &serde_json::Value,
) -> std::result::Result<automation::targets_store::TargetRecord, AppError> {
    let kind = v
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| AppError::Automation("target record missing `kind`".into()))?
        .to_string();
    let value = v
        .get("value")
        .cloned()
        .ok_or_else(|| AppError::Automation("target record missing `value`".into()))?;
    Ok(automation::targets_store::TargetRecord { kind, value })
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
/// 01 mitigation: lagged subscribers get `RecvError::Lagged(n)`
/// and are logged at warn, not panicked. The channel capacity (128) is
/// well above a rAF-throttled (~60 Hz) emitter against a React consumer.
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
