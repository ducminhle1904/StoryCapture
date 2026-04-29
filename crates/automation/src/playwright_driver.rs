//! `PlaywrightSidecarDriver` — Node SEA bundled sidecar over JSON-RPC.
//!
//! Spawns the `playwright-sidecar` binary (built by
//! `scripts/playwright-sidecar/build-sea.mjs`), writes newline-delimited
//! JSON-RPC 2.0 requests on stdin, reads responses from stdout. The sidecar
//! wraps `playwright-core`'s Chromium driver; capability set is all-true.
//!
//! Full coverage of every BrowserDriver verb against a real Chromium binary
//! is gated behind the `real-playwright-tests` feature flag (and behind the
//! build of the SEA artifact, which CI does on PR).

use crate::driver::{
    accept_language_for_locale, BrowserDriver, BrowserEnvironment, BrowserSessionProfile,
    CapabilitySet, ElementState, LaunchConfig, ResolvedSelector,
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
use tokio::sync::{broadcast, oneshot, watch, Mutex};

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: Value,
}

// JSON-RPC notifications.
//
// `id` is Option<u64>: id-absent messages carry `method`+`params` and are
// dispatched to a tokio broadcast channel instead of the pending-request
// map. `result`/`error` are unchanged so response parsing stays backward-
// compatible with existing call sites.
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

/// Decoded `preview/frame` notification payload.
/// `data` is a base64-encoded JPEG; width/height in device pixels;
/// timestamp is Chromium's screencast metadata timestamp (seconds).
///
/// `stream_id` identifies which session the frame belongs to. `None` is the
/// recording session (legacy); `Some(_)` is an author-time session spawned
/// per editor preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreviewFrame {
    #[serde(default, rename = "streamId", skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub timestamp: f64,
}

