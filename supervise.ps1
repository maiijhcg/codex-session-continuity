$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$continuityMutex = [System.Threading.Mutex]::new($false, 'Local\CodexSessionContinuitySupervisor')
$owned = $false
try {
    try { $owned = $continuityMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    $node = Resolve-ContinuityNode
    while ($true) {
        & $node (Join-Path $PSScriptRoot 'controller.mjs') daemon 1>> (Join-Path $PSScriptRoot 'daemon.stdout.log') 2>> (Join-Path $PSScriptRoot 'daemon.stderr.log')
        Start-Sleep -Seconds 10
    }
} finally {
    if ($owned) { $continuityMutex.ReleaseMutex() }
    $continuityMutex.Dispose()
}
