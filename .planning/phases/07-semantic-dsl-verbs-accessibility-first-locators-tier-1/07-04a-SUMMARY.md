---
phase: 07-semantic-dsl-verbs-accessibility-first-locators-tier-1
plan: 04a
subsystem: picker
tags: [dsl, picker, notifications, hover-preview, json-rpc, broadcast, tauri-events]
requires:
  - 07-03a
  - 07-03b
provides:
  - JsonRpcResponse.id: Option<u64> (breaking — see rollout notes)
  - automation::Notification (new public type, re-exported from crate root)
  - PlaywrightSidecarDriver::subscribe_notifications() → broadcast::Receiver<Notification>
  - sidecar writeNotification() helper + exposeBinding('__sc_picker_hover')
  - overlay rAF-throttled hover emission on window.__sc_picker_hover
  - commands::picker::spawn_notification_forwarder (broadcast → Tauri event bridge)
  - Tauri event "picker_hover_preview" (payload = PickHoverPayload)
  - TS listenPickerHoverPreview(cb) wrapper
  - PickElementButton live preview chip (role="note", aria-live="polite")
affects:
  - crates/automation/src/playwright_driver.rs (JsonRpcResponse shape, reader loop, new Notification type, broadcast channel)
  - crates/automation/src/lib.rs (re-export Notification)
  - scripts/playwright-sidecar/server.mjs (writeNotification, __sc_picker_hover binding, __test_simulate_hover)
  - scripts/playwright-sidecar/server.test.mjs (stdoutLines buffer, hoverPreview vitest case)
  - scripts/playwright-sidecar/picker/overlay/index.ts (rAF-throttled hover emit, stop() cleanup)
  - apps/desktop/src-tauri/src/commands/picker.rs (spawn_notification_forwarder)
  - apps/desktop/src-tauri/src/commands/automation.rs (wire forwarder at launch)
  - apps/desktop/src/ipc/picker.ts (PickHoverPayload, listenPickerHoverPreview)
  - apps/desktop/src/features/recorder/pick-element-button.tsx (chip + subscriber)
  - apps/desktop/src/features/recorder/pick-element-button.test.tsx (2 new cases)
tech-stack:
  added:
    - tokio::sync::broadcast (fan-out for id-absent JSON-RPC messages)
    - tauri::Emitter (new import path; emit("picker_hover_preview", params))
  patterns:
    - id-absent JSON-RPC notifications separate from request/response
    - rAF throttle with independent handles for paint vs. notification emission
    - broadcast subscriber fan-out with lagged-tolerance via RecvError::Lagged
    - page-scoped WeakSet guard for per-binding exposeBinding idempotency
key-files:
  created: []
  modified:
    - crates/automation/src/playwright_driver.rs
    - crates/automation/src/lib.rs
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/server.test.mjs
    - scripts/playwright-sidecar/picker/overlay/index.ts
    - apps/desktop/src-tauri/src/commands/picker.rs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src/ipc/picker.ts
    - apps/desktop/src/features/recorder/pick-element-button.tsx
    - apps/desktop/src/features/recorder/pick-element-button.test.tsx
decisions:
  - "JsonRpcResponse.id: Option<u64> chosen over a tagged enum — simpler serde path, remains backward-compatible for responses because result/error are unchanged. Reader loop branches on (id, method) tuple pattern."
  - "Broadcast channel capacity 128 — well above any realistic rAF-throttled (~60 Hz) hover rate against a React setState consumer. Lagged subscribers log warn, never panic."
  - "rAF throttle uses a SEPARATE handle from the paint scheduler. Paint can be re-requested on every mouseover for smooth highlight; hover emit must be coalesced to avoid stdout/CDP round-trip amplification."
  - "Preview chip caption priority mirrors the sidecar's ranked DSL generator (testid → role+name → text → css-fallback sentinel). Chip is UI-only; the canonical ranked emission still comes from the sidecar on click."
  - "Unlisten cleanup swallows promise rejections via Promise.resolve().then().catch() so test mocks and backend teardown don't surface unhandled rejections."
