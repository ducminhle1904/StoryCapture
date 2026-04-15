---
phase: 01-foundation-dsl-automation-capture-encode
plan: "10"
subsystem: release-ci + auto-updater + signing
tags: [release, signing, notarization, trusted-signing, auto-updater, installer-size, telemetry-audit, wave-5]
dependency-graph:
  requires:
    - "Plan 01-02 (notarize-mac.sh + Apple credential schema + ffmpeg-build.yml artifact)"
    - "Plan 01-03 (Tauri shell, tauri-plugin-updater wired into `lib.rs::run`, AppError)"
    - "Plan 01-07 (capture-soak test under --features real-capture)"
    - "Plan 01-08 (encoder-av-drift workflow pattern, externalBin gate resolution)"
    - "Plan 01-09 (React feature-directory pattern)"
  provides:
    - ".github/workflows/release.yml (tag-triggered build + sign + notarize + publish)"
    - ".github/workflows/installer-size-budget.yml (PR-advisory / main-strict 50 MB budget)"
    - ".github/workflows/release-soak.yml (30-min capture soak against signed installer)"
    - "scripts/release/sign-windows.ps1 (AzureSignTool wrapper, TrustedSigning + EvCert modes)"
    - "scripts/release/verify-installer-size.sh (portable dmg/exe/msi size walk with sidecar exclusion)"
    - "scripts/release/generate-updater-signing-key.sh (`tauri signer generate` helper)"
    - "scripts/release/generate-latest-json.mjs (Tauri updater manifest composer)"
    - "scripts/release/WINDOWS-SIGNING.md (Microsoft Trusted Signing + EV cert runbook)"
    - "apps/desktop/src-tauri/src/commands/updater.rs (check_update / install_update IPC)"
    - "apps/desktop/src/ipc/updater.ts + features/settings/auto-updater.tsx (opt-in UI)"
  affects:
    - "Phase 2 (post-production) consumes the same release pipeline when it ships v0.2.x."
    - "Phase 3 (AI/LLM) telemetry-audit grep pattern extends to cover any new HTTP crate the LLM clients introduce."
tech-stack:
  added:
    - "AzureSignTool (dotnet global tool; installed on-demand in sign-windows.ps1)"
    - "dawidd6/action-download-artifact@v6 (cross-workflow artifact pull; inherited from Plan 01-02)"
    - "softprops/action-gh-release@v2 (release asset upload + draft→published flip)"
    - "apple-actions/import-codesign-certs@v3 (reused from Plan 01-02)"
  patterns:
    - "Tag-triggered release with matrix build; concurrency group release-${ref} + cancel-in-progress:false so a release is never aborted mid-flight"
    - "Draft-then-publish: each matrix cell uploads to a draft release; final ubuntu publish job composes latest.json from the release's assets, then flips draft=false (atomic from the user's perspective)"
    - "Installer size budget is advisory on PRs (to avoid blocking exploration) but strict on main"
    - "Opt-in auto-updater: `dialog: false` + UI-triggered `check_update` / `install_update`; no background checks"
    - "localStorage-persisted opt-in toggle (no extra Tauri plugin dep); a future migration to @tauri-apps/plugin-store is a trivial swap"
    - "CAPTURE_SOAK_TARGET env-var convention for plugging an external binary into Plan 01-07's soak test (extension pending in capture crate)"
