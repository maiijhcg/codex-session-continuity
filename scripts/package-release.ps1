[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $PSScriptRoot 'check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release audit failed; no package was created.' }
$filesJson = & node (Join-Path $PSScriptRoot 'check-release.mjs') --list
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve publication allowlist.' }
$files = $filesJson | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $releaseRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$') { throw 'Unsafe version string.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $releaseRoot 'dist' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$name = 'codex-session-continuity-windows-v' + $package.version
$stage = Join-Path $destination $name
$zipPath = Join-Path $destination ($name + '.zip')
$sumsPath = Join-Path $destination 'SHA256SUMS'
foreach ($target in @($stage,$zipPath,$sumsPath)) {
    if (Test-Path -LiteralPath $target) { throw ('Refusing to replace an existing package output: ' + $target + '. Choose a new -OutputDirectory.') }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($file in $files) {
    $target = Join-Path $stage $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $releaseRoot $file) -Destination $target
}
$stream = [IO.File]::Open($zipPath,[IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false,[Text.Encoding]::UTF8)
try {
    foreach ($file in $files) {
        $entry = $zip.CreateEntry(($name + '/' + $file),[IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2026,10,5,0,0,0,[TimeSpan]::Zero)
        $inputStream = [IO.File]::OpenRead((Join-Path $stage $file))
        $outputStream = $entry.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
    }
} finally { $zip.Dispose(); $stream.Dispose() }
# Verify every ZIP entry byte-for-byte, not a sample.
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    if ($archive.Entries.Count -ne $files.Count) { throw 'ZIP entry count mismatch.' }
    foreach ($entry in $archive.Entries) {
        $relative = $entry.FullName.Substring($name.Length + 1)
        if ($relative -notin $files) { throw 'Unexpected ZIP entry.' }
        $sourceHash = (Get-FileHash -LiteralPath (Join-Path $stage $relative) -Algorithm SHA256).Hash
        $entryStream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-','') }
        finally { $sha.Dispose(); $entryStream.Dispose() }
        if ($sourceHash -ne $entryHash) { throw ('ZIP verification failed: ' + $relative) }
    }
} finally { $archive.Dispose() }
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($sumsPath,($hash + '  ' + [IO.Path]::GetFileName($zipPath) + [char]10),[Text.UTF8Encoding]::new($false))
Write-Output ('Verified files: ' + $files.Count)
Write-Output ('Publication staging: ' + $stage)
Write-Output ('ZIP: ' + $zipPath)
Write-Output ('SHA256: ' + $hash)
