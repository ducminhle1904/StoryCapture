//! `PlaywrightSidecarDriver` — Node SEA bundled sidecar over JSON-RPC (D-15).
//!
//! Spawns the `playwright-sidecar` binary (built by
//! `scripts/playwright-sidecar/build-sea.mjs`), writes newline-delimited
//! JSON-RPC 2.0 requests on stdin, reads responses from stdout. The sidecar
//! wraps `playwright-core`'s Chromium driver; capability set is all-true.
//!
//! Phase 1 ships the Rust transport + the Node server + the SEA build
//! recipe. The full coverage of every BrowserDriver verb against a real
//! Chromium binary is gated behind the `real-playwright-tests` feature flag
//! (and behind the build of the SEA artifact, which CI does on PR).

use crate::driver::{
    BrowserDriver, CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
};
use crate::error::{AutomationError, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use story_parser::{ScrollDir, SelectorOrText};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, oneshot, Mutex};

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Value,
}

// JSON-RPC notifications.
//
// `id` is now Option<u64>: id-absent messages carry `method`+`params` and
// are dispatched to a tokio broadcast channel instead of the pending-
// request map. `result`/`error` are unchanged so response parsing remains
// backward-compatible with every 07-03a/b call site.
#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

/// fan-out payload for id-absent JSON-RPC messages.
/// Subscribers consume via `PlaywrightSidecarDriver::subscribe_notifications`.
#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

pub struct PlaywrightSidecarDriver {
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Pending,
    /// Keep the child alive for the driver lifetime.
    _child: Arc<Mutex<Option<Child>>>,
    /// fan-out for id-absent JSON-RPC messages (e.g.
    /// `pickElement.hoverPreview`). Capacity 128 — lagged subscribers
    /// receive `RecvError::Lagged(n)` and are logged, not panicked.
    notifications: broadcast::Sender<Notification>,
}

impl PlaywrightSidecarDriver {
    /// Build the driver from an already-spawned child process. The child's
    /// stdin / stdout MUST be `Stdio::piped()` at spawn time.
    ///
    /// The Tauri host wires this through `tauri-plugin-shell`'s sidecar
    /// command; tests spawn `node scripts/playwright-sidecar/server.mjs`
    /// directly behind the `real-playwright-tests` feature flag.
    pub fn from_child(mut child: Child) -> Result<Self> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AutomationError::Protocol("child stdin not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AutomationError::Protocol("child stdout not piped".into()))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();

        // broadcast channel for id-absent JSON-RPC
        // notifications. Capacity 128: well above the rAF-throttled (~60 Hz)
        // hoverPreview stream against any reasonable UI consumer cadence.
        let (notifications, _keep_open) = broadcast::channel::<Notification>(128);
        let notifications_for_reader = notifications.clone();

        // Reader task: parse stdout lines, dispatch to the pending map or
        // the notifications broadcast channel.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                let parsed: std::result::Result<JsonRpcResponse, _> = serde_json::from_str(&line);
                let resp = match parsed {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(target: "automation::playwright", "bad JSON from sidecar: {e}: {line}");
                        continue;
                    }
                };
                match (resp.id, resp.method.as_deref()) {
                    (Some(id), _) => {
                        // Id-present → request/response path (unchanged).
                        let mut p = pending_for_reader.lock().await;
                        if let Some(tx) = p.remove(&id) {
                            let _ = tx.send(if let Some(err) = resp.error {
                                Err(err.message)
                            } else {
                                Ok(resp.result.unwrap_or(Value::Null))
                            });
                        }
                    }
                    (None, Some(method)) => {
                        // Id-absent + method → notification (fan-out).
                        let note = Notification {
                            method: method.to_string(),
                            params: resp.params.unwrap_or(Value::Null),
                        };
                        // `send` errors only when there are zero live
                        // receivers — ignore so startup before any
                        // subscriber attaches doesn't log-spam.
                        let _ = notifications_for_reader.send(note);
                    }
                    _ => {
                        tracing::warn!(
                            target: "automation::playwright",
                            "malformed line (no id, no method): {line}"
                        );
                    }
                }
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending,
            _child: Arc::new(Mutex::new(Some(child))),
            notifications,
        })
    }

    /// subscribe to id-absent JSON-RPC messages. Multiple
    /// subscribers all receive every notification. Lagged subscribers get
    /// `RecvError::Lagged(n)` on the next `recv()` and must choose whether
    /// to log and continue or resubscribe.
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<Notification> {
        self.notifications.subscribe()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');

        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().await;
            p.insert(id, tx);
        }

        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| AutomationError::Protocol(format!("stdin write: {e}")))?;
            stdin
                .flush()
                .await
                .map_err(|e| AutomationError::Protocol(format!("stdin flush: {e}")))?;
        }

        match rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(msg)) => Err(AutomationError::Browser(msg)),
            Err(_) => Err(AutomationError::Protocol(
                "sidecar response channel dropped".into(),
            )),
        }
    }
}

