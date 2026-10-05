Set-StrictMode -Version Latest
function Resolve-ContinuityNode {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $command) { throw 'Node.js 24 or later is required. Install Node.js and reopen the terminal.' }
    $nodeVersion = & $command.Source -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 24) { throw 'Node.js 24 or later is required.' }
    return $command.Source
}
function Resolve-ContinuityPowerShell {
    if ($PSVersionTable.PSVersion.Major -ge 7) { return (Join-Path $PSHOME 'pwsh.exe') }
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw 'PowerShell 7 or later is required.' }
    return $command.Source
}
function Get-ContinuityProcesses {
    param([string]$Root = $PSScriptRoot)
    $controller = [regex]::Escape((Join-Path ([IO.Path]::GetFullPath($Root)) 'controller.mjs'))
    $supervisor = [regex]::Escape((Join-Path ([IO.Path]::GetFullPath($Root)) 'supervise.ps1'))
    $nodePattern = '^(?:"[^"]*node\.exe"|\S*node\.exe)\s+"?' + $controller + '"?\s+daemon(?:\s|$)'
    $pwshPattern = '^(?:"[^"]*pwsh\.exe"|\S*pwsh\.exe)\s+-NoProfile\s+-File\s+"?' + $supervisor + '"?\s*$'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe'" | Where-Object {
        ($_.Name -eq 'node.exe' -and $_.CommandLine -match $nodePattern) -or
        ($_.Name -eq 'pwsh.exe' -and $_.CommandLine -match $pwshPattern)
    })
}