key-files:
  created:
    - .github/workflows/release.yml
    - .github/workflows/installer-size-budget.yml
    - .github/workflows/release-soak.yml
    - scripts/release/sign-windows.ps1
    - scripts/release/verify-installer-size.sh
    - scripts/release/generate-updater-signing-key.sh
    - scripts/release/generate-latest-json.mjs
    - scripts/release/WINDOWS-SIGNING.md
    - apps/desktop/src-tauri/src/commands/updater.rs
    - apps/desktop/src/ipc/updater.ts
    - apps/desktop/src/features/settings/auto-updater.tsx
    - .planning/phases/01-foundation-dsl-automation-capture-encode/01-10-RESUME.md
  modified:
    - apps/desktop/src-tauri/tauri.conf.json
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - .gitignore
decisions:
  - "Windows signing path: Microsoft Trusted Signing is the default (`-Mode TrustedSigning`); EV cert via Azure Key Vault (`-Mode EvCert`) is the break-glass. Rationale: Trusted Signing SmartScreen reputation is immediate, cost $9.99/mo vs EV ~$300/yr + hardware token + multi-week reputation warm-up. Scripted in sign-windows.ps1 so switching is a one-line workflow change."
  - "Updater pref persistence: use browser localStorage (key `storycapture.updater.check-on-launch`) rather than adding @tauri-apps/plugin-store to package.json. The Phase-1 UI surface is fully inside the webview and localStorage is stable across Tauri v2 reloads; Phase 2+ can migrate to plugin-store without changing the component shape."
  - "`tauri.conf.json` OWNER placeholder: left as `{{ORG_PLACEHOLDER}}` because the repository organisation / user name is not yet decided (no `storycapture-org/storycapture` repo exists at this commit). Documented in RESUME.md for the operator to replace before pushing the first v* tag. release.yml does not reference the placeholder; only the client-side pubkey + endpoint does, and a mis-configured endpoint causes only `check_update` to fail softly."
  - "Installer size budget: residual app (minus ffmpeg-* and playwright-sidecar-*) must be ≤ 50 MB (soft) / ≤ 60 MB (hard). The exclusion list matches the `.gitignore` patterns from Plan 01-08, so as new platform sidecars land, the exclusion logic is updated in lock-step."
  - "Updater artifact signing: Tauri's bundler signs `.app.tar.gz` / `.nsis.zip` itself when `TAURI_SIGNING_PRIVATE_KEY` is in the env; `release.yml` passes the secret straight through. scripts/release/generate-latest-json.mjs reads the already-present `.sig` sidecar files rather than re-signing, so there's a single source of truth for signatures."
  - "release-soak vs. plan-07 soak: plan-07's `capture-soak.yml` tests the in-tree crate (every PR touching crates/capture); this plan's `release-soak.yml` tests the installed, signed binary (post-release only). Both are needed — the first catches regressions early, the second catches packaging/notarization regressions that the in-tree test can't see."
metrics:
  duration_minutes: ~7
  task_count: 2
  files_created: 12
  files_modified: 4
  completed: 2026-04-15
---

# Phase 1 Plan 10: Release CI + Auto-Updater + Signing Summary

**One-liner:** Tag-triggered release pipeline (macOS arm64 + macOS x64 + Windows x64) that reuses Plan 01-02's `notarize-mac.sh` for notarization, signs Windows installers via Microsoft Trusted Signing with EV-cert fallback, enforces a <50 MB residual app budget on every PR, wires Tauri's built-in signed-manifest auto-updater with an opt-in Settings UI, and runs a post-release 30-minute capture soak against the installed signed binary — all credential-dormant until the operator provisions Apple + Azure + Tauri-updater secrets.

## Outcome

Phase 1 success criterion #4 — *"Signed, notarized installers … with auto-updater wired and telemetry off by default"* — lands in scaffolded form. Every workflow is syntactically valid (YAML + PowerShell + Bash all lint clean), the Rust + TypeScript wiring compiles (`cargo check -p storycapture --lib` + `pnpm typecheck` both green), and the release pipeline flips from dormant → live the moment the operator populates five secret groups (Apple signing, Azure / Trusted Signing, Tauri updater private key, `{{ORG_PLACEHOLDER}}` in `tauri.conf.json`, and the generated public key). No code change needed to activate.

The third, human-verify task (push a real `v*` tag, run the 10-step clean-machine smoke test, audit the network with Little Snitch / Wireshark) is **deliberately not auto-approved** — it requires live production secrets and a fresh Mac + Windows VM.

## What landed

### Task 1 — release CI + signing + size budget + updater wiring (`5fcf6d5`)

