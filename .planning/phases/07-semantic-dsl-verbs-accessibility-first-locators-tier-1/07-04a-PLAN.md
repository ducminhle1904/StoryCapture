---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04a
type: execute
wave: 5
depends_on:
  - 07-03b
files_modified:
  - crates/automation/src/playwright_driver.rs
  - scripts/playwright-sidecar/server.mjs
  - scripts/playwright-sidecar/server.test.mjs
  - scripts/playwright-sidecar/picker/overlay/index.ts
  - apps/desktop/src-tauri/src/commands/picker.rs
  - apps/desktop/src-tauri/src/lib.rs
  - apps/desktop/src/ipc/picker.ts
  - apps/desktop/src/features/recorder/pick-element-button.tsx
  - apps/desktop/src/features/recorder/pick-element-button.test.tsx
autonomous: true
requirements:
  - PHASE-7.5
tags: dsl, picker, notifications, hover-preview
must_haves:
  truths:
    - "JsonRpcResponse now has `id: Option<u64>` and `method: Option<String>` — id-absent messages are dispatched to a tokio broadcast channel for notification subscribers"
    - "pickElement.hoverPreview fires during hover; sidecar writes id-absent JSON-RPC notifications to stdout on every rAF-throttled overlay hover"
    - "Tauri event bridge `picker_hover_preview` forwards broadcast notifications to the React shell"
    - "React shell subscribes while picking and renders a live preview chip near the top of the desktop window showing the top candidate"
    - "Broadcast channel: multiple subscribers can receive notifications; lost message (lagged subscriber) is logged at warn level, not panicked"
    - "Pre-existing Tier 1 + Tier 2 MVP vitest cases still pass (regression guard — JsonRpcResponse remains backward-compatible for responses because `result`/`error` remain unchanged)"
  artifacts:
    - path: "crates/automation/src/playwright_driver.rs"
      provides: "JsonRpcResponse.id: Option<u64> + method/params fields; notifications broadcast::Sender<Notification> dispatch; subscribe_notifications() public API"
      contains: "broadcast::Sender"
    - path: "scripts/playwright-sidecar/server.mjs"
      provides: "writeNotification helper + hoverPreview notification emission on every overlay hover (id-absent JSON-RPC message)"
      contains: "hoverPreview"
    - path: "scripts/playwright-sidecar/picker/overlay/index.ts"
      provides: "rAF-throttled hover handler calling window.__sc_picker_hover(payload)"
      contains: "requestAnimationFrame"
    - path: "apps/desktop/src-tauri/src/commands/picker.rs"
      provides: "spawn_notification_forwarder: tokio task bridging broadcast → Tauri event emit('picker_hover_preview', ...)"
      contains: "picker_hover_preview"
    - path: "apps/desktop/src/features/recorder/pick-element-button.tsx"
      provides: "useEffect subscribes to picker_hover_preview while picking; renders preview chip"
      contains: "PickHoverPayload"
  key_links:
    - from: "overlay mouseover handler"
      to: "sidecar hoverPreview notification emission"
      via: "exposeBinding('__sc_picker_hover') → writes id-absent JSON-RPC to stdout"
      pattern: "hoverPreview"
    - from: "sidecar id-absent stdout line"
      to: "playwright_driver.rs notifications broadcast channel"
      via: "reader loop branches on resp.id.is_none() + resp.method.is_some()"
      pattern: "resp.id.is_none"
    - from: "PlaywrightSidecarDriver::subscribe_notifications"
      to: "PickElementButton React subscriber"
      via: "Tauri event bridge (new `picker_hover_preview` event)"
      pattern: "picker_hover_preview"
---

<objective>
Ship the hover-preview vertical slice: JSON-RPC notification plumbing, sidecar+overlay hover emission, Tauri event bridge, and React preview chip. Extends 07-03b's `PickElementButton` without touching it destructively.

Purpose: Give users live feedback during picking — the top candidate for the currently-hovered element appears in a desktop chip before they click. Requires changing `JsonRpcResponse.id` to `Option<u64>` (additive struct change that remains backward-compatible for responses because `result`/`error` are unchanged) and adding a broadcast channel for notification fan-out.

