$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
$files = @((Get-Content -LiteralPath (Join-Path $releaseRoot 'runtime-files.json') -Raw | ConvertFrom-Json)) + @((Get-Content -LiteralPath (Join-Path $releaseRoot 'publication-files.json') -Raw | ConvertFrom-Json))
$failures = @()
foreach ($name in $files | Where-Object { $_ -like '*.ps1' }) {
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $releaseRoot $name),[ref]$tokens,[ref]$parseErrors)
    foreach ($parseError in $parseErrors) { $failures += ($name + ': ' + $parseError.Message) }
}
if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }
Write-Output 'All declared PowerShell files parse successfully.'