/// Decoded `preview/nav` notification — current URL of an author session
/// page plus the pre-computed canGoBack / canGoForward flags. The sidecar
/// owns the history stack (Playwright doesn't expose those flags); this
/// struct mirrors its emitted payload verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavSnapshot {
    pub stream_id: String,
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct SidecarBrowserEnvironment {
    locale: Option<String>,
    #[serde(rename = "timezoneId")]
    timezone_id: Option<String>,
    #[serde(rename = "acceptLanguage")]
    accept_language: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SidecarSessionProfile {
    environment: SidecarBrowserEnvironment,
    #[serde(rename = "currentUrl")]
    current_url: Option<String>,
    #[serde(rename = "storageStateJson")]
    storage_state_json: Option<String>,
}

impl From<SidecarSessionProfile> for BrowserSessionProfile {
    fn from(profile: SidecarSessionProfile) -> Self {
        Self {
            environment: BrowserEnvironment {
                accept_language: profile.environment.accept_language.or_else(|| {
                    profile
                        .environment
                        .locale
                        .as_deref()
                        .map(accept_language_for_locale)
                }),
                locale: profile.environment.locale,
                timezone_id: profile.environment.timezone_id,
            },
            viewport: None,
            theme: None,
            current_url: profile.current_url,
            storage_state_json: profile.storage_state_json,
        }
    }
}

fn browser_environment_json(env: &BrowserEnvironment) -> Value {
    json!({
        "locale": env.locale,
        "timezoneId": env.timezone_id,
        "acceptLanguage": env.accept_language,
    })
}

// Untagged serde enum over the two sidecar stdout shapes.
// `Response` matches the id-carrying line; `Notification` matches id-less
// method+params lines. `JsonRpcResponse` handles both shapes via Option
// fields; this alias is the named type for reader-loop dispatch.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
enum SidecarMsg {
    Response(JsonRpcResponse),
    Notification {
        method: String,
        #[serde(default)]
        params: Value,
    },
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i32,
    message: String,
}

#[doc(hidden)]
pub type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

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
    /// Latest-wins watch channel for decoded preview frames. `watch::send`
    /// overwrites on every update so slow consumers naturally drop
    /// intermediate frames (backpressure).
    preview_frames_tx: watch::Sender<Option<PreviewFrame>>,
    /// Latest-wins watch channel for decoded `preview/nav` notifications.
    /// Subscribers filter by `stream_id` since the sidecar broadcasts every
    /// session's nav state on the same channel.
    nav_tx: watch::Sender<Option<NavSnapshot>>,
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

        // Watch channel for decoded preview/frame notifications. Latest-wins
        // by construction; keep the sender in the driver so subscribers can
        // be added after driver construction.
        let (preview_frames_tx, _preview_seed_rx) = watch::channel::<Option<PreviewFrame>>(None);
        let preview_tx_for_reader = preview_frames_tx.clone();

        let (nav_tx, _nav_seed_rx) = watch::channel::<Option<NavSnapshot>>(None);
        let nav_tx_for_reader = nav_tx.clone();

        // Reader task: parse stdout lines, dispatch to the pending map or
        // the notifications broadcast channel.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                handle_sidecar_line(
                    &line,
                    &pending_for_reader,
                    &notifications_for_reader,
                    &preview_tx_for_reader,
                    &nav_tx_for_reader,
                )
                .await;
            }
        });

        Ok(Self {
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending,
            _child: Arc::new(Mutex::new(Some(child))),
            notifications,
            preview_frames_tx,
            nav_tx,
        })
    }

    /// Subscribe to the latest-wins preview-frame channel. Initial value is
    /// `None`. Each subscriber sees the MOST RECENT frame on `changed()` —
    /// intermediate frames are dropped by design.
    pub fn subscribe_preview(&self) -> watch::Receiver<Option<PreviewFrame>> {
        self.preview_frames_tx.subscribe()
    }

    /// Subscribe to the latest-wins nav-state channel. Sidecar broadcasts
    /// every author session's nav state on the same wire; subscribers
    /// filter by `stream_id`.
    pub fn subscribe_nav(&self) -> watch::Receiver<Option<NavSnapshot>> {
        self.nav_tx.subscribe()
    }

    /// Start the CDP screencast in the sidecar.
    pub async fn call_preview_start(&self) -> Result<()> {
        self.call("startPreviewStream", json!({})).await?;
        Ok(())
    }

    /// Stop the CDP screencast. Preview lifecycle errors must not cascade
    /// into recording lifecycle (intentional isolation, not a workaround).
    /// Caller always sees Ok.
    pub async fn call_preview_stop(&self) -> Result<()> {
        if let Err(err) = self.call("stopPreviewStream", json!({})).await {
            tracing::warn!(
                target: "storycapture::preview",
                error = %err,
                "stopPreviewStream failed; continuing"
            );
        }
        Ok(())
    }

    /// Spawn an ephemeral author-time Chromium session keyed by `stream_id`.
    /// Separate from the recording session; initial URL is optional. Required
    /// by editor-surface Live Preview + simulator.
    pub async fn call_author_launch(
        &self,
        stream_id: &str,
        url: Option<&str>,
        viewport: Option<(u32, u32)>,
        browser_environment: &BrowserEnvironment,
    ) -> Result<()> {
        let mut params = json!({ "streamId": stream_id, "headless": true });
        if let Some(u) = url {
            params["url"] = json!(u);
        }
        if let Some((w, h)) = viewport {
            params["viewport"] = json!({ "width": w, "height": h });
        }
        params["browserEnvironment"] = browser_environment_json(browser_environment);
        self.call("author.launch", params).await?;
        Ok(())
    }

    pub async fn call_author_session_profile(
        &self,
        stream_id: &str,
    ) -> Result<BrowserSessionProfile> {
        let v = self
            .call("author.sessionProfile", json!({ "streamId": stream_id }))
            .await?;
        let profile: SidecarSessionProfile = serde_json::from_value(v)
            .map_err(|e| AutomationError::Protocol(format!("author.sessionProfile decode: {e}")))?;
        Ok(profile.into())
    }

    /// Tear down an author-time session. Idempotent.
    pub async fn call_author_close(&self, stream_id: &str) -> Result<()> {
        if let Err(err) = self
            .call("author.close", json!({ "streamId": stream_id }))
            .await
        {
            tracing::warn!(
                target: "storycapture::preview",
                error = %err,
                stream_id,
                "author.close failed; continuing"
            );
        }
        Ok(())
    }

    /// Drive `page.setViewportSize` on an author session.
    pub async fn call_author_set_viewport(
        &self,
        stream_id: &str,
        width: u32,
        height: u32,
    ) -> Result<()> {
        self.call(
            "author.setViewport",
            json!({ "streamId": stream_id, "width": width, "height": height }),
        )
        .await?;
        Ok(())
    }

    /// Forward a pointer/wheel event from the renderer's LivePreview canvas
    /// into the headless author browser. Coordinates are in page viewport
    /// space (the renderer transforms canvas px → page px before calling).
    pub async fn call_author_dispatch_input(
        &self,
        stream_id: &str,
        event: &serde_json::Value,
    ) -> Result<()> {
        self.call(
            "author.dispatchInput",
            json!({ "streamId": stream_id, "event": event }),
        )
        .await?;
        Ok(())
    }

    /// Navigate an author session's page to a new URL without relaunching.
    pub async fn call_author_goto(&self, stream_id: &str, url: &str) -> Result<()> {
        self.call("author.goto", json!({ "streamId": stream_id, "url": url }))
            .await?;
        Ok(())
    }

    /// URL-bar Back. Returns Ok even when the session is at index 0 — the
    /// sidecar reports `{ ok: false, reason: "no-history" }` and host treats
    /// it as a no-op (the UI gates the button via canGoBack).
    pub async fn call_author_back(&self, stream_id: &str) -> Result<()> {
        self.call("author.goBack", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
    }

    /// URL-bar Forward. See `call_author_back` for the no-op semantics.
    pub async fn call_author_forward(&self, stream_id: &str) -> Result<()> {
        self.call("author.goForward", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
    }

    /// URL-bar Reload. Always re-emits a `preview/nav` notification so the
    /// frontend can clear any pending state.
    pub async fn call_author_reload(&self, stream_id: &str) -> Result<()> {
        self.call("author.reload", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
    }

    /// Tell the sidecar which author session should receive subsequent bare
    /// verbs (goto/click/etc.). Pass `None` to clear.
    ///
    /// The simulator sets this at start and clears it on cancel / natural end
    /// so the shared author driver's verbs land on the author session's page
    /// instead of the recording page (which is `None` in preview-only mode).
    pub async fn set_active_author_stream(&self, stream_id: Option<&str>) -> Result<()> {
        let payload = match stream_id {
            Some(s) => serde_json::json!({ "streamId": s }),
            None => serde_json::json!({ "streamId": null }),
        };
        self.call("setActiveAuthorStream", payload).await?;
        Ok(())
    }

    /// Start the CDP screencast for a named author session.
    pub async fn call_preview_start_stream(&self, stream_id: &str) -> Result<()> {
        self.call("startPreviewStream", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
    }

    /// Stop the CDP screencast for a named author session.
    pub async fn call_preview_stop_stream(&self, stream_id: &str) -> Result<()> {
        if let Err(err) = self
            .call("stopPreviewStream", json!({ "streamId": stream_id }))
            .await
        {
            tracing::warn!(
                target: "storycapture::preview",
                error = %err,
                stream_id,
                "stopPreviewStream(streamId) failed; continuing"
            );
        }
        Ok(())
    }

    /// Pause screencast on a live session without tearing it down. Simulator
    /// and picker use this as an exclusive-lock primitive. Idempotent.
    pub async fn call_pause_stream(&self, stream_id: &str) -> Result<()> {
        self.call("pauseStream", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
    }

    /// Resume a paused screencast. Idempotent.
    pub async fn call_resume_stream(&self, stream_id: &str) -> Result<()> {
        self.call("resumeStream", json!({ "streamId": stream_id }))
            .await?;
        Ok(())
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
            // Extra Chromium args (chrome-hiding --app=<url>).
            "args": config.args,
            "browserEnvironment": browser_environment_json(&config.browser_environment),
            "storageState": config.storage_state_json,
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
        self.call(
            "click",
            json!({
                "selector": sel.value,
                "strategy": sel.strategy.as_str(),
                "nth": sel.nth,
            }),
        )
        .await?;
        Ok(())
    }

    async fn type_text(&self, sel: &ResolvedSelector, text: &str) -> Result<()> {
        self.call(
            "type",
            json!({
                "selector": sel.value,
                "strategy": sel.strategy.as_str(),
                "text": text,
                "nth": sel.nth,
            }),
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
        self.call(
            "hover",
            json!({
                "selector": sel.value,
                "strategy": sel.strategy.as_str(),
                "nth": sel.nth,
            }),
        )
        .await?;
        Ok(())
    }

    async fn drag(&self, from: &ResolvedSelector, to: &ResolvedSelector) -> Result<()> {
        self.call(
            "drag",
            json!({
                "from": from.value,
                "fromNth": from.nth,
                "to": to.value,
                "toNth": to.nth,
            }),
        )
        .await?;
        Ok(())
    }

    async fn select_option(&self, sel: &ResolvedSelector, value: &str) -> Result<()> {
        self.call(
            "select",
            json!({ "selector": sel.value, "value": value, "nth": sel.nth }),
        )
        .await?;
        Ok(())
    }

    async fn upload_file(&self, sel: &ResolvedSelector, path: &Path) -> Result<()> {
        self.call(
            "upload",
            json!({
                "selector": sel.value,
                "path": path.to_string_lossy(),
                "nth": sel.nth,
            }),
        )
        .await?;
        Ok(())
    }

    async fn wait_ms(&self, ms: u64) -> Result<()> {
        self.call("waitMs", json!({ "ms": ms })).await?;
        Ok(())
    }

    async fn wait_for(
        &self,
        target: &SelectorOrText,
        target_nth: Option<u32>,
        timeout_ms: u64,
    ) -> Result<()> {
        self.call(
            "waitFor",
            json!({
                "target": target_to_json(target, target_nth),
                "timeoutMs": timeout_ms,
            }),
        )
        .await?;
        Ok(())
    }

    async fn assert_present(&self, target: &SelectorOrText, target_nth: Option<u32>) -> Result<()> {
        self.call(
            "assert",
            json!({ "target": target_to_json(target, target_nth) }),
        )
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

/// Process info for the launched browser, returned by the sidecar's
/// `browserProcess` JSON-RPC verb.
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
    /// The sidecar logs `executable_path` at DEBUG only; this method does
    /// not emit it at any level to avoid host-side leak.
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
        browser_environment: Option<&BrowserEnvironment>,
        storage_state_json: Option<&str>,
    ) -> Result<SnapshotResponse> {
        let mut params = serde_json::json!({ "url": url });
        if let Some((w, h)) = viewport {
            params["viewport"] = serde_json::json!({ "width": w, "height": h });
        }
        if let Some(t) = timeout_ms {
            params["timeoutMs"] = serde_json::json!(t);
        }
        if let Some(env) = browser_environment {
            params["browserEnvironment"] = browser_environment_json(env);
        }
        if let Some(storage_state) = storage_state_json {
            params["storageState"] = serde_json::json!(storage_state);
        }
        let v = self.call("captureSnapshot", params).await?;
        let resp: SnapshotResponse = serde_json::from_value(v)
            .map_err(|e| AutomationError::Protocol(format!("captureSnapshot decode: {e}")))?;
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

// Parse+dispatch for a single stdout line. Extracted from the reader task
// so integration tests can drive it without spawning a Node sidecar child
// process. Doc-hidden: not part of the public API.
#[doc(hidden)]
pub async fn handle_sidecar_line(
    line: &str,
    pending: &Pending,
    notifications: &broadcast::Sender<Notification>,
    preview_tx: &watch::Sender<Option<PreviewFrame>>,
    nav_tx: &watch::Sender<Option<NavSnapshot>>,
) {
    let resp: JsonRpcResponse = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(target: "automation::playwright", "bad JSON from sidecar: {e}: {line}");
            return;
        }
    };
    match (resp.id, resp.method.as_deref()) {
        (Some(id), _) => {
            let mut p = pending.lock().await;
            if let Some(tx) = p.remove(&id) {
                let _ = tx.send(if let Some(err) = resp.error {
                    Err(err.message)
                } else {
                    Ok(resp.result.unwrap_or(Value::Null))
                });
            }
        }
        (None, Some(method)) => {
            let params = resp.params.unwrap_or(Value::Null);
            if method == "preview/frame" {
                match serde_json::from_value::<PreviewFrame>(params.clone()) {
                    Ok(frame) => {
                        let _ = preview_tx.send(Some(frame));
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "automation::playwright",
                            error = %err,
                            "malformed preview/frame params"
                        );
                    }
                }
            } else if method == "preview/nav" {
                match serde_json::from_value::<NavSnapshot>(params.clone()) {
                    Ok(snap) => {
                        let _ = nav_tx.send(Some(snap));
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "automation::playwright",
                            error = %err,
                            "malformed preview/nav params"
                        );
                    }
                }
            } else {
                tracing::debug!(
                    target: "automation::playwright",
                    method,
                    "sidecar notification"
                );
            }
            let note = Notification {
                method: method.to_string(),
                params,
            };
            let _ = notifications.send(note);
        }
        _ => {
            tracing::warn!(
                target: "automation::playwright",
                "malformed line (no id, no method): {line}"
            );
        }
    }
}

fn target_to_json(t: &SelectorOrText, nth: Option<u32>) -> Value {
    let mut v = match t {
        SelectorOrText::Text(s) => json!({ "kind": "text", "value": s }),
        SelectorOrText::Selector(s) => json!({ "kind": "selector", "value": s }),
        SelectorOrText::TestId(s) => json!({ "kind": "testid", "value": s }),
        SelectorOrText::Aria(s) => json!({ "kind": "aria", "value": s }),
        // sidecar `locate()` consumes these in `targetToLocator()`.
        SelectorOrText::Role { role, name } => json!({
            "kind": "role",
            "value": { "role": role.as_kebab(), "name": name }
        }),
        SelectorOrText::Label(s) => json!({ "kind": "label", "value": s }),
        SelectorOrText::TextExact(s) => json!({ "kind": "text_exact", "value": s }),
    };
    // Attach nth as a sibling field on the same JSON object so the sidecar's
    // `targetToLocator()` can read it without separate plumbing. Skip when
    // None to keep wire format byte-identical to pre-Fix-#4 messages.
    if let Some(n) = nth {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("nth".to_string(), json!(n));
        }
    }
    v
}

// ──────────────────────────────────────────────────────────────────────
// element-picker JSON-RPC wrappers.
//
// CONTRACT: the `Picked` variant's field MUST be named `emitted: String`
// — this matches the sidecar wire field at `scripts/playwright-sidecar/
// server.mjs`. Renaming (e.g. `dsl_line`) breaks the picker UI flow.
// ──────────────────────────────────────────────────────────────────────

/// Discriminator for ranked DSL candidates emitted by the sidecar's picker
/// generator. Wire format is snake_case so legacy JSON stays valid. An
/// `Unknown` arm captures any future kind the sidecar adds without
/// breaking decode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickKind {
    Testid,
    Role,
    Label,
    TextExact,
    Selector,
    #[serde(other)]
    Unknown,
}

/// Reason a pickElement session resolved without a pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PickCancelReason {
    UserCancel,
    Navigation,
    Timeout,
    UnsupportedUrl,
    #[serde(other)]
    Unknown,
}