#[async_trait]
impl BrowserDriver for PlaywrightSidecarDriver {
    async fn launch(&mut self, config: LaunchConfig) -> Result<()> {
        let params = json!({
            "viewport": { "width": config.viewport.width, "height": config.viewport.height },
            "theme": match config.theme {
                story_parser::Theme::Dark => "dark",
                story_parser::Theme::Light => "light",
                story_parser::Theme::Auto => "auto",
            },
            "baseUrl": config.base_url,
            "headless": config.headless,
            "downloadDir": config.download_dir.to_string_lossy(),
            "executable": config.executable.as_ref().map(|p| p.to_string_lossy().to_string()),
            // Plan 06-02 — extra Chromium args (chrome-hiding --app=<url>).
            "args": config.args,
        });
        self.call("launch", params).await?;
        Ok(())
    }

    async fn close(&mut self) -> Result<()> {
        let _ = self.call("close", json!({})).await;
        Ok(())
    }

    async fn goto(&self, url: &str) -> Result<()> {
        self.call("goto", json!({ "url": url })).await?;
        Ok(())
    }

    async fn click(&self, sel: &ResolvedSelector) -> Result<()> {
        self.call("click", json!({ "selector": sel.value, "strategy": sel.strategy.as_str() }))
            .await?;
        Ok(())
    }

    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> Result<()> {
        self.call(
            "type",
            json!({ "selector": sel.value, "strategy": sel.strategy.as_str(), "text": text }),
        )
        .await?;
        Ok(())
    }

    async fn scroll(&self, direction: ScrollDir, amount: Option<f32>) -> Result<()> {
        let dir = match direction {
            ScrollDir::Up => "up",
            ScrollDir::Down => "down",
            ScrollDir::Left => "left",
            ScrollDir::Right => "right",
        };
        self.call("scroll", json!({ "direction": dir, "amount": amount }))
            .await?;
        Ok(())
    }

    async fn hover(&self, sel: &ResolvedSelector) -> Result<()> {
        self.call("hover", json!({ "selector": sel.value, "strategy": sel.strategy.as_str() }))
            .await?;
        Ok(())
    }

    async fn drag(&self, from: &ResolvedSelector, to: &ResolvedSelector) -> Result<()> {
        self.call(
            "drag",
            json!({ "from": from.value, "to": to.value }),
        )
        .await?;
        Ok(())
    }

    async fn select_option(&self, sel: &ResolvedSelector, value: &str) -> Result<()> {
        self.call(
            "select",
            json!({ "selector": sel.value, "value": value }),
        )
        .await?;
        Ok(())
    }

    async fn upload_file(&self, sel: &ResolvedSelector, path: &Path) -> Result<()> {
        self.call(
            "upload",
            json!({ "selector": sel.value, "path": path.to_string_lossy() }),
        )
        .await?;
        Ok(())
    }

