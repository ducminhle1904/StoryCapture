---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 14
subsystem: intelligence, desktop
tags: [rust, tower-lsp, tauri-ipc, codemirror, lsp-bridge, d-16, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/13
    provides: StoryLanguageServer (tower_lsp::LanguageServer impl)
provides:
  - intelligence::lsp::ipc_bridge::LspBridge (tower-lsp <-> Tauri IPC bridge)
  - intelligence::lsp::ipc_bridge::{LspNotification, LspBridgeError}
  - commands::lsp::lsp_request Tauri command
  - apps/desktop/src/lib/lsp/tauriTransport.ts (TauriLspTransport)
  - apps/desktop/src/lib/lsp/storyLanguage.ts (storyLanguageExtension)
  - apps/desktop/src/features/editor/useStoryLsp.ts (React hook)
affects:
  - Phase 3 Plan 15+ editor integration -- storyLanguageExtension replaces static diagnostics/completion
  - Any plan wiring LSP to the editor can use useStoryLsp hook
tech-stack:
  added:
    - "tower 0.4 (direct dep for Service trait in intelligence crate)"
  patterns:
    - "LspBridge wraps LspService behind tokio::Mutex for &mut self Service::call"
    - "ClientSocket stream drained by background task, broadcast via tokio::broadcast"
    - "JSON-RPC envelopes marshalled as strings for specta compatibility (serde_json::Value lacks specta::Type)"
    - "Custom ~250-line CM6 LSP adapter (not codemirror-languageserver) -- stdio assumption incompatible with Tauri IPC"
key-files:
  created:
    - crates/intelligence/src/lsp/ipc_bridge.rs
    - crates/intelligence/tests/lsp_bridge_tests.rs
    - apps/desktop/src-tauri/src/commands/lsp.rs
    - apps/desktop/src/lib/lsp/tauriTransport.ts
    - apps/desktop/src/lib/lsp/storyLanguage.ts
    - apps/desktop/src/lib/lsp/tauriTransport.test.ts
    - apps/desktop/src/features/editor/useStoryLsp.ts
  modified:
    - crates/intelligence/src/lsp/mod.rs
    - crates/intelligence/Cargo.toml
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src-tauri/src/lib.rs
    - Cargo.lock
key-decisions:
  - "Custom CM6 LSP adapter over codemirror-languageserver -- the latter assumes stdio transport which is incompatible with Tauri IPC (D-16). Custom adapter covers hover, diagnostics, completion in ~250 lines."
  - "JSON-RPC envelopes as strings (not serde_json::Value) in the Tauri command -- specta does not implement Type for Value. Mirrors the DryRun DTO pattern from Plan 03-16."
  - "LspBridge held behind tokio::Mutex -- tower::Service::call takes &mut self. Contention is minimal since LSP requests are sequential per-document."
  - "tower 0.4 added as direct dep -- tower-lsp 0.20 depends on tower 0.4 but does not re-export the Service trait needed for poll_ready/call."
  - "LspBridgeState initialized eagerly in Tauri setup -- the LSP server is lightweight and should be ready before any editor opens."
requirements-completed: [AI-06, UI-07]
duration: ~12 min
completed: 2026-04-16
---

# Phase 03 Plan 14: LSP IPC Bridge (D-16) Summary

**In-process tower-lsp bridged to CodeMirror 6 via Tauri IPC -- LspBridge wraps LspService with tokio::Mutex, drains ClientSocket notifications via background broadcast task, exposes lsp_request Tauri command with string-marshalled JSON-RPC envelopes, and a custom CM6 extension provides LSP-backed diagnostics/hover/completion through TauriLspTransport.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2 (both TDD `tdd="true"`)
- **Commits:** 2 (`93f3a75` Task 1, `2a5bfca` Task 2)
- **Files created:** 7
- **Files modified:** 6

## What Was Built

### Task 1 -- Rust IPC Bridge + lsp_request Tauri Command

**`crates/intelligence/src/lsp/ipc_bridge.rs`** -- Core bridge:
- `LspBridge::new()` builds `LspService::new(StoryLanguageServer::new)`, stores service behind `tokio::Mutex`, spawns background task draining `ClientSocket` stream.
- `handle_lsp_request(request_json)` parses JSON-RPC envelope via `serde_json::from_value::<Request>`, calls `Service::poll_ready` + `Service::call`, serializes response.
- `subscribe()` returns `broadcast::Receiver<LspNotification>` for server-initiated messages.
- `LspNotification { method, params }` -- notification DTO.
- `LspBridgeError` -- structured error enum (InvalidRequest, ServiceError, SerializationError).

**`apps/desktop/src-tauri/src/commands/lsp.rs`** -- Tauri command:
- `lsp_request(bridge_state, jsonrpc_request_json, on_notification)` -- accepts JSON-RPC as `String` (specta compat), spawns notification forwarder task, returns stringified response.
- `LspNotificationDto { method, params_json }` -- specta-compatible notification DTO.
- `LspBridgeState(Arc<LspBridge>)` -- managed state wrapper.

**Registration:** Command added to `ipc_spec.rs` collect_commands + type registry. `LspBridgeState` managed in `lib.rs` setup.

**Integration tests (`tests/lsp_bridge_tests.rs`)** -- 4 tests:

| Test | What it locks |
|---|---|
| `initialize_returns_capabilities` | JSON-RPC initialize returns capabilities with hover + completion |
| `did_open_publishes_diagnostics_via_notification` | didOpen triggers publishDiagnostics broadcast for invalid verb |
| `hover_returns_verb_documentation` | Hover over "click" verb returns markdown documentation |
| `concurrent_requests_multiplex_correctly` | Two concurrent hovers with different IDs get correct responses |

### Task 2 -- CodeMirror 6 LSP Client Extension

**`apps/desktop/src/lib/lsp/tauriTransport.ts`** -- Transport:
- `createTauriLspTransport(docUri)` creates transport with Tauri Channel for notifications.
- `sendRequest(method, params)` builds JSON-RPC envelope, invokes `lsp_request`, parses response.
- `sendNotification(method, params)` fire-and-forget invoke.
- `onNotification(handler)` registers handler, returns unsubscribe function.
- `dispose()` cleans up handlers and prevents further calls.

**`apps/desktop/src/lib/lsp/storyLanguage.ts`** -- CM6 Extension:
- `storyLanguageExtension(transport, docUri)` returns Extension array with:
  - Diagnostics: StateField + linter fed by `pushLspDiagnostics()`.
  - Hover: `hoverTooltip` backed by `textDocument/hover`.
  - Completion: `autocompletion` backed by `textDocument/completion`.
- `pushLspDiagnostics(view, params)` converts LSP diagnostics to CM format via StateEffect.

**`apps/desktop/src/features/editor/useStoryLsp.ts`** -- React Hook:
- `useStoryLsp({ docUri, initialText, viewRef })` returns `{ extension, notifyDidChange }`.
- Handles initialize + didOpen on mount, didClose + dispose on unmount.
- Subscribes to publishDiagnostics and pushes into EditorView.

**Tests (`tauriTransport.test.ts`)** -- 6 Vitest tests:

| Test | What it locks |
|---|---|
| `sendRequest calls invoke with JSON-RPC envelope` | Correct invoke args + response parsing |
| `incoming channel messages fire onNotification handlers` | Channel -> handler pipeline |
| `sendRequest throws on JSON-RPC error response` | Error propagation |
| `sendNotification fires invoke without blocking` | Fire-and-forget behavior |
| `unsubscribe stops notification delivery` | Handler cleanup |
| `dispose prevents further sendRequest calls` | Transport lifecycle |

## Decisions Made

1. **Custom CM6 adapter** over `codemirror-languageserver` -- stdio transport assumption incompatible with D-16 Tauri IPC.
2. **String-marshalled JSON-RPC** -- `serde_json::Value` lacks `specta::Type`; string approach mirrors Plan 03-16 DryRun pattern.
3. **tokio::Mutex for LspService** -- `tower::Service::call` requires `&mut self`; contention minimal for sequential per-document LSP ops.
4. **tower 0.4 direct dep** -- tower-lsp 0.20 uses tower 0.4 internally but doesn't re-export the `Service` trait.
5. **Eager LspBridgeState init** -- LSP server is lightweight; ready before any editor opens.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-14): LSP IPC bridge + lsp_request Tauri command + notification forwarding` | `93f3a75` |
| 2 | `feat(03-14): CodeMirror 6 LSP client extension with Tauri IPC transport` | `2a5bfca` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] String-marshalled JSON-RPC instead of serde_json::Value in Tauri command.**
- **Found during:** Task 1 compilation.
- **Issue:** Plan specifies `jsonrpc_request: serde_json::Value` parameter but `serde_json::Value` does not implement `specta::Type`, causing compile error with tauri-specta.
- **Fix:** Changed to `jsonrpc_request_json: String` with JSON parse/stringify on both sides. Frontend stringifies before invoke, command parses back.
- **Files modified:** `apps/desktop/src-tauri/src/commands/lsp.rs`, `apps/desktop/src/lib/lsp/tauriTransport.ts`.
- **Commit:** `93f3a75`, `2a5bfca`.

**2. [Rule 2 - Missing Critical] Added `tower = "0.4"` to intelligence Cargo.toml.**
- **Found during:** Task 1 implementation.
- **Issue:** `tower-lsp` 0.20 depends on `tower` 0.4 but does not re-export the `Service` trait. The bridge needs `Service::poll_ready` and `Service::call`.
- **Fix:** Added `tower = "0.4"` as direct dependency.
- **Files modified:** `crates/intelligence/Cargo.toml`, `Cargo.lock`.
- **Commit:** `93f3a75`.

**3. [Rule 2 - Missing Critical] Added 3 extra frontend tests beyond plan's 3 required.**
- **Found during:** Task 2 test drafting.
- **Issue:** Plan requires 3 tests. Added error handling, unsubscribe, and dispose tests for completeness.
- **Fix:** 6 total tests covering error propagation, handler cleanup, and transport lifecycle.
- **Files modified:** `apps/desktop/src/lib/lsp/tauriTransport.test.ts`.
- **Commit:** `2a5bfca`.

---

**Total deviations:** 3 auto-fixed (1 Rule 3 blocking, 2 Rule 2 missing-critical). **Impact:** Strictly additive. All plan acceptance criteria pass.

## Verification

```bash
cargo test -p intelligence --test lsp_bridge_tests    # 4/4 passed
npx vitest run src/lib/lsp                            # 6/6 passed
cargo check -p storycapture                           # clean
```

**Task 1 acceptance criteria:**
- All 4 tests green - PASS
- `grep -c "LspService::new" crates/intelligence/src/lsp/ipc_bridge.rs` -> 1 (>= 1) - PASS
- `lsp_request` registered in ipc_spec.rs - PASS
- NO stdin/stdout driver in crates/intelligence/src/lsp/ - PASS

**Task 2 acceptance criteria:**
- All 3+ tests green (6 delivered) - PASS
- `grep -c "invoke.*lsp_request" apps/desktop/src/lib/lsp/tauriTransport.ts` -> 2 (>= 1) - PASS
- `grep -c "Channel" apps/desktop/src/lib/lsp/tauriTransport.ts` -> 4 (>= 1) - PASS
- `grep -c "storyLanguageExtension" apps/desktop/src/lib/lsp/storyLanguage.ts` -> 2 (= 1 export + 1 jsdoc) - PASS

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-14-01 (Tampering - Malformed jsonrpc_request) | mitigated | `serde_json::from_str` + `serde_json::from_value::<Request>` catches structural errors; invalid returns error string, not panic |
| T-03-14-02 (DoS - Flood of lsp_request calls) | mitigated | tokio::Mutex serializes calls; LspService backpressures via poll_ready; Tauri command concurrency capped by runtime |
| T-03-14-03 (Info Disclosure - LSP hover/completion content) | accepted | Content derives from verb catalog + user-authored source; same data user already has |
| T-03-14-04 (Spoofing - Channel ID spoof) | mitigated | Channel<T> is a Tauri primitive with per-window scoping |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. Both the Rust bridge and the frontend transport/extension are fully functional.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register.

## Issues Encountered

None beyond the auto-fixed deviations. The specta `Value` incompatibility was the only blocking issue, resolved by string marshalling.

## Authentication Gates

None -- all tests use in-process construction (Rust) or mocked IPC (TypeScript).

## User Setup Required

None -- pure in-process implementation with no external dependencies.

## Next Plan Readiness

- **Editor integration:** `useStoryLsp` hook is ready to replace the static `storyDiagnosticsLinter` and `storyAutocomplete` in `codemirror-setup.ts`. The hook returns an Extension and a `notifyDidChange` callback.
- **Multiple documents:** `LspBridge` is a singleton; multiple editors can send requests concurrently (Mutex serializes calls). Each editor creates its own `TauriLspTransport` instance with its own document URI.
- No blockers. No new external dependencies beyond `tower 0.4` (already transitive via tower-lsp).

## Handoff Notes

- `LspBridge::new()` spawns the notification drainer as a background tokio task. It runs until the `ClientSocket` stream ends (i.e., the service is dropped). No explicit shutdown is needed.
- The `lsp_request` command spawns a new notification forwarder per invocation. This means multiple overlapping calls will each have their own broadcast subscription. The frontend should ideally reuse a single transport per document.
- `storyLanguageExtension` returns a CM6 Extension array containing a `StateField` for diagnostics. The `pushLspDiagnostics` function must be called with a live `EditorView` to dispatch the StateEffect -- the `useStoryLsp` hook handles this automatically.
- The existing `storyDiagnosticsLinter` (which calls `parse_story` IPC) and `storyAutocomplete` (static verb list) in `codemirror-setup.ts` can coexist with the LSP extension or be replaced by it. The LSP provides a superset of functionality.

## Self-Check: PASSED

File existence:
- `crates/intelligence/src/lsp/ipc_bridge.rs` -> FOUND
- `crates/intelligence/tests/lsp_bridge_tests.rs` -> FOUND
- `apps/desktop/src-tauri/src/commands/lsp.rs` -> FOUND
- `apps/desktop/src/lib/lsp/tauriTransport.ts` -> FOUND
- `apps/desktop/src/lib/lsp/storyLanguage.ts` -> FOUND
- `apps/desktop/src/lib/lsp/tauriTransport.test.ts` -> FOUND
- `apps/desktop/src/features/editor/useStoryLsp.ts` -> FOUND

Commits:
- `93f3a75` (Task 1) -> FOUND
- `2a5bfca` (Task 2) -> FOUND

Verification:
- `cargo test -p intelligence --test lsp_bridge_tests` -> 4/4 passed
- `npx vitest run src/lib/lsp` -> 6/6 passed
- `cargo check -p storycapture` -> clean

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