Output: `JsonRpcResponse.id: Option<u64>` + broadcast dispatch; `subscribe_notifications()` public API; overlay rAF-throttled hover emit; sidecar `writeNotification` + `exposeBinding('__sc_picker_hover')`; Rust forwarder task emitting Tauri `picker_hover_preview` event; TS `listenPickerHoverPreview` wrapper; `PickElementButton` preview chip subscribing while picking; sidecar vitest proving at least one hoverPreview reaches stdout; Rust tests for multi-subscriber + lagged + notification-parse; 6 PickElementButton tests (4 from 07-03b + 2 new).
</objective>

<scope>
**EXPLICITLY IN SCOPE:**
- `JsonRpcResponse.id: Option<u64>` + `method/params` fields + reader-loop branching to broadcast channel.
- `PlaywrightSidecarDriver::subscribe_notifications()` returning `broadcast::Receiver<Notification>`.
- Sidecar `writeNotification` helper + `__sc_picker_hover` exposeBinding + hoverPreview notification emission.
- Overlay rAF-throttled mouseover → `window.__sc_picker_hover(payload)`.
- `spawn_notification_forwarder` Tauri task → `emit("picker_hover_preview", ...)`.
- TS `listenPickerHoverPreview(cb): Promise<UnlistenFn>`.
- `PickElementButton` preview chip (role="note", aria-live="polite") subscribed while picking.
- Rust unit tests: multi-subscriber, lagged-subscriber, notification parse, response parse (4 tests).
- Sidecar vitest: hoverPreview notification appears on stdout during active pick.
- React vitest: chip renders and updates across two hover events (2 new tests added to the 4 from 07-03b).

**EXPLICITLY OUT OF SCOPE:**
- Parser step-id round-trip + formatter (07-04b).
- Targets store + self-healing + stamp-on-pick (07-04c).
</scope>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-RESEARCH-TIER2.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03a-SUMMARY.md
@.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-03b-SUMMARY.md
@CLAUDE.md

@crates/automation/src/playwright_driver.rs
@scripts/playwright-sidecar/server.mjs
@scripts/playwright-sidecar/picker/overlay/index.ts
@apps/desktop/src/features/recorder/pick-element-button.tsx
@apps/desktop/src/ipc/picker.ts

