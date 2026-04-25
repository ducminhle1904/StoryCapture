//! LSP IPC bridge Tauri commands.
//!
//! Exposes the `lsp_request` command that forwards JSON-RPC envelopes to
//! the in-process `tower-lsp` service and streams notifications back.
//!
//! The LSP runs in-process and communicates via Tauri IPC only.

use serde::Serialize;
use specta::Type;
use tauri::{ipc::Channel, State};
use tokio::task::AbortHandle;

use intelligence::lsp::{LspBridge, LspNotification};
use std::sync::Arc;

/// DTO for LSP notifications sent back to the frontend via Channel.
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

/// Managed state for the LSP bridge and notification subscriber.
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

/// Send a JSON-RPC request or notification to the in-process LSP server.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "lsp_request"), err(Debug))]
pub async fn lsp_request(
    bridge_state: State<'_, LspBridgeState>,
    jsonrpc_request_json: String,
    on_notification: Channel<LspNotificationDto>,
) -> Result<String, String> {
    let bridge = &bridge_state.bridge;

    // Parse the JSON string for the bridge.
    let request_value: serde_json::Value = serde_json::from_str(&jsonrpc_request_json)
        .map_err(|e| format!("invalid JSON-RPC envelope: {e}"))?;

    // Replace the previous notification subscriber.
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
                    // Stop forwarding if the channel closes.
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

    // Serialize the response back to JSON.
    let response_json = match response {
        Some(val) => serde_json::to_string(&val).unwrap_or_else(|_| "null".into()),
        None => "null".into(),
    };

    Ok(response_json)
}
