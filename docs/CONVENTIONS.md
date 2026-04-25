# StoryCapture — Conventions

Concrete patterns actually used in the codebase. Read on demand; don't invent new patterns when an established one exists.

## Rust

- **Error types:** One `thiserror` enum per crate in `src/error.rs` (`CaptureError`, `EncoderError`, `StorageError`, `IntelError`, `AppError`, …). Crate exports `pub type Result<T> = std::result::Result<T, XxxError>`. Domain crates never cross-import each other's error types; host maps them into `AppError` at the IPC boundary.
- **Async:** `tokio` multi-thread runtime everywhere. Async traits use `async_trait`. No blocking calls in async paths (use `tokio::task::spawn_blocking` / `block_in_place` only when necessary).
- **Actor pattern (D-06):** Long-lived work goes through `tokio::sync::mpsc` channels wrapped in newtype senders stored on `AppState`. See `automation::SessionActor` + `encoder::RenderQueueActor`.
- **Public surface:** Crates re-export everything public from `lib.rs` via `pub use module::*`; private helpers stay module-local. Don't reach into sub-modules across crates.
- **Platform gating:** Use `#[cfg(target_os = "…")]` on module declarations and per-function where the API diverges. Cross-platform types live in `crates/<name>/src/*.rs`; platform-specific code in `crates/<name>/src/{macos,windows}/` submodules.
- **Tauri commands:** One file per feature under `apps/desktop/src-tauri/src/commands/`. Each is a thin bridge: deserialize → call domain crate → convert to DTO → return `Result<T, AppError>`. No domain logic in command files. Register every command and every exported type in `ipc_spec.rs` via `collect_commands!` and `.typ::<T>()`.
- **DTOs:** Crate-native types stay pure; the host defines `XxxDto` mirrors (Specta-friendly, lossy if needed) in `commands/` modules to keep the TS surface stable when Rust internals churn.
- **Types for TS:** Add `#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]` for shared AST types (story, effects). For IPC payloads use `specta::Type`.
- **Tracing (overhauled 2026-04-23):** `tracing` + `tracing-subscriber` wired through `tauri-plugin-log` + a custom `SizeRollingWriter` file sink (live `storycapture.log` + numbered archives, `max_files` configurable from Settings → Logs). Every event prefixed with `session=<uuid>` via `SessionPrefixFormat` so a single log file can be sliced by run. ~95 Tauri commands wear `#[tracing::instrument(err(Debug))]`; renderer errors flow through the `log_from_frontend` IPC into the same file. All logs are **local-only** — never ship telemetry over the network. Use `open_log_dir` to pop the folder for an operator.
- **No panics in hot paths.** Use `Result`. `panic_hook.rs` catches unexpected panics → log file + `panic_event` IPC.

## TypeScript / React

- **File naming:** kebab-case files (`new-project-dialog.tsx`, `accounts-panel.tsx`). PascalCase reserved for legacy/dialog components already in that style (`WebAccountPanel.tsx`) — prefer kebab for new files. Hooks/stores: camelCase (`useNlChat.ts`, `nlStore.ts`).
- **Folder layout:** feature-driven under `apps/desktop/src/features/<feature>/` — each owns its components, stores, hooks, tests. Shared UI primitives in `src/components/ui/`. IPC wrappers in `src/ipc/`. Top-level stores for cross-feature state in `src/state/` or `src/stores/`.
- **Zustand stores:** two flavors in use.
  - **Monolithic per feature** (default): single `create<T>()((set, get) => ({ state, actions }))` in one file, optional `persist()` middleware. Example: `features/nl-mode/nlStore.ts`.
  - **Slice-composed / cross-feature shared** (two documented exceptions only):
    1. Post-production editor: 6 slices merged in `features/post-production/state/store.ts`.
    2. Phase 13 output-prefs (`state/output-prefs.ts`): cross-feature shared store for the 5 recording-time + 8 export-time output knobs, consumed by both the recorder and the post-production export modal. Persistence bridge lives in `ipc/output-prefs.ts` + `lib/output-prefs-persist.ts`, backed by `tauri-plugin-store` and per-project `<project>/.storycapture/output.json`.

    Don't copy these patterns unless the store clearly warrants it — keep it monolithic per feature.
