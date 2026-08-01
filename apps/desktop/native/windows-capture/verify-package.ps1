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

$V4Commands = @(
  '{"version":4,"type":"capabilities"}',
  '{"version":4,"type":"shutdown","session_id":null}'
)
$V4Output = $V4Commands | & $Helper --stdio-v4
if ($LASTEXITCODE -ne 0) { throw "Packaged WGC helper V4 protocol smoke failed." }
$V4Hello = $V4Output | Select-Object -First 1 | ConvertFrom-Json
$V4Capabilities = $V4Output | Select-Object -Skip 1 | Select-Object -First 1 | ConvertFrom-Json
if ($V4Hello.version -ne 4 -or
    $V4Hello.type -ne "hello" -or
    $V4Capabilities.version -ne 4 -or
    $V4Capabilities.type -ne "capabilities" -or
    $V4Capabilities.capabilities.physical_width -ne 1920 -or
    $V4Capabilities.capabilities.physical_height -ne 1080 -or
    $V4Capabilities.capabilities.exact_fps.numerator -ne 60 -or
    $V4Capabilities.capabilities.exact_fps.denominator -ne 1 -or
    $V4Capabilities.capabilities.hardware_accelerated -ne $true -or
    $V4Capabilities.capabilities.keeps_surfaces_native -ne $true) {
  throw "Packaged WGC helper returned an invalid V4 verified_1080p60 capability contract."
}

Get-FileHash -Algorithm SHA256 -LiteralPath $Helper