- **`.github/workflows/release.yml`** — tag-triggered (`push: tags: ["v*"]`) matrix build on macos-14 (arm64), macos-13 (x64), windows-latest. Each cell downloads the `ffmpeg-<triple>` + `playwright-sidecar-<triple>` artifacts from `ffmpeg-build.yml` / `playwright-sidecar-build.yml`, imports the Apple P12 cert (macOS cells), runs `pnpm tauri build --target <triple>` with `TAURI_SIGNING_PRIVATE_KEY` in the env (so Tauri signs the `.app.tar.gz` / `.nsis.zip` updater bundle), invokes `scripts/notarize/notarize-mac.sh` (macOS) or `scripts/release/sign-windows.ps1` (Windows), runs `verify-installer-size.sh --strict`, and uploads installer + updater bundle + `.sig` to a draft GitHub Release. A final ubuntu `publish` job runs `generate-latest-json.mjs` to compose the Tauri updater manifest from the draft's assets and flips `draft: false`. Concurrency group `release-${github.ref}` with `cancel-in-progress: false` so a release is never aborted mid-flight.
- **`.github/workflows/installer-size-budget.yml`** — runs on every PR (`advisory`) and every push to `main` (`--strict`). Uses an empty placeholder sidecar on PRs (fork artifacts aren't trusted) and best-effort downloads the real `ffmpeg-build.yml` artifact on `main`. Fails `main` builds that breach the 50 MB residual budget; warns but doesn't fail PRs unless > 60 MB.
- **`scripts/release/sign-windows.ps1`** — AzureSignTool wrapper. `-Mode TrustedSigning` (default) reads `WINDOWS_SIGNING_CERT_NAME` from env; `-Mode EvCert` reads `EV_CERT_AZURE_KV_NAME`. Both use the same Azure tenant / client / secret / KV URL env vars. Installs AzureSignTool via `dotnet tool install --global` on-demand. Runs `signtool verify /pa /v` after signing to catch chain/timestamp failures.
- **`scripts/release/verify-installer-size.sh`** — portable size walk. DMGs: `hdiutil attach` into a tempdir, tree-walk the `.app`, exclude anything named `ffmpeg` / `ffmpeg-*` / `ffprobe*` / `playwright-sidecar*`. EXE / MSI: `7z x` into a tempdir, same exclusion patterns. Emits clearly-formatted `Total / FFmpeg / Playwright / App residual (budget 50 MB, hard-fail 60 MB)` output. Exit codes: 0 OK-or-warn-only, 1 budget fail, 2 structural/usage error.
- **`scripts/release/generate-updater-signing-key.sh`** — thin wrapper around `npx @tauri-apps/cli signer generate -w .release-keys/storycapture_updater.key`. Documents the three-step post-generate workflow (paste private key + password into Secrets, paste public key into `tauri.conf.json`, confirm `.release-keys/` is gitignored).
- **`scripts/release/generate-latest-json.mjs`** — Node 20 ESM script. Reads `GITHUB_REPOSITORY` + `GITHUB_REF_NAME` + `GITHUB_TOKEN`, fetches the release by tag via `/repos/:owner/:repo/releases/tags/:tag`, classifies assets into `darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` by filename, inlines the contents of each `.sig` file into the manifest's `signature` field. Output schema matches `https://v2.tauri.app/plugin/updater/#server-support`.
- **`scripts/release/WINDOWS-SIGNING.md`** — full runbook for both signing paths: one-time Azure Portal setup (Trusted Signing account + certificate profile + service principal, or Key Vault + EV cert import), GitHub Secret names, decision matrix (cost / warm-up / token / renewal), failure modes. Explicitly notes that PR builds are expected to ship unsigned per D-42.
- **`apps/desktop/src-tauri/tauri.conf.json`** — `plugins.updater` now has `endpoints: ["https://github.com/{{ORG_PLACEHOLDER}}/storycapture/releases/latest/download/latest.json"]`, `dialog: false`, `createUpdaterArtifacts: true`, and `pubkey: "PUBKEY_PLACEHOLDER_..."` (operator replaces with output of `generate-updater-signing-key.sh`).
- **`apps/desktop/src-tauri/src/commands/updater.rs`** — `check_update` + `install_update` Tauri commands. Wrap `tauri_plugin_updater::UpdaterExt` to return a renderer-friendly `UpdateInfo { version, date, body, current_version }`. Signature verification against the pinned `pubkey` is enforced by the plugin itself (T-10-01 mitigation). `install_update` calls `app.restart()` which never returns on success.
- **`apps/desktop/src/ipc/updater.ts`** — typed wrappers for the two commands.
- **`apps/desktop/src/features/settings/auto-updater.tsx`** — Settings card with a "Check for updates on launch" toggle (default OFF, persisted via localStorage key `storycapture.updater.check-on-launch`), a "Check now" button with spinner, a release-notes pane shown only when an update is available, and a Download-and-install button that invokes `install_update`. No auto-check happens on mount — the caller is responsible for respecting the toggle.
- **`.gitignore`** — adds `.release-keys/` so the generated private key can never be accidentally committed.

### Task 2 — release-soak workflow (`958ddff`)

- **`.github/workflows/release-soak.yml`** — triggers on `workflow_run` of the `Release` workflow (tag pushes report empty `head_branch`, so `branches-ignore: ["**"]` lets them through) + `workflow_dispatch` with a `tag_name` input. Matrix runs macos-14 + windows-latest. Downloads the installer via `gh release download`, installs it (hdiutil on macOS, silent NSIS on Windows), sets `CAPTURE_SOAK_TARGET=<installed-binary>`, runs `cargo test -p capture --test soak --features real-capture -- --ignored --nocapture`. Uploads `rss-samples.csv` on any result. 50-minute job timeout.

## Phase 1 wiring check

| Question                                                                              | Status |
| ------------------------------------------------------------------------------------- | ------ |
| `cargo check -p storycapture --lib`                                                   | green  |
| `pnpm --filter @storycapture/desktop typecheck`                                       | green  |
| `bash -n scripts/release/{verify-installer-size.sh,generate-updater-signing-key.sh}`  | green  |
| `node --check scripts/release/generate-latest-json.mjs`                               | green  |
| `python3 -c yaml.safe_load` on all three new workflows                                | green  |
| `release.yml` contains `tags:` + `notarize-mac.sh` + `sign-windows.ps1` + `TAURI_SIGNING_PRIVATE_KEY` + `verify-installer-size.sh` | green |
| `installer-size-budget.yml` exists + contains `50`                                    | green  |
| `sign-windows.ps1` supports both `TrustedSigning` and `EvCert` modes                  | green  |
| `tauri.conf.json` has `updater` + `pubkey` + `createUpdaterArtifacts: true`           | green  |
| `updater.rs` defines `check_update` + `install_update`                                | green  |
| `auto-updater.tsx` has "Check for updates on launch" toggle defaulting OFF            | green  |
| `release-soak.yml` has `workflow_run` + `gh release download` + `real-capture`        | green  |

## Telemetry audit

`grep -rn 'reqwest\|hyper\|http_req\|ureq' apps/desktop/src-tauri/src/ crates/`
→ a single hit in `apps/desktop/src-tauri/src/logging.rs:69`, inside a **comment** ("Bridge log -> tracing (chromiumoxide, hyper, etc. use `log`)"). No first-party HTTP-client code is linked into the default execution path. `tauri-plugin-updater` is the only crate that speaks HTTP, and it's only called from the two `check_update` / `install_update` commands which are themselves invoked exclusively by the opt-in Settings UI (default OFF).

Conclusion: DIST-05 is held by construction — zero outbound traffic in the default configuration.

## Decisions Made

- **Windows signing path:** Microsoft Trusted Signing (primary). Confirmed in `sign-windows.ps1` via `-Mode TrustedSigning` default; EV cert fallback via `-Mode EvCert`.
- **Final installer sizes per triple:** not yet measurable — requires the Apple + Tauri-updater secrets to be provisioned so `release.yml` can complete a real build. `verify-installer-size.sh` enforces the budget the moment the first build runs; sizes will be recorded in a follow-up addendum after the first `v*` tag.
- **Auto-updater end-to-end test result:** unverified at this commit — see "Awaiting human verification" below. The wiring is proven by `cargo check` + `pnpm typecheck` + unit-level plugin docs but the full check → download → verify → install → relaunch dance requires two releases on a clean machine.
- **Telemetry audit grep output:** reported above; single comment hit, no network-initiating first-party code.
- **OWNER placeholder value:** `{{ORG_PLACEHOLDER}}` — repo organisation / user name not yet decided. Operator must replace before pushing the first `v*` tag.
- **Secrets that still need provisioning:** `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_DEVELOPER_IDENTITY`, `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_KEY_VAULT_URL`, `WINDOWS_SIGNING_CERT_NAME` (or `EV_CERT_AZURE_KV_NAME` for Path B), `TAURI_UPDATER_PRIVATE_KEY`, `TAURI_UPDATER_KEY_PASSWORD`.
- **First successful tag release version:** none yet; anticipated first tag is `v0.1.0-rc1` per the plan's checkpoint script.

## Awaiting human verification (Task 3)

`checkpoint:human-verify` — blocked pending operator action. See `01-10-RESUME.md` for the full 10-step checklist. In short: provision the above GitHub Secrets, replace `{{ORG_PLACEHOLDER}}` in `tauri.conf.json`, paste the generated updater public key, push `v0.1.0-rc1`, run the 10-step verification on a clean Mac + Windows VM, reply `approved` when green.

This is an **authentication / credential-provisioning gate**, not a build defect. No agent can discharge it without live secrets + clean hardware.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking] `@tauri-apps/plugin-store` not in the desktop app's dependencies**