- **TanStack Query:** every IPC read/mutation goes through a hook in `src/ipc/*.ts`. Query-key factory pattern: `const KEYS = { all: ['projects'] as const, detail: (id) => [...] as const }`. Mutations invalidate with `qc.invalidateQueries({ queryKey: KEYS.all })`.
- **Channels (streaming IPC):** Tauri `Channel<T>` returned from commands like `launch_automation`, `start_recording`, `render_*`, `upload_video`. Subscribe via `channel.onmessage = (e) => store.dispatch(e)` — always unsubscribe on unmount.
- **Forms:** plain `useState` + inline validation in the submit handler. No react-hook-form / zod schema validation currently. Keep new forms small; reach for a schema lib only if a form grows past ~5 fields.
- **UI primitives:** Base UI compound components (`Dialog.Root / Portal / Popup`, `Menu.*`, `Select.*`) — **not Radix**. Variants via CVA in `components/ui/`. Motion via `motion/react` (not `framer-motion`). Icons from `lucide-react`.
- **Tokens:** never hardcode hex/spacing. Use CSS vars from `@storycapture/ui/tokens.css` (`var(--sc-color-bg-primary)`, `var(--sc-radius-md)`, etc.). Tailwind v4 `@theme` block is the source of truth.

## Testing

- **Rust:**
  - Integration tests in `crates/<name>/tests/*.rs`. Unit tests inline with `#[cfg(test)] mod tests`.
  - `insta` snapshot tests for `story-parser` (DSL round-trip), `effects` (AST emitter output), `intelligence` (LLM response parsing). Review with `cargo insta review`.
  - `proptest` declared (parser fuzz) — use sparingly.
  - `wiremock` mocks HTTP in `intelligence` tests.
  - `criterion` benches under `crates/capture/benches/` (Windows CPU crop <5ms target on 1080p).
  - Real-hardware / real-binary tests are **feature-gated** (see `docs/ARCHITECTURE.md` — feature table) and marked `#[ignore]` so default `cargo test` stays fast.
- **Desktop frontend:** Vitest + `happy-dom` + `@testing-library/react`. Setup in `apps/desktop/test-setup.ts` (jest-dom matchers, matchMedia shim). Tests colocated next to code as `*.test.tsx`, or grouped in `__tests__/` subfolders for related integration suites. Stub IPC with `@tauri-apps/api/mocks::mockIPC` when a component talks to Tauri.
- **Web (`apps/web`):** tRPC procedures tested via direct calls; Playwright for user-flow E2E.
- **Tauri E2E:** WebdriverIO + `tauri-driver` (Windows primary; macOS `tauri-driver` unsupported — gate macOS E2E accordingly).

## Commits

