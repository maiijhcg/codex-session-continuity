[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) { throw 'Run install.ps1 or setup-config.mjs first.' }
$existing = @(Get-ContinuityProcesses)
if ($existing.Count -gt 0) { Write-Output 'This installation is already running.'; exit 0 }
$node = Resolve-ContinuityNode
$probe = @'
import fs from 'node:fs';
process.stdout.write(String(fs.readdirSync('\\\\.\\pipe\\').includes('codex-session-continuity-controller')));
'@
$guard = $probe | & $node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Could not check the single-controller guard.' }
if ($guard -eq 'true') { throw 'Another codex session continuity installation is running. Stop that installation before starting this one.' }
$pwsh = Resolve-ContinuityPowerShell
$supervisor = Join-Path $PSScriptRoot 'supervise.ps1'
$process = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-File',('"' + $supervisor + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Write-Output ('Supervisor started, PID ' + $process.Id + '. Check menu Status for heartbeat and desktop connectivity.')