    async fn wait_ms(&self, ms: u64) -> Result<()> {
        self.call("waitMs", json!({ "ms": ms })).await?;
        Ok(())
    }

    async fn wait_for(&self, target: &SelectorOrText, timeout_ms: u64) -> Result<()> {
        self.call(
            "waitFor",
            json!({ "target": target_to_json(target), "timeoutMs": timeout_ms }),
        )
        .await?;
        Ok(())
    }

    async fn assert_present(&self, target: &SelectorOrText) -> Result<()> {
        self.call("assert", json!({ "target": target_to_json(target) }))
            .await?;
        Ok(())
    }

    async fn screenshot(&self, name: &str, out_dir: &Path) -> Result<PathBuf> {
        let v = self
            .call(
                "screenshot",
                json!({ "name": name, "outDir": out_dir.to_string_lossy() }),
            )
            .await?;
        let path = v["path"].as_str().unwrap_or("").to_string();
        Ok(PathBuf::from(path))
    }

    async fn element_state(&self, sel: &ResolvedSelector) -> Result<ElementState> {
        let v = self
            .call(
                "elementState",
                json!({ "selector": sel.value, "strategy": sel.strategy.as_str() }),
            )
            .await?;
        Ok(ElementState {
            visible: v["visible"].as_bool().unwrap_or(false),
            in_viewport: v["inViewport"].as_bool().unwrap_or(false),
            animating: v["animating"].as_bool().unwrap_or(false),
            bbox: v.get("bbox").map(|b| crate::driver::BoundingBox {
                x: b["x"].as_f64().unwrap_or(0.0),
                y: b["y"].as_f64().unwrap_or(0.0),
                w: b["w"].as_f64().unwrap_or(0.0),
                h: b["h"].as_f64().unwrap_or(0.0),
            }),
        })
    }

    async fn current_cursor_position(&self) -> Result<(i32, i32)> {
        let v = self.call("cursorPosition", json!({})).await?;
        Ok((
            v["x"].as_i64().unwrap_or(0) as i32,
            v["y"].as_i64().unwrap_or(0) as i32,
        ))
    }

    fn capabilities(&self) -> CapabilitySet {
        CapabilitySet::PLAYWRIGHT
    }

    fn name(&self) -> &'static str {
        "playwright"
    }
}

/// Plan 05-02 — process info for the launched browser, returned by the
/// sidecar's `browserProcess` JSON-RPC verb.
///
/// - `pid: Some(_)` — locally-launched Chromium; host may resolve pid→SCWindow.
/// - `pid: None`, `reason: Some("remote-browser")` — `chromium.connect()` path,
///   no local process to target. UI keeps the auto option disabled.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BrowserProcessInfo {
    pub pid: Option<i32>,
    #[serde(rename = "executablePath")]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl PlaywrightSidecarDriver {
    /// Call the sidecar's `browserProcess` verb. Returns `Ok(info)` when the
    /// sidecar answers (either with a local pid or the remote-browser
    /// sentinel). Returns `Err(AutomationError::Browser("browser not
    /// launched"))` when no `launch` has happened yet — the caller should
    /// treat that as "Playwright auto unavailable" rather than a fatal
    /// error.
    ///
    /// T-05-02-03: the sidecar logs `executable_path` at DEBUG only; this
    /// method does not emit it at any level to avoid host-side leak.
    pub async fn browser_process(&self) -> Result<BrowserProcessInfo> {
        let v = self.call("browserProcess", serde_json::json!({})).await?;
        let info: BrowserProcessInfo = serde_json::from_value(v)
            .map_err(|e| AutomationError::Protocol(format!("browserProcess decode: {e}")))?;
        Ok(info)
    }

    pub async fn wait_for_first_paint(&self, timeout_ms: u64) -> Result<()> {
        self.call(
            "waitForFirstPaint",
            serde_json::json!({ "timeoutMs": timeout_ms }),
        )
        .await?;
        Ok(())
    }

    /// author-time DOM + screenshot capture for the selector
    /// validator. Routes to the sidecar's `captureSnapshot` verb which
    /// uses a DEDICATED browser (never disturbs the recording session's
    /// `state.page`). Returns the raw sidecar response — the desktop
    /// command layer is responsible for persisting it to disk + hashing.
    pub async fn capture_snapshot(
        &self,
        url: &str,
        viewport: Option<(u32, u32)>,
        timeout_ms: Option<u64>,
    ) -> Result<SnapshotResponse> {
        let mut params = serde_json::json!({ "url": url });
        if let Some((w, h)) = viewport {
            params["viewport"] = serde_json::json!({ "width": w, "height": h });
        }
        if let Some(t) = timeout_ms {
            params["timeoutMs"] = serde_json::json!(t);
        }
        let v = self.call("captureSnapshot", params).await?;
        let resp: SnapshotResponse = serde_json::from_value(v).map_err(|e| {
            AutomationError::Protocol(format!("captureSnapshot decode: {e}"))
        })?;
        Ok(resp)
    }
}