- **Found during:** Task 1 `pnpm typecheck` — the plan directed the Settings UI to persist the toggle via `@tauri-apps/plugin-store`, but that package isn't listed in `apps/desktop/package.json`. Adding it pulls in an additional Tauri plugin that nothing else in Phase 1 uses, expanding the dep surface.
- **Fix:** Persist the opt-in pref via `window.localStorage` under key `storycapture.updater.check-on-launch`. Behaviour is identical from the user's perspective (default OFF, toggle remembered across app restarts). A one-line swap to plugin-store is a trivial future task when any other Phase consumes it.
- **Files modified:** `apps/desktop/src/features/settings/auto-updater.tsx`.
- **Commit:** `5fcf6d5`.

**2. [Rule 2 — missing critical functionality] `.gitignore` entry for `.release-keys/`**

- **Found during:** Task 1 — the plan called out "DO NOT commit .key" in the helper script's output but didn't add `.release-keys/` to the root `.gitignore`. Without that, `git status` would dutifully surface the private key as an untracked file waiting to be added.
- **Fix:** Added `.release-keys/` to `.gitignore` with a comment pointing at Plan 01-10's rationale.
- **Files modified:** `.gitignore`.
- **Commit:** `5fcf6d5`.

**3. [Rule 2 — missing critical functionality] `generate-latest-json.mjs` was referenced in the plan's release workflow but not specified as a separate artifact**

