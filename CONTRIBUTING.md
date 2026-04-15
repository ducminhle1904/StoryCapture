# Contributing to StoryCapture

Thanks for your interest! StoryCapture is a Tauri v2 desktop app + Next.js companion
that turns DSL stories into polished demo videos. This guide gets you from a fresh
clone to a green local build on macOS or Windows.

---

## Prerequisites

| Tool                                                   | Version          | Why                                                                                |
| ------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------- |
| **Node.js**                                            | `20.x` (LTS)     | Runs the desktop frontend (Vite + React 19) and the web companion (Next.js 15)     |
| **pnpm**                                               | `9.15.0`         | Workspace package manager (declared in root `package.json` `packageManager` field) |
| **Rust**                                               | `1.83.0`         | Auto-installed via `rust-toolchain.toml` — no manual install needed                |
| **Xcode Command Line Tools** (macOS only)              | latest           | Provides clang + libSystem for native crates and Tauri's macOS bundler             |
| **Visual Studio 2022 Build Tools** (Windows only)      | with C++ workload | MSVC + Windows SDK for `windows-rs` / `windows-capture`                            |
| **Apple Developer ID Application certificate** (macOS) | optional         | Only required for signed builds (Plan 10); PR builds are unsigned                  |

> **You do NOT need to install Rust manually.** `rustup` will read `rust-toolchain.toml`
> on the first `cargo` invocation and download the pinned `1.83.0` toolchain plus the
> `rustfmt`, `clippy`, and `rust-src` components, and the macOS arm64/x64 + Windows x64
> targets. If you don't have `rustup`, install it from <https://rustup.rs>.

---

## sccache setup (recommended)

We use [`sccache`](https://github.com/mozilla/sccache) to share Rust compilation
artifacts across local builds and CI. It cuts cold-build time on the workspace from
several minutes to a handful of seconds once warm.

### Local install

```bash
cargo install sccache --locked
```

Then export the wrapper in your shell rc:

```bash
export RUSTC_WRAPPER=sccache
export SCCACHE_DIR="$HOME/.cache/sccache"   # default; change as desired
```

Verify:

```bash
sccache --show-stats
```

### Optional: shared S3 cache

For teams who want to share a cache (CI ↔ local devs), set:

```bash
export SCCACHE_BUCKET=storycapture-sccache
export SCCACHE_REGION=us-east-1
# Provide AWS creds via your usual mechanism (aws sso login, env vars, etc).
```

CI uses GitHub Actions cache via `mozilla-actions/sccache-action`, no S3 required.

---

## Build commands

From the repo root:

```bash
# Install JS/TS workspaces (apps + packages)
pnpm install

# Run the dev pipeline (Turborepo orchestrates apps/desktop, apps/web, packages/*)
pnpm dev

# Compile all Rust crates on the host platform
cargo check --workspace

# Lint + format JS/TS (Biome — single tool, replaces ESLint + Prettier)
pnpm biome check .
pnpm biome format --write .

# Lint + format Rust
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings

# Run all tests
cargo nextest run --workspace   # falls back to `cargo test` if nextest missing
```

---

## Platform-gated crates

Some crates pull in native deps that only build on one OS:

- **macOS only** — `objc2*` family, `screencapturekit` (used by `crates/capture` from Plan 01-07)
- **Windows only** — `windows`, `windows-capture` (used by `crates/capture` from Plan 01-07)

`crates/*/Cargo.toml` declares these under `[target.'cfg(target_os = "macos")'.dependencies]`
or `[target.'cfg(target_os = "windows")'.dependencies]`, so:

- `cargo check --workspace` on **macOS** compiles the macOS-gated deps; Windows-gated
  deps are skipped.
- `cargo check --workspace` on **Windows** does the inverse.
- **Cross-platform verification happens in the GitHub Actions matrix** (`.github/workflows/ci.yml`)
  which runs on `macos-14` (arm64), `macos-13` (x64), and `windows-latest` (x64).

If you need to manually exercise a non-host target locally, install the target and
pass `--target`:

```bash
rustup target add x86_64-pc-windows-msvc   # only useful with `cross` or check-only
cargo check --workspace --target x86_64-pc-windows-msvc
```

---

## PR expectations

- The CI matrix (`.github/workflows/ci.yml`) must be green on all three cells:
  `macos-14` (arm64), `macos-13` (x64), `windows-latest` (x64).
- PR builds are **unsigned**: macOS notarization and Windows code signing run only on
  tagged releases (see Plan 10). This keeps PR turnaround fast and avoids burning
  signing-quota on every push.
- Every PR runs: `pnpm install --frozen-lockfile`, `pnpm biome check .`,
  `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo check`, `cargo nextest run`.
- Squash-merge is preferred; one commit per logical change in the squashed message.

---

## Repo layout

```
.
├── apps/
│   ├── desktop/        # Tauri v2 + React 19 desktop app (Plan 01-03)
│   └── web/            # Next.js 15 companion (Phase 4)
├── packages/
│   ├── shared-types/   # tauri-specta codegen target (TS)
│   ├── story-dsl/      # TS mirror of Rust DSL AST
│   ├── ui/             # shadcn/ui + Base UI shared components
│   └── config/         # tsconfig.base.json + shared configs
├── crates/
│   ├── story-parser/   # pest grammar + AST (pure, no Tauri)
│   ├── automation/     # BrowserDriver trait + chromiumoxide / Playwright sidecar
│   ├── capture/        # Native screen capture (SCK / WGC / xcap)
│   ├── effects/        # Typed filter-graph AST (Phase 2)
│   ├── encoder/        # FFmpeg sidecar lifecycle
│   └── storage/        # rusqlite two-tier persistence
├── .github/
│   ├── actions/setup-toolchain/  # composite action used by all workflows
│   └── workflows/                # ci.yml (matrix) + rust-check.yml (host-only)
├── biome.json
├── Cargo.toml          # workspace root
├── package.json        # pnpm + turbo root
├── pnpm-workspace.yaml
├── rust-toolchain.toml # pins Rust 1.83.0
└── turbo.json
```

---

## Getting help

Open a discussion on the repo, or check `.planning/` for the per-phase plan documents
that drove each piece of the codebase.
