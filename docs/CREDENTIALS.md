# Credentials & Signing Secrets

Single source of truth for external credentials used by desktop signing,
desktop provider keys, web auth/uploads, transactional email, analytics, and
desktop-web token exchange.

When you provision a credential, add it to GitHub Actions secrets and the
matching local environment if the flow runs outside CI. Never commit plaintext
secrets.

## macOS Signing And Notarization

Used by:

- `scripts/notarize/notarize-mac.sh`

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

- Local Electron package builds skip signing when no Developer ID certificate is
  installed.
- `scripts/notarize/adhoc-sign.sh` does not use paid credentials.

## Windows Signing

Used by:

- `scripts/release/sign-windows.ps1`

Supported modes:

- `TrustedSigning`: Microsoft Trusted Signing via AzureSignTool.
- `EvCert`: EV certificate stored in Azure Key Vault, also via AzureSignTool.

Required secrets:

| CI secret | Local env | Purpose |
|---|---|---|
| `AZURE_TENANT_ID` | `AZURE_TENANT_ID` | Azure AD tenant |
| `AZURE_CLIENT_ID` | `AZURE_CLIENT_ID` | Service principal client ID |
| `AZURE_CLIENT_SECRET` | `AZURE_CLIENT_SECRET` | Service principal client secret |
| `AZURE_KEY_VAULT_URL` | `AZURE_KEY_VAULT_URL` | Azure Key Vault URL |
| `WINDOWS_SIGNING_CERT_NAME` | `WINDOWS_SIGNING_CERT_NAME` | Trusted Signing cert/profile name |
| `EV_CERT_AZURE_KV_NAME` | `EV_CERT_AZURE_KV_NAME` | EV cert name for fallback mode |

There is no current GitHub release workflow. Signing scripts are standalone
unless a future workflow wires them into CI/release.

## Desktop AI And TTS Keys

Stored in the OS keychain at runtime, not in repo secrets.

| Key name | Service |
|---|---|
| `storycapture.anthropic` | Anthropic |
| `storycapture.openai` | OpenAI |
| `storycapture.elevenlabs` | ElevenLabs |

Provider-key UI and IPC should keep using the desktop secret storage surface.
Do not route these keys through web env vars.

## Desktop Runtime Env

Non-secret runtime toggles/URLs used by the Electron host:

| Env var | Purpose |
|---|---|
| `STORYCAPTURE_WEB_URL` | Overrides the web companion base URL used by desktop web-sync/upload flows |
| `STORYCAPTURE_DEBUG_UPDATER` | Enables updater debug behavior/logging in development diagnostics |

Document any new desktop runtime env here even when it is not secret.

## Web Companion Secrets

Use `apps/web/.env.example` as the local template.

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL for Prisma |
| `AUTH_SECRET` | NextAuth/Auth.js secret |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub OAuth |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `NEXTAUTH_URL` | Public base URL for auth/invite links; optional local default, required/explicit in production |
| `JWT_SECRET` | Signs desktop tokens and short-lived SSE JWTs |
| `R2_ACCOUNT_ID` | Cloudflare R2 account |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret |
| `R2_BUCKET` | Bucket name, defaults to `storycapture-media` |
| `RESEND_API_KEY` | Invite emails |
| `CRON_SECRET` | Bearer secret for `/api/cron/aggregate-analytics` |
| `MAXMIND_LICENSE_KEY` | Optional GeoLite2 download key |
| `NEXT_PUBLIC_*` | Public env routed into the client bundle |

Production must set `CRON_SECRET`. Current code enforces the cron bearer check
only when `CRON_SECRET` is set; leaving it empty disables that protection.

## Desktop-Web Token Exchange

- Desktop token exchange and SSE JWT minting live under `apps/web/src/app/api/auth`.
- `JWT_SECRET` signs desktop tokens and short-lived subscription tokens.
- Sync subscriptions verify JWT plus workspace membership before streaming
  project or recording-status updates.

## Missing-Secret Behavior

| Script / flow | Behavior when secret is missing |
|---|---|
| `scripts/notarize/notarize-mac.sh` | Prints skip message and exits 0 |
| Local Electron package build | Skips signing when no Developer ID certificate exists |
| Web cron without `CRON_SECRET` | Bearer check is disabled; not acceptable for production |
| Desktop provider key missing | Provider-specific AI/TTS features should fail gated or prompt for setup |

Last updated: 2026-06-19
