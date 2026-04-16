//! Tauri IPC <-> tower-lsp LspService bridge (D-16, AI-SPEC pitfall #3).
//!
//! This module bridges `tower_lsp::LspService` to Tauri's command/channel
//! IPC surface. **No stdio** is involved (D-16 architectural constraint).
//!
//! Architecture:
//! - On app start, `LspBridge::new()` builds an `LspService` from
//!   `StoryLanguageServer::new` and spawns a background task to read
//!   the `ClientSocket` stream (server-initiated notifications like
//!   `publishDiagnostics`).
//! - `handle_lsp_request(request_json)` parses a JSON-RPC envelope,
//!   sends it through the service, and returns the response.
//! - Notification subscribers register via `subscribe()` and receive
//!   server-initiated messages through a broadcast channel.

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};
use tower::Service;
use tower_lsp::jsonrpc::Request;
use tower_lsp::{ClientSocket, LspService};

use crate::lsp::StoryLanguageServer;

/// Notification forwarded from the LSP server to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspNotification {
    pub method: String,
    pub params: serde_json::Value,
}

/// Error returned by the IPC bridge.
#[derive(Debug, thiserror::Error)]
pub enum LspBridgeError {
    #[error("invalid JSON-RPC request: {0}")]
    InvalidRequest(String),
    #[error("service error: {0}")]
    ServiceError(String),
    #[error("serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

/// Bridges `tower_lsp::LspService` to Tauri IPC.
///
/// Internally holds the service behind a `Mutex` because `tower::Service::call`
/// takes `&mut self`. The `ClientSocket` stream is consumed by a background task
/// that broadcasts server-initiated notifications (e.g. `publishDiagnostics`)
/// to all subscribers.
pub struct LspBridge {
    service: Mutex<LspService<StoryLanguageServer>>,
    notifier: broadcast::Sender<LspNotification>,
}

impl LspBridge {
    /// Build the bridge. Spawns a background task to drain the
    /// `ClientSocket` stream and broadcast server notifications.
    pub fn new() -> Arc<Self> {
        let (service, socket) = LspService::new(StoryLanguageServer::new);
        let (tx, _rx) = broadcast::channel::<LspNotification>(64);

        let bridge = Arc::new(Self {
            service: Mutex::new(service),
            notifier: tx.clone(),
        });

        // Spawn background reader for server-initiated messages.
        tokio::spawn(Self::drain_notifications(socket, tx));

        bridge
    }

    /// Subscribe to server-initiated notifications (e.g. publishDiagnostics).
    pub fn subscribe(&self) -> broadcast::Receiver<LspNotification> {
        self.notifier.subscribe()
    }

    /// Process a single JSON-RPC request/notification envelope.
    ///
    /// For requests (has `id`), returns `Some(response_json)`.
    /// For notifications (no `id`), returns `None`.
    pub async fn handle_lsp_request(
        &self,
        request_json: serde_json::Value,
    ) -> Result<Option<serde_json::Value>, LspBridgeError> {
        // Parse the incoming JSON into a tower-lsp Request.
        let request: Request = serde_json::from_value(request_json)
            .map_err(|e| LspBridgeError::InvalidRequest(e.to_string()))?;

        // Call the service. We need exclusive access because tower::Service::call
        // takes &mut self.
        let mut service = self.service.lock().await;

        // Poll until the service is ready to accept a request.
        std::future::poll_fn(|cx| service.poll_ready(cx))
            .await
            .map_err(|e| LspBridgeError::ServiceError(e.to_string()))?;

        let response = service
            .call(request)
            .await
            .map_err(|e| LspBridgeError::ServiceError(e.to_string()))?;

        match response {
            Some(resp) => {
                let json = serde_json::to_value(&resp)?;
                Ok(Some(json))
            }
            None => Ok(None),
        }
    }

    /// Background task: reads the `ClientSocket` stream (server -> client
    /// messages) and broadcasts them as `LspNotification`s.
    ///
    /// `ClientSocket` implements `Stream<Item = Request>` where each item is
    /// a server-initiated JSON-RPC message (notification or request to client).
    async fn drain_notifications(
        mut socket: ClientSocket,
        tx: broadcast::Sender<LspNotification>,
    ) {
        while let Some(msg) = socket.next().await {
            // Each `msg` is a `tower_lsp::jsonrpc::Request`.
            // Server-initiated notifications (publishDiagnostics, etc.)
            // come through here.
            let method = msg.method().to_string();

            let params = msg
                .params()
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            let notification = LspNotification { method, params };

            // Best-effort broadcast; if no receivers, drop silently.
            let _ = tx.send(notification);
        }
    }
}
