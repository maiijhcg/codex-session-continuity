[CmdletBinding()]
param(
    [ValidateSet('Menu','On','Off','Status','Continue')][string]$Action = 'Menu',
    [string]$ThreadId,
    [Alias('Lang')][ValidateSet('en','zh-Hant','zh-Hans','ja','es')][string]$Language,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$script:languageCodes = @('en','zh-Hant','zh-Hans','ja','es')
$script:languageFile = Join-Path $PSScriptRoot 'ui-settings.json'
$script:languageCode = 'en'
if ($Language) { $script:languageCode = $Language }
elseif (Test-Path -LiteralPath $script:languageFile) {
    try {
        $saved = Get-Content -LiteralPath $script:languageFile -Raw -Encoding utf8 | ConvertFrom-Json
        if ($saved.language -in $script:languageCodes) { $script:languageCode = $saved.language }
    } catch { }
}
function Set-MenuLanguage {
    param([string]$Code)
    $script:strings = Get-Content -LiteralPath (Join-Path $PSScriptRoot "locales/$Code.json") -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    $script:languageCode = $Code
}
function T {
    param([string]$Key,[object[]]$Values = @())
    $text = $script:strings[$Key]
    if ($null -eq $text) { throw "Missing translation: $Key" }
    if ($Values.Count -gt 0) { return ($text -f $Values) }
    return $text
}
function Get-Value {
    param($Value,[string]$Name,$Default = $null)
    if ($null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]) { return $Value.$Name }
    return $Default
}
function Invoke-ContinuityCommand {
    param([ValidateSet('status','pause','resume','tasks','continue-once')][string]$Command,[string[]]$Arguments = @())
    $result = & $script:node $script:cli $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw (T 'operationFailed' @($Command,$LASTEXITCODE)) }
    return ($result -join "`n")
}
function Get-State { return (Invoke-ContinuityCommand status | ConvertFrom-Json) }
function Show-State {
    param($State)
    Write-Host ''
    Write-Host (T 'title') -ForegroundColor Cyan
    Write-Host (T 'folder' @($PSScriptRoot))
    if ((Get-Value $State 'configured' $true) -eq $false) { Write-Host (T 'setupNeeded') -ForegroundColor Yellow }
    $limits = Get-Value $State 'triggers'
    if ($limits) { Write-Host (T 'limits' @($limits.softLimit,$limits.hardLimit)) }
    if (Get-Value $State 'configured' $true) {
        if (Get-Value $State 'paused' $false) { Write-Host (T 'paused') -ForegroundColor Yellow }
        else { Write-Host (T 'enabled') -ForegroundColor Green }
    }
    if ((Get-Value $State 'processAlive' $false) -and (Get-Value $State 'heartbeatFresh' $false)) {
        Write-Host (T 'healthy' @((Get-Value $State 'pid')))
    } else { Write-Host (T 'unhealthy') -ForegroundColor Yellow }
    $desktop = Get-Value $State 'desktop'
    $available = Get-Value $desktop 'available'
    if ($available -eq $true) { Write-Host (T 'desktopOk') -ForegroundColor Green }
    elseif ($available -eq $false) {
        Write-Host (T 'desktopOffline') -ForegroundColor Yellow
        Write-Host (T 'diagnostic' @((Get-Value $desktop 'error' (T 'unknown'))))
    } else { Write-Host (T 'desktopUnknown') -ForegroundColor Yellow }
    if (Get-Value $State 'maintenance' $false) { Write-Host (T 'maintenance') -ForegroundColor Yellow }
    Write-Host (T 'pauseHint')
    Write-Host (T 'manualHint')
    Write-Host (T 'sentHint')
    $requests = @((Get-Value $State 'manualRequests' @()))
    if ($requests.Count) {
        Write-Host "`n$(T 'requests')"
        foreach ($request in ($requests | Select-Object -First 10)) {
            Write-Host ('  {0}  {1}' -f (Get-Value $request 'threadId'),(Get-Value $request 'phase'))
            Write-Host ('    ' + (T 'requestId' @((Get-Value $request 'requestId'))))
            if (Get-Value $request 'newId') { Write-Host ('    ' + (T 'newId' @($request.newId))) }
            if (Get-Value $request 'error') { Write-Host ('    ' + (T 'diagnostic' @($request.error))) -ForegroundColor Yellow }
        }
    }
    $handoffs = @((Get-Value $State 'handoffs' @()))
    if ($handoffs.Count) {
        Write-Host "`n$(T 'handoffs')"
        foreach ($handoff in ($handoffs | Select-Object -Last 10)) {
            Write-Host ('  {0}  {1}' -f (Get-Value $handoff 'old_id'),(Get-Value $handoff 'phase'))
            if (Get-Value $handoff 'error') { Write-Host ('    ' + (T 'diagnostic' @($handoff.error))) -ForegroundColor Yellow }
        }
    }
}
function Format-Usage {
    param($Usage)
    if ($null -eq $Usage) { return (T 'notReported') }
    if ($Usage -is [ValueType]) { return (T 'tokens' @($Usage)) }
    foreach ($key in @('totalTokens','total_tokens','contextTokens','usage')) {
        $value = Get-Value $Usage $key
        if ($null -ne $value) { return (T 'tokens' @($value)) }
    }
    return (T 'notReported')
}
function Request-Once {
    param([string]$Id)
    if ($Id -notmatch '^(?:codex://threads/)?([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$') { throw (T 'explicitId') }
    return (Invoke-ContinuityCommand 'continue-once' @($Matches[1].ToLowerInvariant()) | ConvertFrom-Json)
}
function Show-Request {
    param($Result)
    $phase = Get-Value $Result 'phase' 'unknown'
    Write-Host ''
    if ($phase -eq 'queued') { Write-Host (T 'queued') -ForegroundColor Cyan }
    else { Write-Host (T 'requestPhase' @($phase)) -ForegroundColor Cyan }
    Write-Host (T 'threadId' @((Get-Value $Result 'threadId' (T 'notReported'))))
    Write-Host (T 'requestId' @((Get-Value $Result 'requestId' (T 'notReported'))))
    if ((Get-Value $Result 'daemonAvailable' $false) -ne $true) { Write-Host (T 'offlineQueue') -ForegroundColor Yellow }
    Write-Host (T 'progressHint')
}
function Select-Task {
    $listing = Invoke-ContinuityCommand tasks | ConvertFrom-Json
    $tasks = @((Get-Value $listing 'tasks' @()))
    if (-not $tasks.Count) { Write-Host (T 'noTasks') -ForegroundColor Yellow; return }
    Write-Host "`n$(T 'selectTitle')" -ForegroundColor Cyan
    Write-Host (T 'selectHint')
    Write-Host (T 'manualHint')
    Write-Host (T 'sort')
    for ($index = 0; $index -lt $tasks.Count; $index++) {
        $task = $tasks[$index]
        $activity = Get-Value $task 'active'
        $activityLabel = if ($activity -eq $true) { T 'active' } elseif ($activity -eq $false) { T 'idle' } else { T 'unknown' }
        Write-Host ('  {0}  {1}' -f ($index + 1),(Get-Value $task 'title' (T 'untitled')))
        Write-Host ('     ' + (T 'threadId' @((Get-Value $task 'id'))))
        Write-Host ('     ' + (T 'directory' @((Get-Value $task 'cwd' (T 'notReported')))))
        Write-Host ('     ' + (T 'taskUsage' @((Format-Usage (Get-Value $task 'usage')),$activityLabel)))
        $lastActivity = Get-Value $task 'lastActivityAt'
        if ($lastActivity) { Write-Host ('     ' + (T 'lastActivity' @(([DateTimeOffset]$lastActivity).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz')))) }
        if (Get-Value $task 'handoffPhase') { Write-Host ('     ' + (T 'handoffPhase' @($task.handoffPhase))) }
        if (Get-Value $task 'diagnostic') { Write-Host ('     ' + (T 'diagnostic' @($task.diagnostic))) }
        if ((Get-Value $task 'eligible' $false) -ne $true) {
            Write-Host ('     ' + (T 'notEligible' @((Get-Value $task 'eligibilityReason' (T 'unknown'))))) -ForegroundColor Yellow
        }
    }
    Write-Host "`n  $(T 'back')"
    while ($true) {
        $selection = (Read-Host (T 'selectPrompt')).Trim()
        if ($selection -eq '0') { return }
        if ($selection -match '^(?:codex://threads/)?[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { Show-Request (Request-Once $selection); return }
        $number = 0
        if (-not [int]::TryParse($selection,[ref]$number) -or $number -lt 1 -or $number -gt $tasks.Count) { Write-Host (T 'invalidChoice') -ForegroundColor Yellow; continue }
        $chosen = $tasks[$number - 1]
        if ((Get-Value $chosen 'eligible' $false) -ne $true) { Write-Host (T 'blocked') -ForegroundColor Yellow; continue }
        Show-Request (Request-Once (Get-Value $chosen 'id')); return
    }
}
function Set-Switch {
    param([ValidateSet('On','Off')][string]$Value)
    $before = Get-State
    if ((Get-Value $before 'configured' $true) -eq $false) { throw (T 'setupNeeded') }
    if ($Value -eq 'Off' -and -not $before.paused) { $null = Invoke-ContinuityCommand pause }
    elseif ($Value -eq 'On' -and $before.paused) { $null = Invoke-ContinuityCommand resume }
    $after = Get-State
    if ([bool]$after.paused -ne ($Value -eq 'Off')) { throw (T 'changed') }
    return $after
}
function Select-Language {
    Write-Host "`n  1 English`n  2 繁體中文`n  3 简体中文`n  4 日本語`n  5 Español`n  0 Back"
    $selection = (Read-Host (T 'languagePrompt')).Trim()
    if ($selection -eq '0') { return }
    if ($selection -notmatch '^[1-5]$') { Write-Host (T 'invalidChoice'); return }
    Set-MenuLanguage $script:languageCodes[[int]$selection - 1]
    $temporary = $script:languageFile + '.tmp-' + [guid]::NewGuid().ToString()
    @{language=$script:languageCode} | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $script:languageFile -Force
    Write-Host (T 'languageSaved') -ForegroundColor Green
}
try {
    Set-MenuLanguage $script:languageCode
    if ($Action -eq 'Continue' -and [string]::IsNullOrWhiteSpace($ThreadId)) { throw (T 'continueNeedsId') }
    if ($Action -ne 'Continue' -and $ThreadId) { throw (T 'idOnlyContinue') }
    $script:cli = Join-Path $PSScriptRoot 'cli.mjs'
    if (-not (Test-Path -LiteralPath $script:cli)) { throw (T 'cliMissing') }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) { throw (T 'nodeMissing') }
    $script:node = $nodeCommand.Source
    if ($Action -eq 'Continue') {
        $result = Request-Once $ThreadId.Trim()
        if ($Json) { $result | ConvertTo-Json -Depth 12 } else { Show-Request $result }
        exit 0
    }
    if ($Action -ne 'Menu') {
        $state = if ($Action -eq 'Status') { Get-State } else { Set-Switch $Action }
        if ($Json) { $state | ConvertTo-Json -Depth 12 } else { Show-State $state }
        exit 0
    }
    if ($Json) { throw (T 'jsonAction') }
    while ($true) {
        Show-State (Get-State)
        Write-Host ''
        foreach ($key in @('on','off','refresh','continue','language','exit')) { Write-Host ('  ' + (T $key)) }
        switch ((Read-Host (T 'menuPrompt')).Trim()) {
            '1' { $null = Set-Switch On }
            '2' { $null = Set-Switch Off }
            '3' { }
            '4' { Select-Task }
            '5' { Select-Language }
            '0' { exit 0 }
            default { Write-Host (T 'invalidMenu') -ForegroundColor Yellow }
        }
    }
} catch {
    if ($Json) { [Console]::Error.WriteLine($_.Exception.Message) }
    else { Write-Host (T 'error' @($_.Exception.Message)) -ForegroundColor Red }
    exit 1
}
