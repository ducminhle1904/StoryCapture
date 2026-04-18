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
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Value,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
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

        // Reader task: parse stdout lines, dispatch to the pending map.
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
                let mut p = pending_for_reader.lock().await;
                if let Some(tx) = p.remove(&resp.id) {
                    let _ = tx.send(if let Some(err) = resp.error {
                        Err(err.message)
                    } else {
                        Ok(resp.result.unwrap_or(Value::Null))
                    });
                }
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending,
            _child: Arc::new(Mutex::new(Some(child))),
        })
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
}

fn target_to_json(t: &SelectorOrText) -> Value {
    match t {
        SelectorOrText::Text(s) => json!({ "kind": "text", "value": s }),
        SelectorOrText::Selector(s) => json!({ "kind": "selector", "value": s }),
        SelectorOrText::TestId(s) => json!({ "kind": "testid", "value": s }),
        SelectorOrText::Aria(s) => json!({ "kind": "aria", "value": s }),
    }
}