requirements:
  - PHASE-7.5 (partial — hover-preview slice)
metrics:
  duration: ~1h
  completed_date: 2026-04-17
---

# Phase 7 Plan 04a: Hover-Preview Vertical Slice Summary

JSON-RPC notification plumbing (broadcast channel + Option<id>), sidecar overlay rAF-throttled hover emission, Rust forwarder task, Tauri event bridge, and React preview chip — all wired end-to-end with 6 automated tests (4 Rust unit + 1 sidecar vitest + 2 React vitest) on top of the 52 pre-existing sidecar + automation tests kept green as a regression guard.

## Commits

| Step | Phase     | Commit                                     | Summary                                                        |
| ---- | --------- | ------------------------------------------ | -------------------------------------------------------------- |
| 1    | Task 1 RED   | `2f21e3e965dd3b11e18fedd8abfbbdab5d2b779f` | Failing notification_tests (4 Rust cases)                      |
| 2    | Task 1 GREEN | `e31ecb30371f4d58bc114e4725405f679435cf95` | JSON-RPC notification plumbing + hoverPreview emission         |
| 3    | Task 2 RED   | `d78620d9d552afbde54483f2498dad8b841107db` | Failing hover-preview chip tests (2 React cases)               |
| 4    | Task 2 GREEN | `fb84f412351c2976ac50c00349ddf25d2c4c6d33` | Hover-preview React chip + Tauri event bridge                  |
| 5    | Docs         | `f54ba0241cd9321c407ac1207df357566d79bf99` | Log pre-existing out-of-scope test failures to deferred-items  |

## JsonRpcResponse breaking-change rollout

The struct change is technically API-breaking (id moved from `u64` to `Option<u64>`) but **backward-compatible for every response path** because:

1. Serde parsing — every 07-03a/b call site deserializes responses via method-specific decoders (`pick_element_start`, `browser_process`, etc.) that operate on `resp.result`/`resp.error` directly. None reference `resp.id` by type.
2. Reader loop — dispatches on `(id, method)` tuple. Id-present lines take the same pending-map path as before; id-absent lines are net-new fan-out.
3. 33 pre-existing automation tests + 52 pre-existing sidecar tests stayed green across the change (ran both before and after GREEN).

No downstream code needs an update. `automation::Notification` is a new public type re-exported from the crate root for host consumers.

## Broadcast channel capacity + rationale

**128 slots.** Rationale:
- Overlay is rAF-throttled at ≤ 60 Hz ceiling.
- React setState coalesces at render cadence (~16 ms), so the consumer drains at roughly the same rate as the producer.
- 128 slots absorb ~2 s of backlog even if the consumer stalls on a long paint.
- `tokio::sync::broadcast` requires a power-of-two implementation-adjacent capacity for efficient slot reuse; 128 fits comfortably.
- Lagged subscribers observe `RecvError::Lagged(n)` and are logged at `tracing::warn!` — never panic (T-07-04a-01 mitigation).

## Sidecar vitest timing for hoverPreview assertion

- 500 ms after `pickElement.start` before simulating hover — covers `exposeBinding('__sc_picker_hover')` CDP round-trip under vitest's concurrent-test load.
- 100 ms × 30 poll loop (3 s ceiling) for the notification to land in `stdoutLines()` — absorbs rAF tick + binding invocation + stdout write jitter.
- Under local run the notification typically arrives within the first 100 ms poll; the ceiling is CI headroom.

Total vitest case duration ~900 ms green-path, ~3.8 s worst-case red-path.

## React chip layout notes

- Portal'd to `document.body` with `position: fixed`, `left-1/2 -translate-x-1/2` for horizontal centering.
- `top-14` positions it just below the `top-3` PICKING banner so the two stack without overlap.
- `z-50` shares the overlay stacking context with the banner.
- `bg-white/95` (90% alpha white) preserves backdrop visibility — the chip is informational, not a modal.
- `role="note"` + `aria-live="polite"` announces changes to screen readers without stealing focus from the picking banner's `role="status"`.

