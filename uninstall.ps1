[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$node = Resolve-ContinuityNode
& $node (Join-Path $PSScriptRoot 'cli.mjs') pause
if ($LASTEXITCODE -ne 0) { throw 'Could not pause; inspect the installation before uninstalling.' }
& (Join-Path $PSScriptRoot 'stop.ps1')
& (Join-Path $PSScriptRoot 'install-startup.ps1') -Remove
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json')) {
    & $node (Join-Path $PSScriptRoot 'install-integration.mjs') remove
    if ($LASTEXITCODE -ne 0) { throw 'Integration removal needs review. Files and archives are preserved.' }
}
Write-Output 'Background/startup integration disabled. Program files, configuration, history, notes, and attachments are preserved for recovery.'