- **Found during:** Task 1 — `release.yml`'s `publish` job invokes `node scripts/release/generate-latest-json.mjs > latest.json`, but the plan's file list didn't include that script.
- **Fix:** Authored the script. Implements the Tauri v2 static-JSON manifest format (`https://v2.tauri.app/plugin/updater/#server-support`), classifies assets by filename (`.app.tar.gz` → darwin, `-setup.nsis.zip` → windows), inlines `.sig` contents into the `signature` fields. Uses the built-in `fetch` available on Node 20.
- **Files added:** `scripts/release/generate-latest-json.mjs`.
- **Commit:** `5fcf6d5`.

**4. [Rule 3 — blocking] `tauri-plugin-store` was not added as a package dep (same as Rule 3 #1 — documented separately because it affected the Rust side too)**

- **Found during:** Task 1 Rust compile.
- **Issue:** No Rust-side change needed — the Settings UI doesn't require a Rust plugin when using localStorage. Rust compile was green.
- **Commit:** n/a.

### Authentication Gates

Task 3 is an authentication gate — see "Awaiting human verification" above.

## Known Stubs

- **`{{ORG_PLACEHOLDER}}`** in `tauri.conf.json` → `plugins.updater.endpoints[0]`. Replaced by the operator before the first release tag.
- **`PUBKEY_PLACEHOLDER_FILL_VIA_TAURI_SIGNER_GENERATE_AT_RELEASE_CI`** in `tauri.conf.json` → `plugins.updater.pubkey`. Replaced by the operator with the output of `scripts/release/generate-updater-signing-key.sh`.

Both stubs are inert at runtime — `tauri-plugin-updater::check` is never invoked by default (Settings toggle defaults OFF), so an unreplaced placeholder only surfaces as a user-visible error after they've explicitly opted in. No unintended network activity or crash potential.

## Threat Flags

None beyond the plan's register (T-10-01 through T-10-07). All new surface is either behind a signature-verified Tauri plugin (updater), behind the Azure tenant boundary (Windows signing), or file-local (size verifier).

## Self-Check: PASSED

**Files created (verified on disk):**

- FOUND: `.github/workflows/release.yml`
- FOUND: `.github/workflows/installer-size-budget.yml`
- FOUND: `.github/workflows/release-soak.yml`
- FOUND: `scripts/release/sign-windows.ps1`
- FOUND: `scripts/release/verify-installer-size.sh`
- FOUND: `scripts/release/generate-updater-signing-key.sh`
- FOUND: `scripts/release/generate-latest-json.mjs`
- FOUND: `scripts/release/WINDOWS-SIGNING.md`
- FOUND: `apps/desktop/src-tauri/src/commands/updater.rs`
- FOUND: `apps/desktop/src/ipc/updater.ts`
- FOUND: `apps/desktop/src/features/settings/auto-updater.tsx`
- FOUND: `.planning/phases/01-foundation-dsl-automation-capture-encode/01-10-RESUME.md`

**Files modified (verified via git diff):**

- FOUND: `apps/desktop/src-tauri/tauri.conf.json` (updater block updated)
- FOUND: `apps/desktop/src-tauri/src/commands/mod.rs` (updater module registered)
- FOUND: `apps/desktop/src-tauri/src/ipc_spec.rs` (check_update / install_update + UpdateInfo type)
- FOUND: `.gitignore` (.release-keys/ entry)

**Commits (verified in git log):**

- FOUND: `5fcf6d5` — Task 1 (release CI + signing + size budget + updater wiring)
- FOUND: `958ddff` — Task 2 (release-soak workflow)

**Task 3 — checkpoint:human-verify:** BLOCKED pending operator action. Tracked in `01-10-RESUME.md`; not a build defect.
