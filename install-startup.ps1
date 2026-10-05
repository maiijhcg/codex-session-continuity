[CmdletBinding()]
param([string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),[switch]$Remove)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
if (-not $StartupDirectory) { throw 'Could not find the current-user Startup directory.' }
$entry = Join-Path $StartupDirectory 'codex session continuity.vbs'
$marker = "' codex session continuity managed startup"
$target = Join-Path $PSScriptRoot 'supervise.ps1'
if (Test-Path -LiteralPath $entry) {
    $existing = [IO.File]::ReadAllText($entry)
    if (-not $existing.Contains($marker) -or -not $existing.Contains($target)) {
        throw 'A different startup entry already uses this name. It was left unchanged.'
    }
    $backupDir = Join-Path $PSScriptRoot 'install-backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backup = Join-Path $backupDir ('startup-' + [guid]::NewGuid().ToString() + '.vbs')
    if ($Remove) {
        Move-Item -LiteralPath $entry -Destination $backup
        Write-Output ('Startup entry disabled; recoverable backup: ' + $backup)
        return
    }
    Copy-Item -LiteralPath $entry -Destination $backup
} elseif ($Remove) { Write-Output 'No startup entry owned by this installation.'; return }
$pwsh = Resolve-ContinuityPowerShell
$command = '"' + $pwsh + '" -NoProfile -File "' + $target + '"'
$vbCommand = $command.Replace('"','""')
$content = $marker + "`r`nSet shell = CreateObject(""WScript.Shell"")`r`nshell.Run ""$vbCommand"", 0, False`r`n"
New-Item -ItemType Directory -Path $StartupDirectory -Force | Out-Null
[IO.File]::WriteAllText($entry,$content,[Text.Encoding]::Unicode)
Write-Output ('Windows sign-in startup enabled: ' + $entry)
