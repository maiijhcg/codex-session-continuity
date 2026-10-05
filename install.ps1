[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OwnerThreadId,
    [string]$InstallDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexSessionContinuity'),
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }),
    [long]$SoftLimit = 500000,
    [long]$HardLimit = 920000,
    [ValidateSet('en','zh-Hant','zh-Hans','ja','es','fr','ko','ru','de')][string]$HandoffLanguage,
    [switch]$NoStartup,
    [switch]$NoStart,
    [switch]$WithIntegration
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$node = Resolve-ContinuityNode
$null = Resolve-ContinuityPowerShell
if ($OwnerThreadId -match '^codex://threads/([0-9a-fA-F-]+)$') { $OwnerThreadId = $Matches[1] }
if ($OwnerThreadId -notmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'OwnerThreadId must be the UUID or link of a dedicated management task.' }
if ($SoftLimit -le 0 -or $HardLimit -le $SoftLimit) { throw 'Thresholds must be positive, with soft smaller than hard.' }
if (-not [IO.Path]::IsPathFullyQualified($InstallDir) -or -not [IO.Path]::IsPathFullyQualified($CodexHome)) { throw 'InstallDir and CodexHome must be absolute paths.' }
$destination = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\','/')
if ($destination -eq $PSScriptRoot.TrimEnd('\','/')) { throw 'Choose an install directory separate from the downloaded source folder.' }
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) { throw 'CodexHome does not exist. Start Codex Desktop once, then check its data directory.' }
if (@(Get-ContinuityProcesses -Root $destination).Count -gt 0) { throw 'Stop the existing installation before upgrading. No running files were replaced.' }
if ((Test-Path -LiteralPath $destination) -and @(Get-ChildItem -LiteralPath $destination -Force).Count -gt 0) {
    $identityFile = Join-Path $destination 'package.json'
    if (-not (Test-Path -LiteralPath $identityFile) -or (Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json).name -ne 'codex-session-continuity') { throw 'Destination is not empty and is not a recognized installation. No files were replaced.' }
}
$files = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-files.json') -Raw | ConvertFrom-Json
foreach ($file in $files) {
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $file))
    if (-not $source.StartsWith($PSScriptRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('Invalid or missing runtime file: ' + $file) }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($file in $files) {
    $target = Join-Path $destination $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target -Force
}
$configurationArgs = @('--owner-thread',$OwnerThreadId,'--codex-home',$CodexHome,'--soft-limit',$SoftLimit,'--hard-limit',$HardLimit)
if ($HandoffLanguage) { $configurationArgs += @('--handoff-language',$HandoffLanguage) }
& $node (Join-Path $destination 'setup-config.mjs') @configurationArgs
if ($LASTEXITCODE -ne 0) { throw 'Configuration failed. Background startup was not enabled.' }
if ($WithIntegration) {
    & $node (Join-Path $destination 'install-integration.mjs') install
    if ($LASTEXITCODE -ne 0) { throw 'Hook/guidance installation failed; inspect the error before starting.' }
}
if (-not $NoStartup) { & (Join-Path $destination 'install-startup.ps1') }
if (-not $NoStart) { & (Join-Path $destination 'start.ps1') }
Write-Output ('Installed at ' + $destination)
Write-Output 'New installations start PAUSED. Review thresholds and enable automatic continuation with menu option 1.'
Write-Output 'Windows sign-in startup is enabled by default unless -NoStartup was supplied. This does not change the pause switch.'