/// sidecar `captureSnapshot` response payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotResponse {
    pub url: String,
    #[serde(rename = "domHash")]
    pub dom_hash: String,
    #[serde(rename = "innerHTML")]
    pub inner_html: String,
    #[serde(rename = "screenshotBase64")]
    pub screenshot_base64: String,
    #[serde(rename = "capturedAt")]
    pub captured_at: String,
}

fn target_to_json(t: &SelectorOrText) -> Value {
    match t {
        SelectorOrText::Text(s) => json!({ "kind": "text", "value": s }),
        SelectorOrText::Selector(s) => json!({ "kind": "selector", "value": s }),
        SelectorOrText::TestId(s) => json!({ "kind": "testid", "value": s }),
        SelectorOrText::Aria(s) => json!({ "kind": "aria", "value": s }),
        // sidecar `locate()` consumes these in
        // `targetToLocator()` per CONTEXT.md §Tier 1 prerequisite.
        SelectorOrText::Role { role, name } => json!({
            "kind": "role",
            "value": { "role": role.as_kebab(), "name": name }
        }),
        SelectorOrText::Label(s) => json!({ "kind": "label", "value": s }),
        SelectorOrText::TextExact(s) => json!({ "kind": "text_exact", "value": s }),
    }
}

// ──────────────────────────────────────────────────────────────────────
// element-picker JSON-RPC wrappers.
//
// CONTRACT: the `Picked` variant's field MUST be named `emitted: String`
// — this matches the sidecar wire field at `scripts/playwright-sidecar/
// server.mjs:414`. Renaming (e.g. `dsl_line`) breaks the picker UI flow
// in 07-03b. Grep-guarded by the plan's acceptance criteria.
// ──────────────────────────────────────────────────────────────────────

/// Locator description from the sidecar's ranked DSL generator.
/// `value` is a string for testid/selector/label/text_exact, or an
/// object `{ role, name }` for the role kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickLocator {
    pub kind: String,
    pub value: Value,
}

/// One scored candidate from the ranked generator (same shape as the
/// chosen locator plus a score and uniqueness flag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickCandidate {
    pub kind: String,
    pub value: Value,
    pub score: f64,
    #[serde(default)]
    pub unique: bool,
}

/// Sidecar `pickElement.start` response. Untagged so serde discriminates
/// on field shape: `Picked` requires `emitted`; `Cancelled` requires
/// `cancelled: true` + `reason`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PickElementResponse {
    Picked {
        // CONTRACT (07-03a wire): field is `emitted: String`. Do not rename.
        emitted: String,
        locator: PickLocator,
        candidates: Vec<PickCandidate>,
    },
    Cancelled {
        cancelled: bool, // always true; kept for serde-untagged disambiguation
        reason: String,
    },
}

