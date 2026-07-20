[CmdletBinding()]
param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [ValidateSet("x64", "arm64")]
  [string]$Architecture = "x64",
  [switch]$Sign,
  [string]$CertificateThumbprint = $env:STORYCAPTURE_WINDOWS_CERT_THUMBPRINT,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildRoot = Join-Path $SourceRoot "build/$Architecture"
$OutputRoot = Join-Path $SourceRoot "bin/$Architecture"

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  throw "CMake 3.27 or newer is required to build the WGC helper."
}

cmake -S $SourceRoot -B $BuildRoot -A $Architecture
if ($LASTEXITCODE -ne 0) { throw "WGC helper CMake configure failed." }

cmake --build $BuildRoot --config $Configuration --target storycapture-wgc
if ($LASTEXITCODE -ne 0) { throw "WGC helper build failed." }

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$Executable = Join-Path $BuildRoot "$Configuration/storycapture-wgc.exe"
$PackagedExecutable = Join-Path $OutputRoot "storycapture-wgc.exe"
Copy-Item -Force $Executable $PackagedExecutable

if ($Sign) {
  if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
    throw "Signing is required but STORYCAPTURE_WINDOWS_CERT_THUMBPRINT is not configured."
  }
  $WindowsSdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits/10/bin"
  $SignTool = Get-ChildItem -Path $WindowsSdkRoot -Filter signtool.exe -Recurse |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $SignTool) { throw "Windows SDK signtool.exe was not found." }
  & $SignTool.FullName sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $PackagedExecutable
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed." }
  & $SignTool.FullName verify /pa /all $PackagedExecutable
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed." }
}

Write-Output $PackagedExecutable
