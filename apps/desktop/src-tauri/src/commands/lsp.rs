//! LSP IPC bridge Tauri commands.
//!
//! Exposes the `lsp_request` command that forwards JSON-RPC envelopes
//! from the webview to the in-process `tower-lsp` service via `LspBridge`.
//! Server-initiated notifications (e.g. `publishDiagnostics`) are streamed
//! back through a Tauri `Channel<LspNotificationDto>`.
//!
//! NO stdio is involved. The LSP runs in-process and communicates via
//! Tauri IPC exclusively.
//!
//! **specta compatibility:** `serde_json::Value` does not implement
//! `specta::Type`. We marshal JSON-RPC envelopes as opaque JSON strings
//! (`String` in/out) — the frontend parses/stringifies. This mirrors the
//! DryRun DTO pattern.

use serde::Serialize;
use specta::Type;
use tauri::{ipc::Channel, State};
use tokio::task::AbortHandle;

use intelligence::lsp::{LspBridge, LspNotification};
use std::sync::Arc;

/// DTO for LSP notifications sent back to the frontend via Channel.
///
/// Params are serialized as a JSON string to avoid specta's `Value` limitation.
#[derive(Debug, Clone, Serialize, Type)]
pub struct LspNotificationDto {
    pub method: String,
    /// JSON-stringified notification params.
    pub params_json: String,
}

impl From<LspNotification> for LspNotificationDto {
    fn from(n: LspNotification) -> Self {
        Self {
            method: n.method,
            params_json: serde_json::to_string(&n.params).unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// Managed state: the LSP bridge singleton + notification subscriber handle.
///
/// `subscriber_handle` tracks the single long-lived notification forwarding
/// task. When the frontend sends a new `lsp_request` with a fresh channel,
/// the previous subscriber is aborted before spawning its replacement. This
/// prevents zombie subscribers from accumulating on rapid typing.
pub struct LspBridgeState {
    pub bridge: Arc<LspBridge>,
    subscriber_handle: std::sync::Mutex<Option<AbortHandle>>,
}

impl LspBridgeState {
    pub fn new(bridge: Arc<LspBridge>) -> Self {
        Self {
            bridge,
            subscriber_handle: std::sync::Mutex::new(None),
        }
    }
}

/// Send a JSON-RPC request/notification to the in-process LSP server.
///
/// `jsonrpc_request_json` is a JSON-stringified JSON-RPC envelope.
/// Returns the JSON-stringified response envelope (for requests) or `"null"`
/// (for notifications). Server-initiated notifications are pushed through
/// the `on_notification` channel.
#[tauri::command]
#[specta::specta]
pub async fn lsp_request(
    bridge_state: State<'_, LspBridgeState>,
    jsonrpc_request_json: String,
    on_notification: Channel<LspNotificationDto>,
) -> Result<String, String> {
    let bridge = &bridge_state.bridge;

    // Parse the incoming JSON string into a Value for the bridge.
    let request_value: serde_json::Value = serde_json::from_str(&jsonrpc_request_json)
        .map_err(|e| format!("invalid JSON-RPC envelope: {e}"))?;

    // Abort the previous notification subscriber (if any) before spawning a
    // new one. This prevents zombie subscriber tasks from accumulating when
    // the frontend sends rapid requests.
    {
        let mut handle_guard = bridge_state.subscriber_handle.lock().unwrap();
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }

        let mut rx = bridge.subscribe();
        let channel = on_notification.clone();
        let join_handle = tokio::spawn(async move {
            while let Ok(notification) = rx.recv().await {
                let dto: LspNotificationDto = notification.into();
                if channel.send(dto).is_err() {
                    // Channel closed by frontend -- stop forwarding.
                    break;
                }
            }
        });
        *handle_guard = Some(join_handle.abort_handle());
    }

    // Forward the request to the LSP service.
    let response = bridge
        .handle_lsp_request(request_value)
        .await
        .map_err(|e| e.to_string())?;

    // Serialize response back to JSON string.
    let response_json = match response {
        Some(val) => serde_json::to_string(&val).unwrap_or_else(|_| "null".into()),
        None => "null".into(),
    };

    Ok(response_json)
}
