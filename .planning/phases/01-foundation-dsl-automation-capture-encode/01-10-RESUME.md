# Plan 01-10 — RESUME

**Status:** Tasks 1 & 2 complete and committed. Task 3 (`checkpoint:human-verify`) is blocked on human operator action; a continuation agent is NOT required — this checkpoint is purely human-gated.

## Completed tasks

| # | Task | Commit  | Files                                                                                           |
| - | ---- | ------- | ----------------------------------------------------------------------------------------------- |
| 1 | Release CI + Windows signing + installer size budget + auto-updater | `5fcf6d5` | `.github/workflows/{release,installer-size-budget}.yml`, `scripts/release/*`, `apps/desktop/src-tauri/{tauri.conf.json,src/commands/{mod,updater}.rs,src/ipc_spec.rs}`, `apps/desktop/src/{ipc/updater.ts,features/settings/auto-updater.tsx}`, `.gitignore` |
| 2 | Release-soak workflow | `958ddff` | `.github/workflows/release-soak.yml` |

`cargo check -p storycapture --lib` → green.
`pnpm --filter @storycapture/desktop typecheck` → green.
`bash -n` on all new shell scripts → green.
`python3 -c "import yaml"` load of all three new workflow YAML files → green.

## Blocking checkpoint — Task 3

The plan specifies a 10-step end-to-end verification on a clean test machine, requiring:

1. **Apple Developer secrets provisioned in GitHub Secrets** (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_DEVELOPER_IDENTITY`, `APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`).
2. **Windows signing secrets provisioned** (Microsoft Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_KEY_VAULT_URL`, `WINDOWS_SIGNING_CERT_NAME`).
3. **Tauri updater keypair generated and secrets provisioned** via `scripts/release/generate-updater-signing-key.sh`, with the public key pasted into `apps/desktop/src-tauri/tauri.conf.json` (replacing the `PUBKEY_PLACEHOLDER_…` string) and `TAURI_UPDATER_PRIVATE_KEY` / `TAURI_UPDATER_KEY_PASSWORD` stored as GitHub Secrets.
4. **`{{ORG_PLACEHOLDER}}` replaced** in `tauri.conf.json` → `plugins.updater.endpoints[0]` with the real GitHub organisation / user name.
5. **A clean Mac + clean Windows VM** that have never run StoryCapture (for Gatekeeper / SmartScreen reputation assertion).
6. **Network-monitor tooling** (Little Snitch / Wireshark) for the telemetry-off audit.

Given these preconditions, the operator:

- Pushes `v0.1.0-rc1`; watches `Release` workflow matrix complete; downloads the DMG / EXE.
- Verifies `spctl -a -vv` prints `accepted / source=Notarized Developer ID` on macOS.
- Opens installer on Windows VM — SmartScreen does NOT warn (signature trusted).
- Opens the app, goes to Settings → Updates, toggles "Check for updates on launch" → "Check now" → reports up-to-date.
- Pushes `v0.1.0-rc2`; on the installed v0.1.0-rc1 app, "Check now" reports update available; Install → downloads + applies + relaunches.
- Runs `release-soak.yml` via `workflow_dispatch` with `tag_name=v0.1.0-rc2`; both matrix legs green, RSS < 800 MB.
- Network monitor: zero outbound connections for 5 minutes in default config; only the GitHub releases URL appears after toggling auto-updater ON.
- Release asset sizes recorded (FFmpeg-inclusive and residual).

When all 10 steps pass, the operator replies `approved` to signal Task 3 complete and Phase 1 ready for sign-off.

## Items needing a follow-up ticket (independent of Task 3)

- **Widen Plan 01-07 `tests/soak.rs` to honor `CAPTURE_SOAK_TARGET` env var** so `release-soak.yml` truly exercises the installed binary, not just the in-tree crate. Small: add an env-var check to the test entry and spawn the external binary instead of the in-process pipeline when set. Until that lands, `release-soak.yml` is informational (the soak asserts RSS of the cargo test host, which includes the capture crate but not the signed app binary itself). Tracked as a follow-up; in the meantime PR-gate `capture-soak.yml` (Plan 01-07) continues to exercise the in-tree path.
- **Settings route wiring:** the new `<AutoUpdaterSettings>` component is exported but not yet rendered by any route (Phase 1 UI scope does not include a Settings view). A Phase 2 UI plan should add `/settings` and mount this component.

## Why no SUMMARY yet

This plan file notes the standing checkpoint. A `01-10-SUMMARY.md` accompanies this file with the full per-task account and self-check — by plan-level convention the SUMMARY captures what landed; this RESUME captures what's pending.
