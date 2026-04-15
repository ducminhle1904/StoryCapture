# Credentials & Signing Secrets

This document is the **single source of truth** for every external credential
StoryCapture needs to ship signed, notarized, auto-updateable releases. Phase
1 ships before any of these are provisioned (no_credentials_mode), so every
script and CI workflow that depends on them is guarded by env-var presence
checks and exits cleanly when absent.

When you provision a credential, add it to the repo's GitHub Secrets *and*
the matching local-dev environment (e.g., `~/.zshrc`, `direnv`, or a
`.env.local` consumed by `dotenv`).

---

## macOS — Developer ID signing + notarization (Phase 1 release gate)

| Secret name in CI            | Local env var               | Required by                                               | Where to get it                                                                                       |
| ---------------------------- | --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `APPLE_ID`                   | `APPLE_ID`                  | `notarize-mac.sh`, `notarize-smoke.yml`                   | The Apple ID email tied to your paid Apple Developer Program account ($99/yr).                        |
| `APPLE_APP_PASSWORD`         | `APPLE_APP_PASSWORD`        | `notarize-mac.sh`, `notarize-smoke.yml`                   | App-specific password — generate at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords. **Not** your real Apple ID password. |
| `APPLE_TEAM_ID`              | `APPLE_TEAM_ID`             | `notarize-mac.sh`, `notarize-smoke.yml`                   | 10-character team ID — find at <https://developer.apple.com/account> → Membership → Team ID.          |
| `APPLE_SIGNING_IDENTITY`     | `APPLE_SIGNING_IDENTITY`    | `notarize-mac.sh`, `notarize-smoke.yml`                   | Full string, e.g. `Developer ID Application: Acme Inc (TEAMID)`. Run `security find-identity -v -p codesigning` after importing your cert to see the exact label. |
| `APPLE_CERTIFICATE_P12_BASE64` | n/a (CI only)             | `notarize-smoke.yml` (cert import on a fresh runner)      | `base64 -i DeveloperIDApplication.p12 \| pbcopy`. Export the cert from Keychain Access as `.p12`.    |
| `APPLE_CERTIFICATE_PASSWORD` | n/a (CI only)               | `notarize-smoke.yml` (decrypts the .p12 above)            | The password you set when exporting the .p12.                                                         |

**How to provision (one-time):**

1. Pay $99 to enroll in the Apple Developer Program.
2. In Xcode → Settings → Accounts, add your Apple ID and **Manage Certificates → +
   Developer ID Application**. Apple issues the cert to your team.
3. In Keychain Access, locate the new cert (`Developer ID Application: <Team>`),
   right-click → Export → save as `.p12` with a strong password.
4. Generate an app-specific password at appleid.apple.com (label it
   "StoryCapture notarytool").
5. Add all six secrets above to GitHub: **Settings → Secrets and variables →
   Actions → New repository secret**.
6. Re-run the `notarize-smoke` workflow. The credential gate now flips and
   the full pipeline runs end-to-end.

**Until then:** every guarded step prints
`[notarize-mac] skipped — credentials pending` and exits 0. CI stays green.

---

## Windows — code signing (deferred to Plan 10)

Per D-42, Windows signing is a small spike, not a Phase-1 blocker. Unsigned
PR builds are acceptable. The variable names are reserved here so Plan 10
can drop them in without renaming.

| Secret name in CI                | Local env var                  | Required by                          | Where to get it                                                                                  |
| -------------------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `WINDOWS_TRUSTED_SIGNING_ENDPOINT` | `WINDOWS_TRUSTED_SIGNING_ENDPOINT` | future `sign-windows.ps1`        | Microsoft Trusted Signing endpoint URL (preferred 2026 default).                                 |
| `WINDOWS_TRUSTED_SIGNING_ACCOUNT`  | `WINDOWS_TRUSTED_SIGNING_ACCOUNT`  | future `sign-windows.ps1`        | Trusted Signing account name.                                                                    |
| `WINDOWS_TRUSTED_SIGNING_PROFILE`  | `WINDOWS_TRUSTED_SIGNING_PROFILE`  | future `sign-windows.ps1`        | Trusted Signing certificate profile name.                                                        |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET` | same | future `sign-windows.ps1`        | Azure AD service principal with permissions on the Trusted Signing resource.                     |
| `WINDOWS_EV_CERT_THUMBPRINT` (alt) | `WINDOWS_EV_CERT_THUMBPRINT`   | fallback signtool path               | If using EV cert via Azure Key Vault instead of Trusted Signing.                                 |

**Status:** all dormant. No script in Phase 1 references these.

---

## LLM / TTS API keys (Phase 3)

Per D-29, secrets land in the OS keychain at runtime via
`tauri-plugin-keyring`. They are **never** stored as repo secrets and never
committed in plaintext. Listed here for visibility only:

| Key name (in OS keychain) | Service           | Required by                |
| ------------------------- | ----------------- | -------------------------- |
| `storycapture.anthropic`  | Anthropic Claude  | Phase 3 NL → DSL           |
| `storycapture.openai`     | OpenAI            | Phase 3 NL → DSL fallback  |
| `storycapture.elevenlabs` | ElevenLabs TTS    | Phase 3 voiceover          |

The Phase-1 keyring scaffold lands without using any of these keys (per D-29:
"so Phase 3 drops in without plumbing").

---

## Web companion (Phase 4)

Deferred — see Phase 4 plan when scoped. Will include `DATABASE_URL`,
`NEXTAUTH_SECRET`, OAuth client IDs/secrets, S3/R2 access keys, JWT signing
keys.

---

## How scripts behave when secrets are missing

| Script / workflow             | With creds                                          | Without creds                                              |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `scripts/notarize/notarize-mac.sh`   | Full sign + notarize + staple; non-zero on reject. | Prints "skipped — credentials pending"; exits 0.            |
| `scripts/notarize/notarize-smoke.sh` | Builds smoke binary, notarizes it, asserts spctl.  | Prints skip message; exits 0.                               |
| `scripts/notarize/adhoc-sign.sh`     | (n/a — never uses paid creds)                      | Applies ad-hoc signature so dev TCC entries stay stable.    |
| `.github/workflows/notarize-smoke.yml` | Runs full pipeline on macos-14; uploads `.app`. | Lints scripts + verifies the credential gate; exits green. |
| `.github/workflows/ffmpeg-build.yml`   | (n/a — no signing here)                          | Builds + verifies static FFmpeg unconditionally.            |

---

*Last updated: 2026-04-14 (Phase 1, plan 01-02).*
