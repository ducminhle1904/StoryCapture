# Credentials & Signing Secrets

Single source of truth for external credentials used by release, notarization,
desktop auth, web uploads, and transactional email.

When you provision a credential, add it to GitHub Actions secrets and the
matching local environment if the flow is run outside CI.

## macOS signing and notarization

Used by:

- `scripts/notarize/notarize-mac.sh`
- `scripts/notarize/notarize-smoke.sh`
- `.github/workflows/notarize-smoke.yml`
- `.github/workflows/release.yml`

Required secrets:

| CI secret | Local env | Purpose |
|---|---|---|
| `APPLE_ID` | `APPLE_ID` | Apple account for notarization |
| `APPLE_APP_PASSWORD` | `APPLE_APP_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | Apple developer team |
| `APPLE_SIGNING_IDENTITY` | `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_CERTIFICATE_P12_BASE64` | n/a | Import signing cert on clean runners |
| `APPLE_CERTIFICATE_PASSWORD` | n/a | Unlock exported `.p12` |

Notes:

- The smoke path intentionally stays green when these secrets are absent.
- `scripts/notarize/adhoc-sign.sh` does not use paid credentials.
- `scripts/notarize/smoke-app/` is a standalone Tauri fixture used to prove the
  notarization pipeline before shipping the real app.

## Windows signing

Used by:

- `scripts/release/sign-windows.ps1`
- `.github/workflows/release.yml`

Supported modes:

- `TrustedSigning`
  Microsoft Trusted Signing via AzureSignTool
- `EvCert`
  EV certificate stored in Azure Key Vault, also via AzureSignTool

Required secrets:

| CI secret | Local env | Purpose |
|---|---|---|
| `AZURE_TENANT_ID` | `AZURE_TENANT_ID` | Azure AD tenant |
| `AZURE_CLIENT_ID` | `AZURE_CLIENT_ID` | Service principal client ID |
| `AZURE_CLIENT_SECRET` | `AZURE_CLIENT_SECRET` | Service principal client secret |
| `AZURE_KEY_VAULT_URL` | `AZURE_KEY_VAULT_URL` | Azure Key Vault URL |
| `WINDOWS_SIGNING_CERT_NAME` | `WINDOWS_SIGNING_CERT_NAME` | Trusted Signing cert/profile name |
| `EV_CERT_AZURE_KV_NAME` | `EV_CERT_AZURE_KV_NAME` | EV cert name for fallback mode |

Notes:

- This is no longer a deferred placeholder; the release workflow already calls
  `sign-windows.ps1`.
- Provisioning details belong in `scripts/release/WINDOWS-SIGNING.md`.

## Tauri updater signing

Used by:

- `scripts/release/generate-updater-signing-key.sh`
- `.github/workflows/release.yml`
- `apps/desktop/src-tauri/tauri.conf.json`

Required secrets:

| CI secret | Purpose |
|---|---|
| `TAURI_UPDATER_PRIVATE_KEY` | Private key used to sign updater artifacts |
| `TAURI_UPDATER_KEY_PASSWORD` | Password chosen during key generation |

Notes:

- Generate once, never commit the private key.
- Copy the public key into `tauri.conf.json`.

## Desktop AI and TTS keys

Stored in the OS keychain at runtime, not in repo secrets.

| Key name | Service |
|---|---|
| `storycapture.anthropic` | Anthropic |
| `storycapture.openai` | OpenAI |
| `storycapture.elevenlabs` | ElevenLabs |

## Web companion secrets

Required by the deployed Next.js app:

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL for Prisma |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `NEXTAUTH_URL` | Base URL used in invite and auth flows |
| `JWT_SECRET` | Signs desktop tokens and short-lived SSE JWTs |
| `R2_ACCOUNT_ID` | Cloudflare R2 account |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret |
| `R2_BUCKET` | Bucket name, defaults to `storycapture-media` |
| `RESEND_API_KEY` | Invite emails (graceful skip when unset — operator shares invite link manually) |
| `CRON_SECRET` | Guards `/api/cron/aggregate-analytics` |
| `MAXMIND_LICENSE_KEY` | Optional. GeoLite2 download key used by `apps/web/scripts/download-geolite2.sh`; analytics still work without it but country breakdown is empty |
| `NEXT_PUBLIC_*` (build-time) | Public env routed into the client bundle — see `apps/web/.env.example` |

Notes:

- Analytics GeoIP uses `@maxmind/geoip2-node` plus the local database at
  `apps/web/public/geolite2/GeoLite2-Country.mmdb`.
- Vercel cron runs `/api/cron/aggregate-analytics` daily at 00:00 UTC via
  `apps/web/vercel.json`.

## Missing-secret behavior

| Script / workflow | Behavior when secret is missing |
|---|---|
| `scripts/notarize/notarize-mac.sh` | Prints skip message and exits 0 |
| `scripts/notarize/notarize-smoke.sh` | Prints skip message and exits 0 |
| `.github/workflows/notarize-smoke.yml` | Verifies gating path still works |
| `.github/workflows/ffmpeg-build.yml` | Unaffected |
| `.github/workflows/release.yml` | Requires release secrets to complete successfully |

Last updated: 2026-04-25
