// Plan 07-03b — element-picker Tauri commands.
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
use tauri::State;

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
