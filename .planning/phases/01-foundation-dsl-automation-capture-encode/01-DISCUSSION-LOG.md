# Phase 1: Foundation — DSL, Automation, Capture, Encode - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 01-CONTEXT.md — this log records how they were reached.

**Date:** 2026-04-14
**Phase:** 01-foundation-dsl-automation-capture-encode
**Mode:** `--auto` (recommended defaults from research auto-selected; no interactive Q&A)
**Areas auto-resolved:** Monorepo & Build, Typed IPC, DSL Parser, Browser Automation, Screen Capture, Encoder/FFmpeg, Storage, Logging/Errors, Desktop UI, Distribution & CI, Testing

---

## Monorepo & Build

| Option | Description | Selected |
|--------|-------------|----------|
| Turborepo + pnpm + Cargo workspace (per ARCHITECTURE.md) | Research-recommended layout | ✓ |
| Nx | Alternative monorepo tool | |
| Single-repo, no monorepo tooling | Simpler but loses shared TS/Rust types | |

**Auto-selected:** research-recommended option. Biome chosen over ESLint+Prettier for single-tool linting.

---

## Typed IPC

| Option | Description | Selected |
|--------|-------------|----------|
| `tauri-specta` | Mature, widely used in Tauri v2 | ✓ |
| `taurpc` | Alternative; also viable | |
| Hand-maintained types | Rejected — drift risk | |

**Auto-selected:** `tauri-specta`. Channels for streams, commands for request/response, events for broadcast.

---

## DSL Parser

| Option | Description | Selected |
|--------|-------------|----------|
| pest two-layer parser with Levenshtein suggestions | Research-recommended | ✓ |
| nom | Lower-level; lose error-recovery ergonomics | |
| Custom hand-rolled | Too much work for a DSL | |

**Auto-selected:** pest with two-layer parse + panic-mode recovery. LSP deferred to Phase 3.

---

## Browser Automation

| Option | Description | Selected |
|--------|-------------|----------|
| BrowserDriver trait: chromiumoxide primary + Playwright sidecar from day one | Research-mandated; PITFALLS #3 | ✓ |
| chromiumoxide only | Too risky given pre-1.0 maturity | |
| Playwright sidecar only | Loses in-process speed advantages | |

**Auto-selected:** dual implementation. Risky verbs routed to Playwright automatically.

---

## Screen Capture

| Option | Description | Selected |
|--------|-------------|----------|
| `screencapturekit` (doom-fish) on macOS + `windows-capture` on Windows + xcap fallback | Research-recommended | ✓ |
| Raw `objc2` + `windows-rs` bindings | More surface area, more bugs | |
| Cross-platform `xcap` only | Video recording WIP on Windows | |

**Auto-selected:** native-primary. Byte-bounded queue (not frame-bounded). Single clock per platform.

---

## Encoder / FFmpeg

| Option | Description | Selected |
|--------|-------------|----------|
| Universal static LGPL FFmpeg 7.x as externalBin sidecar | Solves nested-dylib notarization | ✓ |
| Dynamic FFmpeg bundle with internal dylibs | Known Tauri notarization pain | |
| System FFmpeg | User-hostile; version drift | |

**Auto-selected:** static universal LGPL. HW-encoders only (VT/NVENC/QSV); no GPL x264/x265.

---

## Storage

| Option | Description | Selected |
|--------|-------------|----------|
| Two-tier SQLite (global `app.sqlite` + per-project `project.sqlite`) | Portable projects, clean isolation | ✓ |
| Single global DB | Projects non-portable | |
| File-only (no DB) | Loses indexing for dashboard | |

**Auto-selected:** two-tier. `rusqlite` bundled + `rusqlite_migration`.

---

## Secrets

| Option | Description | Selected |
|--------|-------------|----------|
| `tauri-plugin-keyring` (OS keychain) | Current best practice | ✓ |
| Stronghold | Deprecated as of Tauri v3 | |
| Plaintext in SQLite | Rejected — security | |

**Auto-selected:** keyring. Scaffolded in Phase 1 though first consumer is Phase 3.

---

## Desktop UI

| Option | Description | Selected |
|--------|-------------|----------|
| shadcn/ui + Base UI (`base-vega`) per PROJECT.md | Dark-first, render-prop flexibility | ✓ |
| shadcn/ui + Radix | Rejected per PROJECT.md | |
| Hand-built primitives | Too much reinvention | |

**Auto-selected:** Base UI + shadcn. Motion library = `motion/react` (not `framer-motion`). CodeMirror 6 via `@uiw/react-codemirror`. Phase 1 surfaces: Dashboard, Story Editor, Recording View only.

---

## Distribution & CI

| Option | Description | Selected |
|--------|-------------|----------|
| GitHub Actions matrix (macOS arm64/x64 + Windows x64), notarize on tagged releases | Standard, caches well | ✓ |
| Notarize every PR | Slow; not necessary | |
| Release-time-only CI | Loses signal on PRs | |

**Auto-selected:** matrix per PR, sign/notarize on tags. Auto-updater signed manifests; differential updates deferred to Phase 5.

---

## Testing

| Option | Description | Selected |
|--------|-------------|----------|
| Cargo tests + Vitest + RTL + Windows WebdriverIO; macOS E2E manual | Reality of `tauri-driver` support | ✓ |
| Full cross-platform E2E | Not supported by tooling | |
| Manual-only | Loses regression coverage | |

**Auto-selected:** pragmatic split. 30-min capture memory soak + ffprobe A/V-drift check are CI-enforced.

---

## Claude's Discretion

- tokio runtime configuration specifics
- actor channel sizes beyond the byte-bounded frame queue
- specific Lucide icon choices
- exact DSL whitespace/comment tolerance
- Tauri plugin list beyond the named plugins

## Deferred Ideas

- Post-production effects, multi-format export, undo/redo → Phase 2
- NL chat, LSP, TTS, dry-run, selector hardening → Phase 3
- Web companion → Phase 4
- CLI, native-app automation, diff-aware re-record, plugins, HDR, localization, differential updates, telemetry → Phase 5 / v2
- macOS E2E automation harness → deferred