impl PlaywrightSidecarDriver {
    /// Start an interactive pickElement session. Returns `Picked` on the
    /// first user click that resolves to a unique locator, or `Cancelled`
    /// for Esc / navigation / unsupported-url / timeout.
    pub async fn pick_element_start(&self, timeout_ms: u64) -> Result<PickElementResponse> {
        let v = self
            .call("pickElement.start", json!({ "timeoutMs": timeout_ms }))
            .await?;
        serde_json::from_value(v)
            .map_err(|e| AutomationError::Protocol(format!("pickElement.start decode: {e}")))
    }

    /// Cancel the in-flight pickElement session (no-op if none active).
    pub async fn pick_element_cancel(&self) -> Result<()> {
        self.call("pickElement.cancel", json!({})).await?;
        Ok(())
    }

    /// True iff a pickElement session is currently waiting for a click.
    pub async fn pick_element_is_active(&self) -> Result<bool> {
        let v = self.call("pickElement.isActive", json!({})).await?;
        Ok(v.get("active").and_then(|a| a.as_bool()).unwrap_or(false))
    }
}

#[cfg(test)]
mod notification_tests {
    // JSON-RPC notification plumbing.
    //
    // RED-first: these tests assert the broadcast semantics for id-absent
    // JSON-RPC messages (see CONTEXT.md §Tier 2 robustness). They exercise
    // the primitives (broadcast::channel + JsonRpcResponse serde) rather
    // than the reader loop so they run without spawning a Node sidecar.
    use super::{JsonRpcResponse, Notification};
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn multi_subscriber_receives_all_notifications() {
        let (tx, _) = broadcast::channel::<Notification>(16);
        let mut a = tx.subscribe();
        let mut b = tx.subscribe();
        tx.send(Notification {
            method: "x".into(),
            params: serde_json::json!({"n": 1}),
        })
        .unwrap();
        tx.send(Notification {
            method: "x".into(),
            params: serde_json::json!({"n": 2}),
        })
        .unwrap();
        assert_eq!(a.recv().await.unwrap().params["n"], 1);
        assert_eq!(a.recv().await.unwrap().params["n"], 2);
        assert_eq!(b.recv().await.unwrap().params["n"], 1);
        assert_eq!(b.recv().await.unwrap().params["n"], 2);
    }

    #[tokio::test]
    async fn lagged_subscriber_gets_lag_error_not_panic() {
        let (tx, _) = broadcast::channel::<Notification>(2);
        let mut rx = tx.subscribe();
        for i in 0..10 {
            tx.send(Notification {
                method: "x".into(),
                params: serde_json::json!({ "n": i }),
            })
            .unwrap_or_else(|_| panic!("send {i}"));
        }
        let r = rx.recv().await;
        assert!(
            matches!(r, Err(broadcast::error::RecvError::Lagged(_))),
            "expected Lagged, got {:?}",
            r
        );
    }

    #[test]
    fn response_with_no_id_and_method_parses_as_notification() {
        let line = r#"{"jsonrpc":"2.0","method":"pickElement.hoverPreview","params":{"role":"button"}}"#;
        let r: JsonRpcResponse = serde_json::from_str(line).unwrap();
        assert!(r.id.is_none());
        assert_eq!(r.method.as_deref(), Some("pickElement.hoverPreview"));
        assert_eq!(r.params.as_ref().unwrap()["role"], "button");
    }

    #[test]
    fn response_with_id_and_result_parses_as_response() {
        let line = r#"{"jsonrpc":"2.0","id":42,"result":{"ok":true}}"#;
        let r: JsonRpcResponse = serde_json::from_str(line).unwrap();
        assert_eq!(r.id, Some(42));
        assert!(r.method.is_none());
        assert_eq!(r.result.as_ref().unwrap()["ok"], true);
    }
}

