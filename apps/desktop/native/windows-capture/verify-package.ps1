[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourcesPath,
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64",
  [string]$ExpectedPublisher = $env:STORYCAPTURE_WINDOWS_CERT_PUBLISHER
)

$ErrorActionPreference = "Stop"
$Helper = Join-Path $ResourcesPath "native/windows/$Architecture/storycapture-wgc.exe"
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) {
  throw "Packaged WGC helper is missing: $Helper"
}

$Signature = Get-AuthenticodeSignature -LiteralPath $Helper
if ($Signature.Status -ne "Valid") {
  throw "Packaged WGC helper Authenticode signature is not valid: $($Signature.Status)"
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher) -and
    $Signature.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") {
  throw "Packaged WGC helper publisher does not match the release identity."
}

$Output = '{"version":2,"type":"shutdown","session_id":null}' | & $Helper --stdio-v2
if ($LASTEXITCODE -ne 0) { throw "Packaged WGC helper protocol smoke failed." }
$Hello = $Output | Select-Object -First 1 | ConvertFrom-Json
if ($Hello.version -ne 2 -or
    $Hello.type -ne "hello" -or
    $Hello.backend_id -ne "windows-graphics-capture" -or
    $Hello.backend_version -ne "1.0.0") {
  throw "Packaged WGC helper returned an invalid protocol identity."
}

Get-FileHash -Algorithm SHA256 -LiteralPath $Helper
