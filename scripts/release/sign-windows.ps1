<#
.SYNOPSIS
  Sign a StoryCapture Windows installer via Microsoft Trusted Signing
  (preferred, per D-42) or EV cert stored in Azure Key Vault (fallback).

.DESCRIPTION
  Both modes use `azuresigntool` (AzureSignTool) which authenticates to an
  Azure tenant via env-var service principal credentials and signs with an
  Azure Key Vault certificate. The only effective difference is which KV
  certificate is referenced — Microsoft Trusted Signing is a managed profile,
  EV cert is customer-supplied.

  Runs `signtool verify /pa /v` after signing to confirm the signature chain
  resolves and the timestamp is present.

.PARAMETER InstallerPath
  Path to the NSIS or MSI installer to sign.

.PARAMETER Mode
  "TrustedSigning" (Microsoft Trusted Signing; default) or "EvCert"
  (Azure Key Vault EV cert fallback).

.NOTES
  Required environment variables (set by .github/workflows/release.yml
  from repository secrets):
    AZURE_TENANT_ID
    AZURE_CLIENT_ID
    AZURE_CLIENT_SECRET
    AZURE_KEY_VAULT_URL           (e.g. https://<vault>.vault.azure.net)
    WINDOWS_SIGNING_CERT_NAME     (Trusted Signing certificate profile name)
    EV_CERT_AZURE_KV_NAME         (EV cert name in Key Vault; EvCert mode)

  See scripts/release/WINDOWS-SIGNING.md for provisioning instructions.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidateSet("TrustedSigning", "EvCert")][string]$Mode
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InstallerPath)) {
  throw "InstallerPath does not exist: $InstallerPath"
}

function Require-Env {
  param([string]$Name)
  $val = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($val)) {
    throw "$Name environment variable is not set"
  }
  return $val
}

$tenant   = Require-Env AZURE_TENANT_ID
$clientId = Require-Env AZURE_CLIENT_ID
$clientSc = Require-Env AZURE_CLIENT_SECRET
$kvUrl    = Require-Env AZURE_KEY_VAULT_URL

switch ($Mode) {
  "TrustedSigning" {
    $certName = Require-Env WINDOWS_SIGNING_CERT_NAME
    Write-Host "Signing via Microsoft Trusted Signing (cert profile: $certName)"
  }
  "EvCert" {
    $certName = Require-Env EV_CERT_AZURE_KV_NAME
    Write-Host "Signing via Azure Key Vault EV cert (cert name: $certName)"
  }
}

# Ensure azuresigntool is available. `dotnet tool install -g AzureSignTool`
# is the canonical install; the GH runner images include `dotnet` preinstalled.
if (-not (Get-Command azuresigntool -ErrorAction SilentlyContinue)) {
  Write-Host "Installing AzureSignTool as a dotnet global tool..."
  & dotnet tool install --global AzureSignTool | Out-Null
  $env:PATH = "$env:USERPROFILE\.dotnet\tools;$env:PATH"
}

& azuresigntool sign `
  -kvu $kvUrl `
  -kvt $tenant `
  -kvi $clientId `
  -kvs $clientSc `
  -kvc $certName `
  -tr "http://timestamp.digicert.com" `
  -td sha256 `
  -fd sha256 `
  -v `
  $InstallerPath

if ($LASTEXITCODE -ne 0) { throw "azuresigntool failed with exit $LASTEXITCODE" }

# `signtool` ships with the Windows 10 SDK on GH runners.
& signtool verify /pa /v $InstallerPath
if ($LASTEXITCODE -ne 0) { throw "signtool verify failed with exit $LASTEXITCODE" }

Write-Host "Signed: $InstallerPath"
