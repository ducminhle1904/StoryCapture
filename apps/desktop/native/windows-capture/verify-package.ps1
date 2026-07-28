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

$Commands = @(
  '{"version":3,"type":"capabilities"}',
  '{"version":3,"type":"shutdown","session_id":null}'
)
$Output = $Commands | & $Helper --stdio-v3
if ($LASTEXITCODE -ne 0) { throw "Packaged WGC helper protocol smoke failed." }
$Hello = $Output | Select-Object -First 1 | ConvertFrom-Json
if ($Hello.version -ne 3 -or
    $Hello.type -ne "hello" -or
    $Hello.backend_id -ne "windows-graphics-capture" -or
    $Hello.backend_version -ne "1.0.0") {
  throw "Packaged WGC helper returned an invalid protocol identity."
}
$Capabilities = $Output | Select-Object -Skip 1 | Select-Object -First 1 | ConvertFrom-Json
if ($Capabilities.version -ne 3 -or
    $Capabilities.type -ne "capabilities" -or
    $Capabilities.capabilities.codec -ne "h264" -or
    $Capabilities.capabilities.pixel_format -ne "nv12" -or
    $Capabilities.capabilities.hardware_accelerated -ne $true -or
    $Capabilities.capabilities.keeps_surfaces_native -ne $true) {
  throw "Packaged WGC helper returned an invalid V3 native-master contract."
}

Get-FileHash -Algorithm SHA256 -LiteralPath $Helper
