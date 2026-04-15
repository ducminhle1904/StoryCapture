# Windows Code Signing

Per **D-42**, StoryCapture's tagged Windows releases are signed via one of
two paths. Both use the Azure Key Vault API through `AzureSignTool`; the
only difference is which certificate lives in the vault.

**PR builds are explicitly allowed to ship unsigned** — signing only runs
on `push: tags: v*` via `.github/workflows/release.yml`.

## Path A — Microsoft Trusted Signing (preferred, $9.99 / month)

Microsoft Trusted Signing (GA since mid-2024) is a managed service that
issues short-lived certificates backed by Microsoft's public PKI.
SmartScreen trust is immediate (no EV reputation warm-up).

### One-time setup

1. Azure Portal → **Trusted Signing Accounts** → Create.
   - Name: `storycapture-trusted-signing`
   - Region: EastUS (Trusted Signing is region-pinned).
2. Under that account, create a **Certificate Profile**:
   - Name: `storycapture-prod-signing`  ← **this is `WINDOWS_SIGNING_CERT_NAME`**
   - Profile type: *Public Trust*
   - Identity validation: use your organization's existing identity record
     (Azure AD tenant validation typically completes in 1-3 business days).
3. Azure Portal → **App registrations** → Create a service principal:
   - Name: `storycapture-ci-signer`
   - Grant role **Trusted Signing Certificate Profile Signer** scoped to
     the certificate profile above.
4. Generate a client secret for the service principal.

### GitHub Secrets (Repo → Settings → Secrets and variables → Actions)

| Secret                        | Value                                               |
| ----------------------------- | --------------------------------------------------- |
| `AZURE_TENANT_ID`             | Azure AD tenant ID (GUID)                           |
| `AZURE_CLIENT_ID`             | Service principal application (client) ID          |
| `AZURE_CLIENT_SECRET`         | Service principal client secret                     |
| `AZURE_KEY_VAULT_URL`         | `https://<trusted-signing-endpoint>.vault.azure.net`|
| `WINDOWS_SIGNING_CERT_NAME`   | Trusted Signing certificate profile name            |

### Invocation

`release.yml` passes `-Mode TrustedSigning` to `sign-windows.ps1`. See
that script for the full `azuresigntool` command line.

## Path B — EV cert via Azure Key Vault (fallback, ~$300 / year)

Only used if Trusted Signing is unavailable (e.g., identity validation
stalled, region not yet supported). An EV (Extended Validation) code
signing certificate from DigiCert / Sectigo / GlobalSign is purchased,
issued on a hardware token, then imported into Azure Key Vault.

### One-time setup

1. Purchase an EV certificate from a CA that supports Key Vault import
   (DigiCert and Sectigo both publish guides).
2. Follow the CA's "import to Azure Key Vault" procedure (typically:
   generate a CSR in Key Vault, merge the CA's response, verify).
3. Create a service principal and grant it the built-in
   **Key Vault Certificate User** role on the vault.

### GitHub Secrets

Same five Azure vars as above, plus:

| Secret                    | Value                              |
| ------------------------- | ---------------------------------- |
| `EV_CERT_AZURE_KV_NAME`   | Certificate name inside Key Vault  |

### Invocation

`release.yml` passes `-Mode EvCert` to `sign-windows.ps1`.

## Decision matrix

| Criterion                       | Trusted Signing    | EV Key Vault     |
| ------------------------------- | ------------------ | ---------------- |
| SmartScreen reputation warm-up  | Immediate          | Weeks-to-months  |
| Annual cost                     | $9.99 / mo (~$120) | ~$300            |
| Hardware token required         | No                 | Yes (for issuance) |
| Identity validation lead time   | 1-3 business days  | 1-2 weeks        |
| Renewal                         | Automatic          | Manual (yearly)  |

StoryCapture defaults to Trusted Signing; `sign-windows.ps1 -Mode EvCert`
is the break-glass.

## Failure modes

- `AzureSignTool` returns `Unauthorized` → service principal is missing
  the `Trusted Signing Certificate Profile Signer` role (Path A) or
  `Key Vault Certificate User` role (Path B).
- `signtool verify /pa /v` fails after signing → timestamp server
  unreachable; retry with `-tr http://timestamp.sectigo.com` fallback.
- SmartScreen warning persists on new EV cert → expected; EV reputation
  accrues after ~50-100 downloads under the same cert.

## Unsigned PR builds

Per D-42, PR builds run `tauri build` without invoking `sign-windows.ps1`;
unsigned `.exe` / `.msi` artifacts are acceptable for review and testing.
Only the release workflow (triggered by `tag:v*`) enforces signing.