/// Locator description from the sidecar's ranked DSL generator.
/// `value` is a string for testid/selector/label/text_exact, or an
/// object `{ role, name }` for the role kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickLocator {
    pub kind: PickKind,
    pub value: Value,
}

/// One scored candidate from the ranked generator (same shape as the
/// chosen locator plus a score and uniqueness flag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickCandidate {
    pub kind: PickKind,
    pub value: Value,
    pub score: f64,
    #[serde(default)]
    pub unique: bool,
}

/// Element-shape metadata forwarded by the sidecar overlay so the desktop
/// picker action menu can promote input-flavored actions
/// (fill/type/select/upload). Kept loose because the host re-serializes
/// the response untouched and only the desktop UI reads the contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickElementMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessible_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_content_editable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_text_input: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_file_input: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_labels: Option<Vec<String>>,
}

/// Sidecar `pickElement.start` response. Untagged so serde discriminates
/// on field shape: `Picked` requires `emitted`; `Cancelled` requires
/// `cancelled: true` + `reason`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PickElementResponse {
    Picked {
        // CONTRACT: field is `emitted: String`. Do not rename.
        emitted: String,
        locator: PickLocator,
        candidates: Vec<PickCandidate>,
        // Optional element-shape metadata. Skip serialization when absent
        // so legacy fixtures still round-trip unchanged. The host re-
        // serializes the response, so the field has to be modelled here
        // for it to survive the boundary.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<PickElementMeta>,
    },
    Cancelled {
        cancelled: bool, // always true; kept for serde-untagged disambiguation
        reason: PickCancelReason,
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

    /// Start a pickElement session against an author-session page keyed by
    /// `stream_id`. The sidecar routes to
    /// `state.authorSessions.get(stream_id).page`; unknown streamId surfaces
    /// as an `AutomationError::Browser(..)` with the `-32000` payload.
    pub async fn pick_element_start_author(
        &self,
        stream_id: &str,
        timeout_ms: u64,
    ) -> Result<PickElementResponse> {
        let v = self
            .call(
                "pickElement.start",
                json!({ "streamId": stream_id, "timeoutMs": timeout_ms }),
            )
            .await?;
        serde_json::from_value(v)
            .map_err(|e| AutomationError::Protocol(format!("pickElement.start decode: {e}")))
    }

    /// Read the current URL of an author-session page. Used by
    /// `replay_navigate_verbs` to skip warm-up when the user has already
    /// browsed past the script's destination URL — re-navigating would
    /// yank them back to the start page.
    pub async fn author_current_url(&self, stream_id: &str) -> Result<String> {
        let v = self
            .call("author.currentUrl", json!({ "streamId": stream_id }))
            .await?;
        Ok(v.get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Navigate a specific author-session page to a URL AND wait for
    /// `networkidle` (bounded 10s by the sidecar). Used by
    /// `replay_navigate_verbs` to warm the author browser on picker start.
    /// Non-http(s) URLs and unknown streamIds surface as `Protocol` / `Browser`
    /// errors respectively (-32602 / -32000 on the wire).
    pub async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<()> {
        self.call(
            "author.navigateTo",
            json!({ "streamId": stream_id, "url": url }),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod notification_tests {
    // JSON-RPC notification plumbing.
    //
    // These tests assert the broadcast semantics for id-absent JSON-RPC
    // messages. They exercise the primitives (broadcast::channel +
    // JsonRpcResponse serde) rather than the reader loop so they run
    // without spawning a Node sidecar.
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
        let line =
            r#"{"jsonrpc":"2.0","method":"pickElement.hoverPreview","params":{"role":"button"}}"#;
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
                ..
            } => {
                assert_eq!(emitted, "click testid \"save\"");
                assert_eq!(locator.kind, PickKind::Testid);
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
                assert_eq!(locator.kind, PickKind::Role);
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
                assert_eq!(reason, PickCancelReason::Navigation);
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
            PickElementResponse::Cancelled {
                reason: PickCancelReason::UserCancel,
                ..
            }
        ));
    }

    #[test]
    fn cancelled_unsupported_url() {
        let json = serde_json::json!({ "cancelled": true, "reason": "unsupported-url" });
        let r: PickElementResponse = serde_json::from_value(json).unwrap();
        assert!(matches!(
            r,
            PickElementResponse::Cancelled {
                reason: PickCancelReason::UnsupportedUrl,
                ..
            }
        ));
    }
}

#[cfg(test)]
mod tier1_target_to_json_tests {
    use super::*;
    use story_parser::AriaRole;

    #[test]
    fn role_encodes_as_object_value_with_kebab_role_and_name() {
        let v = target_to_json(
            &SelectorOrText::Role {
                role: AriaRole::Button,
                name: "Save".into(),
            },
            None,
        );
        assert_eq!(v["kind"], "role");
        assert_eq!(v["value"]["role"], "button");
        assert_eq!(v["value"]["name"], "Save");
    }

    #[test]
    fn role_preserves_colon_in_name() {
        let v = target_to_json(
            &SelectorOrText::Role {
                role: AriaRole::Link,
                name: "Go: now".into(),
            },
            None,
        );
        assert_eq!(v["value"]["name"], "Go: now");
    }

    #[test]
    fn label_encodes_as_string_value() {
        let v = target_to_json(&SelectorOrText::Label("Email".into()), None);
        assert_eq!(v["kind"], "label");
        assert_eq!(v["value"], "Email");
    }

    #[test]
    fn text_exact_encodes_with_snake_case_kind() {
        let v = target_to_json(&SelectorOrText::TextExact("Learn more".into()), None);
        assert_eq!(v["kind"], "text_exact");
        assert_eq!(v["value"], "Learn more");
    }

    #[test]
    fn legacy_variants_unchanged() {
        assert_eq!(
            target_to_json(&SelectorOrText::Text("x".into()), None)["kind"],
            "text"
        );
        assert_eq!(
            target_to_json(&SelectorOrText::Selector("#x".into()), None)["kind"],
            "selector"
        );
        assert_eq!(
            target_to_json(&SelectorOrText::TestId("x".into()), None)["kind"],
            "testid"
        );
        assert_eq!(
            target_to_json(&SelectorOrText::Aria("x".into()), None)["kind"],
            "aria"
        );
    }

    // ─── nth field on the wire ────────────────────────────────────────

    #[test]
    fn nth_some_attaches_to_target_envelope() {
        let v = target_to_json(&SelectorOrText::TestId("row".into()), Some(2));
        assert_eq!(v["kind"], "testid");
        assert_eq!(v["value"], "row");
        assert_eq!(v["nth"], 2);
    }

    #[test]
    fn nth_none_omits_field() {
        let v = target_to_json(&SelectorOrText::TestId("row".into()), None);
        assert!(v.get("nth").is_none(), "nth=None must be omitted");
    }

    #[test]
    fn nth_attaches_to_role_envelope() {
        let v = target_to_json(
            &SelectorOrText::Role {
                role: AriaRole::Button,
                name: "Save".into(),
            },
            Some(3),
        );
        assert_eq!(v["kind"], "role");
        assert_eq!(v["nth"], 3);
        // nth is a SIBLING of value, not nested inside it.
        assert!(v["value"].get("nth").is_none());
    }
}