- **Format:** `type(scope): subject`.
- **Types:** `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `merge`. No other types.
- **Scope:** phase/plan ID (`07-05`, `phase-07`), crate name (`capture`, `recording`), or cross-cutting area (`state`, `docs`). Phase IDs are preferred when the change belongs to a GSD plan.
- **No `Co-Authored-By` trailers.** Hard rule (see `AGENTS.md` / `CLAUDE.md`). Strip them from commit messages.
- **No `--no-verify`, no `@ts-ignore`, no skipped tests** to "make things green" — fix the root cause or stop and ask.

## GSD workflow artifacts

Every code change of non-trivial size goes through a GSD command. Artifacts land in `.planning/`:

- `.planning/ROADMAP.md` — phase list with requirement coverage.
- `.planning/STATE.md` — live status, current phase/plan, blockers.
- `.planning/phases/NN-<slug>/`:
  - `NN-CONTEXT.md` — phase-wide decisions, scope boundary.
  - `NN-RESEARCH.md` / `NN-RESEARCH-TIER2.md` — optional research inputs.
  - `NN-PP-PLAN.md` — frontmatter (`phase`, `plan`, `type`, `wave`, `depends_on`, `files_modified`, `requirements`, `tags`) + task breakdown.
  - `NN-PP-SUMMARY.md` — post-execution retrospective, decisions locked, follow-ups.
  - `NN-PP-RESUME.md` — operator-gated checklists (hardware/secrets required).
  - `deferred-items.md` — out-of-scope follow-ups.
- `.planning/quick/DDMMYY-xxx-<slug>/` — `/gsd-quick` tasks.
- `.planning/research/{PROJECT,STACK,ARCHITECTURE,FEATURES,PITFALLS,SUMMARY}.md` — project-level research inputs (mostly historical reference now).

Commit messages encode the plan ID (`feat(07-05): …` → phase 7, plan 5).

## Lint / format

- **TS/JS:** `biome` is the single tool (no ESLint/Prettier). Config: `biome.json` — 2-space indent, 100-col, double quotes, trailing commas `all`, semicolons `always`. Ignore globs: `target/`, `node_modules/`, `.next/`, `dist/`, `.planning/`, `**/binaries/**`. Run `pnpm lint` / `pnpm format`.
- **Rust:** `rustfmt` defaults, `clippy` with workspace defaults. `rust-toolchain.toml` pins 1.88. `cargo-nextest` for faster tests, `cargo-deny` for license/advisory scan in CI.

## CI workflows (`.github/workflows/`)

| Workflow | Purpose |
|---|---|
| `ci.yml` | Multi-platform build + test (macOS arm64/x64, Windows x64). Biome, fmt, clippy, nextest, offline eval. |
| `capture-soak.yml` | 30-min capture memory soak (operator-triggered on TCC-granted host). |
| `capture-windows.yml` | Windows compile and no-run gate for WGC-specific capture code. |
| `capture-windows-e2e.yml` | WGC real-hardware E2E on Windows runner. |
| `encoder-av-drift.yml` | Audio/video sync validation across HW encoders. |
| `ffmpeg-build.yml` | Cross-compile LGPL FFmpeg 7.0.2 per-triple binaries. |
| `installer-size-budget.yml` | Enforces residual installer size budget after excluding bundled sidecars. |
| `nightly-eval.yml` | Live nightly eval against the golden AI dataset. |
| `render-benchmark.yml` | PR speed-factor render benchmark gate. |
| `release.yml` | Signed + notarized multi-platform release bundle. |
| `notarize-smoke.yml` | Pre-release notarization smoke test. |
| `release-soak.yml`, `release-benchmark.yml` | Post-release validation. |
| `rust-check.yml` | Standalone clippy + cargo-deny. |
| `playwright-sidecar-build.yml` | Build Node SEA sidecar per-triple. |

## Local sidecar binaries

Tauri's `externalBin` requires `apps/desktop/src-tauri/binaries/{ffmpeg,playwright-sidecar}-<triple>` to exist before `cargo build` succeeds — Release CI downloads real artifacts from `ffmpeg-build.yml` / `playwright-sidecar-build.yml`, but local dev needs them on disk.

Two flows produce them:

1. **Real Playwright SEA** (~50 MB+): `pnpm tauri:dev` runs `pnpm --filter playwright-sidecar build` first; that delegates to `scripts/playwright-sidecar/build-sea.mjs` which packages Node 20 + `playwright-core` + `server.mjs`.
2. **Placeholder stubs** (≤ 1 KB shell scripts that exit 127): `bash scripts/dev/install-sidecar-placeholders.sh` drops them just to satisfy the `externalBin` path check so a fresh checkout can run `cargo check -p storycapture --lib`.

### Gotcha: placeholder ↔ SEA staleness conflict

If you ever install placeholders to unblock a `cargo check`, then run `pnpm tauri:dev`, the SEA build's staleness check used to skip rebuild because the placeholder's mtime was newer than every source file. The dev binary then ran the stub at runtime — `start_author_preview` (and any other sidecar IPC) hung on a JSON-RPC handshake the stub never sent, surfacing as a frozen "Starting preview…" pane.

Two layers of defense (commits `a8e78b6`, `69eb3a3`):
1. `pnpm tauri:dev` and `pnpm tauri:build` now auto-rebuild the Playwright SEA before launching/packaging.
2. `build-sea.mjs` treats outputs ≤ 10 KB as "looks like a stub" and forces a real rebuild regardless of mtime.

If you ever bypass both guards (custom build flags, manual binary placement), `rm apps/desktop/src-tauri/binaries/playwright-sidecar-<triple>` before running `pnpm tauri:dev`.

Symptom → diagnosis: search the log file for `sidecar_stderr=storycapture: playwright-sidecar placeholder` — that's the unmistakable signature of a stub being spawned at runtime.

## Agent / contributor hard rules

Mirrored from `AGENTS.md` / `CLAUDE.md` "Working Rules" — keep them top of mind:

1. **No workarounds.** Fix at the root cause. Don't skip tests, `@ts-ignore`, `--no-verify`, or silence lints. Stop and ask if blocked.
2. **No `Co-Authored-By` in commits.**
3. **Match the user's language** in replies (code/commits stay in English).
4. **Concise comments.** Default to no comment. Single-line when the *why* is non-obvious. Never restate what the code says.
5. **Plan before breaking/big changes.** Enter plan mode for: public API / IPC / DSL / schema changes; >5-file cross-concern diffs; build/CI/signing changes; stack replacements; security-sensitive code; architectural refactors.