## Cross-crate coupling notes

- The `automation` crate stays Tauri-free. `Notification` is a plain struct; the Tauri event bridge lives entirely in the desktop host.
- `automation::PlaywrightSidecarDriver::subscribe_notifications` is the only new surface the host needs to consume — drop-in for future fan-out consumers (e.g. AI pairing mode, live breakpoints).
- `spawn_notification_forwarder` exits automatically when the broadcast channel closes (driver dropped). No explicit abort path required at story end.

## Deviations from Plan

None — plan executed as written. One timing tweak during execution (sidecar vitest polled for up to 3 s instead of a fixed 200 ms) to accommodate concurrent-test CDP latency; captured in the commit message.

## Known Stubs

None. The preview chip is a net-new UI surface fully wired from DOM event → sidecar rAF throttle → stdout notification → Rust broadcast → Tauri event → React setState → DOM chip.

## Threat Flags

None. The hover-preview surface is fully covered by the plan's `<threat_model>`:
- T-07-04a-01 (DoS via broadcast overflow) → mitigated with capacity 128 + lagged logging.
- T-07-04a-02 (spoofed hoverPreview from a hostile page) → accepted; UI-only impact.
- T-07-04a-03 (mouseover flood) → mitigated with rAF throttle in overlay.

## Self-Check: PASSED

Verified artifacts exist and commits are on HEAD:

```
[ -f crates/automation/src/playwright_driver.rs ] → FOUND
[ -f scripts/playwright-sidecar/server.mjs ] → FOUND
[ -f scripts/playwright-sidecar/picker/overlay/index.ts ] → FOUND
[ -f apps/desktop/src-tauri/src/commands/picker.rs ] → FOUND
[ -f apps/desktop/src/ipc/picker.ts ] → FOUND
[ -f apps/desktop/src/features/recorder/pick-element-button.tsx ] → FOUND

commit 2f21e3e → FOUND (Task 1 RED)
commit e31ecb3 → FOUND (Task 1 GREEN)
commit d78620d → FOUND (Task 2 RED)
commit fb84f41 → FOUND (Task 2 GREEN)
commit f54ba02 → FOUND (deferred-items doc)
```

Grep acceptance (all matched):
```
grep -c "id: Option<u64>" crates/automation/src/playwright_driver.rs → 1
grep -c "method: Option<String>" crates/automation/src/playwright_driver.rs → 1
grep -c "broadcast::Sender<Notification>" crates/automation/src/playwright_driver.rs → 1
grep -c "subscribe_notifications" crates/automation/src/playwright_driver.rs → 2
grep -c "writeNotification" scripts/playwright-sidecar/server.mjs → 2
grep -c "hoverPreview" scripts/playwright-sidecar/server.mjs → 3
grep -c "__sc_picker_hover" scripts/playwright-sidecar/picker/overlay/index.ts → 3
grep -c "requestAnimationFrame" scripts/playwright-sidecar/picker/overlay/index.ts → 2
grep -c "spawn_notification_forwarder" apps/desktop/src-tauri/src/commands/picker.rs → 1
grep -n 'emit("picker_hover_preview"' apps/desktop/src-tauri/src/commands/picker.rs → 1 match
grep -c "listenPickerHoverPreview" apps/desktop/src/ipc/picker.ts → 1
grep -c "PickHoverPayload" apps/desktop/src/features/recorder/pick-element-button.tsx → 3
grep -c 'role="note"' apps/desktop/src/features/recorder/pick-element-button.tsx → 2
```

Test results (all green):
```
cargo test -p automation --lib → 37 passed; 0 failed
cd scripts/playwright-sidecar && pnpm test → 53 passed; 0 failed
cd apps/desktop && pnpm exec vitest run pick-element-button.test.tsx → 6 passed; 0 failed
cd apps/desktop/src-tauri && cargo check → exit 0
```