#[cfg(test)]
mod pick_element_serde_tests {
    use super::*;

    #[test]
    fn picked_response_deserializes_testid() {
        let json = serde_json::json!({
            "emitted": "click testid \"save\"",
            "locator": { "kind": "testid", "value": "save" },
            "candidates": [{ "kind": "testid", "value": "save", "score": 1.0, "unique": true }]
        });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        match r {
            PickElementResponse::Picked {
                emitted,
                locator,
                candidates,
            } => {
                assert_eq!(emitted, "click testid \"save\"");
                assert_eq!(locator.kind, "testid");
                assert_eq!(candidates.len(), 1);
                assert!(candidates[0].unique);
            }
            _ => panic!("expected Picked"),
        }
    }

    #[test]
    fn picked_response_deserializes_role_object_value() {
        let json = serde_json::json!({
            "emitted": "click button \"Save\"",
            "locator": { "kind": "role", "value": { "role": "button", "name": "Save" } },
            "candidates": []
        });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        match r {
            PickElementResponse::Picked { locator, .. } => {
                assert_eq!(locator.kind, "role");
                assert_eq!(locator.value["role"], "button");
                assert_eq!(locator.value["name"], "Save");
            }
            _ => panic!("expected Picked"),
        }
    }

    #[test]
    fn cancelled_navigation() {
        let json = serde_json::json!({ "cancelled": true, "reason": "navigation" });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        match r {
            PickElementResponse::Cancelled { cancelled, reason } => {
                assert!(cancelled);
                assert_eq!(reason, "navigation");
            }
            _ => panic!("expected Cancelled"),
        }
    }

    #[test]
    fn cancelled_user() {
        let json = serde_json::json!({ "cancelled": true, "reason": "user-cancel" });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        assert!(matches!(
            r,
            PickElementResponse::Cancelled { reason, .. } if reason == "user-cancel"
        ));
    }

    #[test]
    fn cancelled_unsupported_url() {
        let json = serde_json::json!({ "cancelled": true, "reason": "unsupported-url" });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        assert!(matches!(
            r,
            PickElementResponse::Cancelled { reason, .. } if reason == "unsupported-url"
        ));
    }
}

#[cfg(test)]
mod tier1_target_to_json_tests {
    use super::*;
    use story_parser::AriaRole;

    #[test]
    fn role_encodes_as_object_value_with_kebab_role_and_name() {
        let v = target_to_json(&SelectorOrText::Role {
            role: AriaRole::Button,
            name: "Save".into(),
        });
        assert_eq!(v["kind"], "role");
        assert_eq!(v["value"]["role"], "button");
        assert_eq!(v["value"]["name"], "Save");
    }

    #[test]
    fn role_preserves_colon_in_name() {
        let v = target_to_json(&SelectorOrText::Role {
            role: AriaRole::Link,
            name: "Go: now".into(),
        });
        assert_eq!(v["value"]["name"], "Go: now");
    }

    #[test]
    fn label_encodes_as_string_value() {
        let v = target_to_json(&SelectorOrText::Label("Email".into()));
        assert_eq!(v["kind"], "label");
        assert_eq!(v["value"], "Email");
    }

    #[test]
    fn text_exact_encodes_with_snake_case_kind() {
        let v = target_to_json(&SelectorOrText::TextExact("Learn more".into()));
        assert_eq!(v["kind"], "text_exact");
        assert_eq!(v["value"], "Learn more");
    }

    #[test]
    fn legacy_variants_unchanged() {
        assert_eq!(target_to_json(&SelectorOrText::Text("x".into()))["kind"], "text");
        assert_eq!(target_to_json(&SelectorOrText::Selector("#x".into()))["kind"], "selector");
        assert_eq!(target_to_json(&SelectorOrText::TestId("x".into()))["kind"], "testid");
        assert_eq!(target_to_json(&SelectorOrText::Aria("x".into()))["kind"], "aria");
    }
}