<interfaces>
<!-- New contracts established by this plan: -->
```rust
// crates/automation/src/playwright_driver.rs
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<u64>,          // CHANGED — was u64
    pub method: Option<String>,   // NEW — present only on notifications
    pub params: Option<Value>,    // NEW — notification payload
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

impl PlaywrightSidecarDriver {
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<Notification>;
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: JSON-RPC notification plumbing — Option id + method field + broadcast channel + overlay rAF hover emission + hoverPreview handler + sidecar vitest</name>
  <files>crates/automation/src/playwright_driver.rs, scripts/playwright-sidecar/server.mjs, scripts/playwright-sidecar/picker/overlay/index.ts, scripts/playwright-sidecar/server.test.mjs</files>
  <read_first>
    - crates/automation/src/playwright_driver.rs lines 80-110 (reader task — `parsed: JsonRpcResponse` dispatch by id)
    - crates/automation/src/playwright_driver.rs lines 60-80 (JsonRpcResponse struct definition)
    - scripts/playwright-sidecar/server.mjs (JSON-RPC write helper — confirm how current responses serialize so notifications can share the wire format)
    - scripts/playwright-sidecar/picker/overlay/index.ts (existing mouseover handler from 07-03a)
    - .planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md §Tier 2 robustness §JSON-RPC notification plumbing
  </read_first>
  <behavior>
    - `JsonRpcResponse.id` becomes `Option<u64>`; struct gains `method: Option<String>` and `params: Option<Value>`.
    - Reader loop: if `resp.id.is_some()` → old path (pending map). If `resp.id.is_none() && resp.method.is_some()` → construct `Notification { method, params }` and send to the broadcast channel. Otherwise log as malformed and continue.
    - `PlaywrightSidecarDriver::spawn` creates the broadcast channel with capacity 128; `subscribe_notifications()` returns a receiver.
    - `server.mjs` gains a `writeNotification(method, params)` helper that writes `{"jsonrpc":"2.0","method":"<method>","params":{...}}` (no id) to stdout.
    - Overlay `mouseover` handler: throttles to next `requestAnimationFrame` frame; on fire, builds a lightweight `{ testId, role, accessibleName, boundingRect }` payload and calls `window.__sc_picker_hover(payload)`.
    - `server.mjs` exposes `__sc_picker_hover` binding via `page.exposeBinding` (alongside the existing `__sc_picker_emit` in 07-03a's `pickElement.start`). On invocation, emits `writeNotification("pickElement.hoverPreview", payload)`.
    - Notification multi-subscriber + lagged behavior: two `subscribe_notifications()` receivers both get every notification under normal load; if one lags past capacity, it receives a `RecvError::Lagged(n)` which is logged via `tracing::warn!` and the reader continues.
  </behavior>
  <action>
1. **Edit `crates/automation/src/playwright_driver.rs`.** Update `JsonRpcResponse` and add notification plumbing:
   ```rust
   #[derive(Debug, Clone, Deserialize)]
   pub struct JsonRpcResponse {
       #[serde(default)]
       pub jsonrpc: String,
       #[serde(default)]
       pub id: Option<u64>,
       #[serde(default)]
       pub method: Option<String>,
       #[serde(default)]
       pub params: Option<serde_json::Value>,
       #[serde(default)]
       pub result: Option<serde_json::Value>,
       #[serde(default)]
       pub error: Option<JsonRpcError>,
   }

   #[derive(Debug, Clone)]
   pub struct Notification {
       pub method: String,
       pub params: serde_json::Value,
   }
   ```
   Add `use tokio::sync::broadcast;` at the top if not present.

2. **Extend the struct** with a broadcast sender:
   ```rust
   pub struct PlaywrightSidecarDriver {
       stdin: Mutex<...>,
       next_id: AtomicU64,
       pending: Pending,
       _child: Arc<Mutex<Option<tokio::process::Child>>>,
       notifications: broadcast::Sender<Notification>,   // NEW
   }
   ```
   In `spawn`, construct `let (notifications, _rx) = broadcast::channel(128);`.

3. **Update the reader loop** (currently around line 86-109):
   ```rust
   tokio::spawn({
       let notifications = notifications.clone();
       async move {
           let mut lines = BufReader::new(stdout).lines();
           while let Ok(Some(line)) = lines.next_line().await {
               if line.is_empty() { continue; }
               let parsed: std::result::Result<JsonRpcResponse, _> = serde_json::from_str(&line);
               let resp = match parsed {
                   Ok(r) => r,
                   Err(e) => { tracing::warn!(target: "automation::playwright", "bad JSON from sidecar: {e}: {line}"); continue; }
               };
               match (resp.id, &resp.method) {
                   (Some(id), _) => {
                       let mut p = pending_for_reader.lock().await;
                       if let Some(tx) = p.remove(&id) {
                           let _ = tx.send(if let Some(err) = resp.error {
                               Err(err.message)
                           } else {
                               Ok(resp.result.unwrap_or(serde_json::Value::Null))
                           });
                       }
                   }
                   (None, Some(method)) => {
                       let note = Notification {
                           method: method.clone(),
                           params: resp.params.unwrap_or(serde_json::Value::Null),
                       };
                       let _ = notifications.send(note);
                   }
                   _ => {
                       tracing::warn!(target: "automation::playwright", "malformed line (no id, no method): {line}");
                   }
               }
           }
       }
   });
   ```

4. **Add `subscribe_notifications`** to the impl:
   ```rust
   impl PlaywrightSidecarDriver {
       pub fn subscribe_notifications(&self) -> broadcast::Receiver<Notification> {
           self.notifications.subscribe()
       }
   }
   ```

5. **Edit `scripts/playwright-sidecar/server.mjs`.** Add a `writeNotification` helper:
   ```js
   function writeNotification(method, params) {
     process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
   }
   ```

6. **Extend the `pickElement.start` handler** (07-03a) to also expose `__sc_picker_hover`:
   ```js
   // Inside pickElement.start, alongside the existing __sc_picker_emit binding:
   await state.page.exposeBinding('__sc_picker_hover', async ({ }, payload) => {
     writeNotification('pickElement.hoverPreview', payload);
   }).catch(() => { /* already exposed */ });
   ```
   Also register this binding eagerly on launch (after `addInitScript`) so subsequent pick sessions don't re-expose.

7. **Edit `scripts/playwright-sidecar/picker/overlay/index.ts`.** Add rAF-throttled mouseover emission:
   ```ts
   let rafScheduled: number | null = null;
   let lastHovered: Element | null = null;
   function onMouseOver(e: MouseEvent) {
     lastHovered = e.target as Element;
     if (rafScheduled !== null) return;
     rafScheduled = requestAnimationFrame(() => {
       rafScheduled = null;
       if (!lastHovered) return;
       const rect = lastHovered.getBoundingClientRect();
       const payload = {
         testId: lastHovered.getAttribute('data-testid') ?? undefined,
         role: inferRole(lastHovered),
         accessibleName: accessibleName(lastHovered),
         boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
       };
       const hover = (window as any).__sc_picker_hover;
       if (typeof hover === 'function') hover(payload).catch(() => {});
     });
   }
   // Install in start(), remove in stop() alongside the other listeners
   ```

8. **Add Rust unit tests** for multi-subscriber + lagged + parse:
   ```rust
   #[cfg(test)]
   mod notification_tests {
       use tokio::sync::broadcast;
       use super::Notification;

       #[tokio::test]
       async fn multi_subscriber_receives_all_notifications() {
           let (tx, _) = broadcast::channel::<Notification>(16);
           let mut a = tx.subscribe();
           let mut b = tx.subscribe();
           tx.send(Notification { method: "x".into(), params: serde_json::json!({"n": 1}) }).unwrap();
           tx.send(Notification { method: "x".into(), params: serde_json::json!({"n": 2}) }).unwrap();
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
               tx.send(Notification { method: "x".into(), params: serde_json::json!({"n": i}) }).unwrap_or_else(|_| panic!("send {i}"));
           }
           let r = rx.recv().await;
           assert!(matches!(r, Err(broadcast::error::RecvError::Lagged(_))), "expected Lagged, got {:?}", r);
       }

       #[test]
       fn response_with_no_id_and_method_parses_as_notification() {
           let line = r#"{"jsonrpc":"2.0","method":"pickElement.hoverPreview","params":{"role":"button"}}"#;
           let r: super::JsonRpcResponse = serde_json::from_str(line).unwrap();
           assert!(r.id.is_none());
           assert_eq!(r.method.as_deref(), Some("pickElement.hoverPreview"));
           assert_eq!(r.params.as_ref().unwrap()["role"], "button");
       }

       #[test]
       fn response_with_id_and_result_parses_as_response() {
           let line = r#"{"jsonrpc":"2.0","id":42,"result":{"ok":true}}"#;
           let r: super::JsonRpcResponse = serde_json::from_str(line).unwrap();
           assert_eq!(r.id, Some(42));
           assert!(r.method.is_none());
           assert_eq!(r.result.as_ref().unwrap()["ok"], true);
       }
   }
   ```

9. **Sidecar vitest case** in `server.test.mjs`: fire a `pickElement.start`, trigger a `mouseover` via a new `__test_simulate_hover` handler, assert at least one JSON line with `method: "pickElement.hoverPreview"` on stdout.
   ```js
   handlers['__test_simulate_hover'] = async ({ selector }) => {
     await state.page.evaluate((sel) => {
       const el = document.querySelector(sel);
       el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
     }, selector);
     return { ok: true };
   };
   ```
   Adapt `spawnSidecar` helper to buffer stdout lines if it doesn't already. Assertion:
   ```js
   it("pickElement.hoverPreview notifications fire during hover (rAF-throttled)", async () => {
     const start = sidecar.call("pickElement.start", { timeoutMs: 5000 });
     await new Promise(r => setTimeout(r, 100));
     await sidecar.call("__test_simulate_hover", { selector: "[data-testid='save-btn']" });
     await new Promise(r => setTimeout(r, 200));
     const notes = sidecar.stdoutLines().filter(l => l.includes('"hoverPreview"'));
     expect(notes.length).toBeGreaterThanOrEqual(1);
     await sidecar.call("pickElement.cancel", {});
     await start;
   });
   ```
  </action>
  <verify>
    <automated>cargo build -p automation 2>&1 | tail -5 && cargo test -p automation --lib -- notification_tests 2>&1 | tail -10 && cd scripts/playwright-sidecar && (pnpm test 2>&1 | tail -20) && cd - && grep -n "id: Option<u64>" crates/automation/src/playwright_driver.rs && grep -n "method: Option<String>" crates/automation/src/playwright_driver.rs && grep -n "broadcast::Sender<Notification>" crates/automation/src/playwright_driver.rs && grep -n "subscribe_notifications" crates/automation/src/playwright_driver.rs && grep -n "writeNotification" scripts/playwright-sidecar/server.mjs && grep -n "hoverPreview" scripts/playwright-sidecar/server.mjs && grep -n "__sc_picker_hover" scripts/playwright-sidecar/picker/overlay/index.ts && grep -n "requestAnimationFrame" scripts/playwright-sidecar/picker/overlay/index.ts</automated>
  </verify>
  <acceptance_criteria>
    - `cargo build -p automation` exits 0
    - `cargo test -p automation --lib -- notification_tests` passes all 4 tests
    - `grep -n "id: Option<u64>" crates/automation/src/playwright_driver.rs` matches
    - `grep -n "method: Option<String>" crates/automation/src/playwright_driver.rs` matches
    - `grep -n "subscribe_notifications" crates/automation/src/playwright_driver.rs` matches ≥ 2
    - `grep -n "writeNotification" scripts/playwright-sidecar/server.mjs` matches ≥ 2
    - `grep -n "exposeBinding.*__sc_picker_hover" scripts/playwright-sidecar/server.mjs` matches
    - `grep -n "requestAnimationFrame" scripts/playwright-sidecar/picker/overlay/index.ts` matches
    - Sidecar vitest hoverPreview case green
    - Pre-existing Tier 1 + Tier 2 MVP vitest cases still pass (regression guard)
  </acceptance_criteria>
  <done>Notification plumbing lands: id-absent JSON-RPC messages broadcast through a tokio channel with multi-subscriber + lagged behavior; hoverPreview notifications fire on rAF-throttled overlay hover; sidecar vitest confirms at least one notification reaches stdout during an active pick session.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Hover-preview React subscriber + Tauri event bridge + PickElementButton preview chip + vitest</name>
  <files>apps/desktop/src-tauri/src/commands/picker.rs, apps/desktop/src-tauri/src/lib.rs, apps/desktop/src/ipc/picker.ts, apps/desktop/src/features/recorder/pick-element-button.tsx, apps/desktop/src/features/recorder/pick-element-button.test.tsx</files>
  <read_first>
    - apps/desktop/src-tauri/src/commands/picker.rs (07-03b output)
    - apps/desktop/src/features/recorder/pick-element-button.tsx (07-03b output)
    - Tauri event bridging pattern in existing commands (look for `app_handle.emit_all` or similar in recorder commands)
    - Task 1 output: PlaywrightSidecarDriver::subscribe_notifications
  </read_first>
  <behavior>
    - On sidecar launch (or app setup), a Rust task spawns that: `let mut rx = driver.subscribe_notifications();` loops `rx.recv()`, and for each Notification whose `method == "pickElement.hoverPreview"` calls `app_handle.emit("picker_hover_preview", note.params)`.
    - The TS layer exposes `listenPickerHoverPreview(cb): Promise<UnlistenFn>` that wraps `listen<PickHoverPayload>("picker_hover_preview", ...)` and returns the unlisten fn.
    - `PickElementButton` subscribes while `picking === true` (effect with unlisten on cleanup). Renders a small "preview chip" (fixed-position, ~200px wide) near the top showing the top candidate (role + name OR testid OR "[css fallback]").
    - Lag tolerance: if the subscriber misses messages (RecvError::Lagged), the Rust task continues without panicking; logs at `tracing::warn`.
    - Vitest: with Tauri event mocks, dispatch fake `picker_hover_preview` events; assert chip rerenders with updated payload.
  </behavior>
  <action>
1. **Edit `apps/desktop/src-tauri/src/commands/picker.rs`** — add a setup function invoked after the driver is constructed:
   ```rust
   use tauri::{AppHandle, Manager};
   use tokio::task::JoinHandle;

   pub fn spawn_notification_forwarder(
       app: AppHandle,
       mut rx: tokio::sync::broadcast::Receiver<automation::playwright_driver::Notification>,
   ) -> JoinHandle<()> {
       tokio::spawn(async move {
           loop {
               match rx.recv().await {
                   Ok(note) if note.method == "pickElement.hoverPreview" => {
                       let _ = app.emit("picker_hover_preview", &note.params);
                   }
                   Ok(_other) => { /* ignore unknown notification methods for now */ }
                   Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                       tracing::warn!(target: "storycapture::picker", "hover subscriber lagged {n} messages");
                   }
                   Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
               }
           }
       })
   }
   ```
   Wire this spawn at driver-launch time. Only one forwarder needs to run per driver lifetime — guard with an `OnceCell<JoinHandle>` if the same driver may be re-referenced.

2. **Extend `apps/desktop/src/ipc/picker.ts`:**
   ```ts
   import { listen, type UnlistenFn } from "@tauri-apps/api/event";

   export interface PickHoverPayload {
     testId?: string;
     role?: string;
     accessibleName?: string;
     boundingRect?: { x: number; y: number; width: number; height: number };
   }

   export async function listenPickerHoverPreview(cb: (p: PickHoverPayload) => void): Promise<UnlistenFn> {
     return await listen<PickHoverPayload>("picker_hover_preview", (evt) => cb(evt.payload));
   }
   ```

3. **Extend `apps/desktop/src/features/recorder/pick-element-button.tsx`.** Add state + effect:
   ```tsx
   const [preview, setPreview] = useState<PickHoverPayload | null>(null);

   useEffect(() => {
     if (!picking) { setPreview(null); return; }
     let unlisten: UnlistenFn | undefined;
     listenPickerHoverPreview((p) => setPreview(p)).then((u) => { unlisten = u; });
     return () => { unlisten?.(); setPreview(null); };
   }, [picking]);
   ```
   Render the chip conditionally:
   ```tsx
   {picking && preview && typeof document !== "undefined" && createPortal(
     <div role="note" aria-live="polite" className="fixed left-1/2 top-14 z-50 -translate-x-1/2 rounded border bg-white/95 px-3 py-1 text-xs shadow-md">
       {preview.testId ? `testid "${preview.testId}"` :
         preview.role && preview.accessibleName ? `${preview.role} "${preview.accessibleName}"` :
         preview.accessibleName ? `text "${preview.accessibleName}"` :
         "[css fallback]"}
     </div>,
     document.body,
   )}
   ```

4. **Extend `pick-element-button.test.tsx`** with 2 new tests:
   - Dispatches a fake `picker_hover_preview` event with payload `{ role: "button", accessibleName: "Save" }`; assert a chip with text `button "Save"` renders
   - Second event with `{ testId: "save-btn" }`; assert chip updates to `testid "save-btn"`

   Use `@tauri-apps/api/mocks` event dispatch. Consult 07-03b's test for the pattern to follow.
  </action>
  <verify>
    <automated>cd apps/desktop/src-tauri && cargo check 2>&1 | tail -10 && cd - && cd apps/desktop && (pnpm test -- pick-element-button.test.tsx 2>&1 | tail -10) && cd - && grep -n "spawn_notification_forwarder" apps/desktop/src-tauri/src/commands/picker.rs && grep -n "picker_hover_preview" apps/desktop/src-tauri/src/commands/picker.rs && grep -n "listenPickerHoverPreview" apps/desktop/src/ipc/picker.ts && grep -n "PickHoverPayload" apps/desktop/src/features/recorder/pick-element-button.tsx</automated>
  </verify>
  <acceptance_criteria>
    - `cargo check` in `apps/desktop/src-tauri/` exits 0
    - `pnpm --filter @storycapture/desktop test -- pick-element-button.test.tsx` passes all 6 tests (4 from 07-03b + 2 new hover-preview cases)
    - `grep -n "spawn_notification_forwarder" apps/desktop/src-tauri/src/commands/picker.rs` matches
    - `grep -n "emit(\"picker_hover_preview\"" apps/desktop/src-tauri/src/commands/picker.rs` matches (single source of the Tauri event name)
    - `grep -n "listenPickerHoverPreview" apps/desktop/src/ipc/picker.ts` matches
    - `grep -n "role=\"note\"" apps/desktop/src/features/recorder/pick-element-button.tsx` matches (chip has semantic role)
    - Chip re-renders on subsequent events (vitest assertion)
  </acceptance_criteria>
  <done>Hover-preview chip subscribed via Tauri event bridge; Rust forwarder logs lagged subscribers rather than panicking; React vitest covers two consecutive hover payloads updating the chip.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Sidecar stdout ↔ Rust reader loop | Notification stream is now a second class of message (id-absent). Malformed lines must not panic the reader. |
| `__sc_picker_hover` binding ↔ page DOM | Hostile pages could call the binding directly, but it only affects the UI chip (no persisted state). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-04a-01 | DoS | Notification broadcast channel overflow | mitigate | Channel capacity 128; lagged subscribers receive `RecvError::Lagged(n)` and are logged — no panics. |
| T-07-04a-02 | Tampering | `pickElement.hoverPreview` could be spoofed by a hostile page calling `window.__sc_picker_hover` directly | accept | The binding only does anything if a `pickElement.start` is pending — hostile pages cannot self-trigger. Spoofed payloads only affect the UI chip, not any persisted state. |
| T-07-04a-03 | DoS | High-frequency mouseover events could flood stdout | mitigate | Overlay throttles emission to `requestAnimationFrame` (≤ 60Hz). |
</threat_model>

<verification>
1. `cargo test -p automation --lib -- notification_tests` exits 0 (4 tests)
2. `pnpm --filter @storycapture/playwright-sidecar test` exits 0 (hoverPreview case + regression on 07-03a cases)
3. `pnpm --filter @storycapture/desktop test -- pick-element-button.test.tsx` exits 0 (6 tests: 4 from 07-03b + 2 hover-preview)
4. `grep -n "id: Option<u64>" crates/automation/src/playwright_driver.rs` matches
5. `grep -n "subscribe_notifications" crates/automation/src/playwright_driver.rs` matches
</verification>

<success_criteria>
- [ ] `JsonRpcResponse.id: Option<u64>` + `method/params` fields; reader loop dispatches notifications to broadcast channel
- [ ] `PlaywrightSidecarDriver::subscribe_notifications` public API with multi-subscriber + lagged-behavior tests green
- [ ] Overlay rAF-throttled hover emission + sidecar `writeNotification` helper + sidecar vitest proving hoverPreview appears on stdout during active pick
- [ ] Tauri event bridge `picker_hover_preview` + React subscriber + chip component + 6 PickElementButton tests green
- [ ] Scope discipline: no parser/formatter/targets-store changes here (deferred to 04b/04c)
- [ ] PHASE-7.5 partially met (hover-preview slice)
</success_criteria>

<output>
After completion, create `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-04a-SUMMARY.md` capturing:
- JsonRpcResponse breaking-change rollout notes
- Final broadcast channel capacity + rationale
- Sidecar vitest timing for the hoverPreview assertion
- React chip layout notes (top-center portal)
- Any cross-crate coupling issues encountered
</output>
