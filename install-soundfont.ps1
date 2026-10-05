#Requires -Version 5.1
<#
.SYNOPSIS
  Downloads the GeneralUser-GS SoundFont and installs it for use with FluidSynth.

.DESCRIPTION
  Fetches GeneralUser-GS.sf2 from the mrbumpy409/GeneralUser-GS GitHub repo
  and places it in %USERPROFILE%\soundfonts\. Verifies the download is a
  valid SoundFont (checks the RIFF/sfbk header) before finishing.

.PARAMETER Destination
  Directory to install the SoundFont into. Defaults to
  "$env:USERPROFILE\soundfonts".

.PARAMETER Force
  Re-download even if the file already exists.

.EXAMPLE
  .\install-soundfont.ps1
  .\install-soundfont.ps1 -Destination "D:\soundfonts" -Force
#>

[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE 'soundfonts'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- Configuration -----------------------------------------------------------

$Url      = 'https://github.com/mrbumpy409/GeneralUser-GS/raw/main/GeneralUser-GS.sf2'
$FileName = 'GeneralUser-GS.sf2'
$Target   = Join-Path $Destination $FileName

# --- Helpers -----------------------------------------------------------------

function Write-Step  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host "    $m" -ForegroundColor Yellow }

# --- Pre-flight --------------------------------------------------------------

Write-Step "Checking destination: $Destination"
if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Write-Ok "Created $Destination"
} else {
    Write-Ok "Directory exists"
}

if ((Test-Path -LiteralPath $Target) -and -not $Force) {
    $existing = Get-Item -LiteralPath $Target
    Write-Warn2 "$FileName already present ($([math]::Round($existing.Length/1MB,2)) MB). Use -Force to re-download."
    return
}

# --- Download ----------------------------------------------------------------

Write-Step "Downloading $FileName (~30 MB, may take a moment)"
Write-Host "    From: $Url"

# Ensure TLS 1.2 for older PowerShell 5.1 defaults
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$tmp = "$Target.download"

try {
    # -UseBasicParsing avoids the IE engine dependency on Server Core / fresh boxes
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
} catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    throw "Download failed: $($_.Exception.Message)"
}

# --- Verify ------------------------------------------------------------------

Write-Step "Verifying download"

if (-not (Test-Path -LiteralPath $tmp)) {
    throw "Download produced no file."
}

$size = (Get-Item -LiteralPath $tmp).Length
Write-Ok "Received $([math]::Round($size/1MB,2)) MB"

if ($size -lt 1MB) {
    Remove-Item -LiteralPath $tmp -Force
    throw "File is suspiciously small ($size bytes). Probably a redirect page, not the SoundFont."
}

# SoundFont files start with 'RIFF' and contain 'sfbk' at offset 8.
$bytes = [System.IO.File]::ReadAllBytes($tmp)[0..11]
$riff  = [System.Text.Encoding]::ASCII.GetString($bytes[0..3])
$sfbk  = [System.Text.Encoding]::ASCII.GetString($bytes[8..11])

if ($riff -ne 'RIFF' -or $sfbk -ne 'sfbk') {
    Remove-Item -LiteralPath $tmp -Force
    throw "Not a valid SoundFont. Header was RIFF='$riff' sfbk='$sfbk' (expected 'RIFF' and 'sfbk')."
}

Write-Ok "Valid SoundFont (RIFF/sfbk header confirmed)"

# --- Commit ------------------------------------------------------------------

if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
Move-Item -LiteralPath $tmp -Destination $Target

Write-Step "Installed"
Write-Host "    $Target" -ForegroundColor Green
Write-Host ""
Write-Host "Test it with:" -ForegroundColor Cyan
Write-Host "    fluidsynth -F tune.wav `"$Target`" tune.mid"
Write-Host ""
Write-Host "Or add it as a shell alias / script param to reuse." -ForegroundColor Cyan