[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$processes = @(Get-ContinuityProcesses)
foreach ($process in ($processes | Sort-Object @{Expression={if ($_.Name -eq 'pwsh.exe') {0} else {1}}})) {
    if ($PSCmdlet.ShouldProcess(('PID ' + $process.ProcessId + ' at ' + $PSScriptRoot),'Stop codex session continuity process')) {
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
}
Write-Output 'Stop complete. Conversation archives, settings, and pause state were not deleted.'
