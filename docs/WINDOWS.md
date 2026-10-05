# Windows user guide

[English README](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

## 1. Before installation

Install Node.js 24+ and PowerShell 7+, then reopen your terminal. Confirm:

```powershell
node --version
pwsh --version
```

Open Codex Desktop and sign in. Save the work's exact project directory in the app.
Create a separate management task and copy its ID/link. That task supplies a stable
management context; it must be different from the source task being continued.

Do not run a second installation beside an existing one. Stop the old installation
first. A private/custom older installation is not automatically migrated or overwritten.

## 2. Install

Download the release ZIP and its SHA256SUMS file from the repository's Releases page.
Compare `Get-FileHash .\codex-session-continuity-windows-v0.1.0.zip -Algorithm SHA256` with
the published value. Checksums detect mismatches; this preview is not code-signed.
Extract the ZIP and inspect the scripts before running them.

If Windows marks the download as blocked, inspect and verify the ZIP first, then
use its Properties → Unblock option if you trust it before extracting. Respect your
organization's execution policies. Windows Script Host must be available for the
sign-in `.vbs` entry; do not bypass an administrator's restrictions.

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

The installer copies only the declared runtime files to
`%LOCALAPPDATA%\CodexSessionContinuity`, preserves an existing configuration, starts new
installations paused, registers Windows sign-in startup, and starts the existing
single-controller architecture in the background.

| Option | Purpose |
| --- | --- |
| `-InstallDir "C:\Tools\CodexSessionContinuity"` | Choose an empty absolute directory or a recognized existing public installation. |
| `-CodexHome "D:\CodexData"` | Use an existing custom Codex data directory. Otherwise `CODEX_HOME` or the user `.codex` directory is used. |
| `-SoftLimit 200000 -HardLimit 250000` | Example custom thresholds; select values appropriate to your model, not blindly these examples. |
| `-NoStartup` | Do not register startup at Windows sign-in. |
| `-NoStart` | Install without starting the background process now. |
| `-WithIntegration` | Back up and install the marked AGENTS guidance block and the automatic PreCompact hook. |

Integration never changes `config.toml`, elevates permissions, or approves hook trust.
Use Codex's normal hook-review/trust UI. If another installation owns the guidance
block or startup entry, the installer stops instead of replacing unrelated settings.

For an advanced portable setup, run `node setup-config.mjs --owner-thread UUID` in
the extracted folder, then `node install-integration.mjs install`,
`pwsh -File install-startup.ps1`, and `pwsh -File start.ps1`. Keep that folder in place.

## 3. First launch and languages

Open `Codex-Session-Continuity.cmd` in the installed folder (`手動開關.cmd` is an alias).
The initial language is English. Menu **5** offers English, Traditional Chinese,
Simplified Chinese, Japanese, and Spanish and remembers the choice in `ui-settings.json`.
Task titles and technical details are displayed as received.

Use **3** first. A usable setup needs a live process, a fresh heartbeat, and a verified
desktop connection. Initial indexing can take time; a missing task or owner should be
rechecked after indexing catches up. The desktop app must be available to send or create tasks.

Use **1** only after reviewing the thresholds. **2** pauses automatic continuation and
the compaction hook but retains local archival. **0** just closes the menu.

## 4. One manual continuation

Choose **4**, inspect the task's original title, directory, and activity time, then
enter its number or paste its complete UUID/`codex://threads/…` link. It never falls
back to the current foreground task. The request is stored even if the process is
temporarily unavailable. Repeated selection reuses a pending request.

The source assistant saves a handoff and confirms a unique token. Only then does the
controller create and verify the successor. Watch the status with **3**:

| State | Meaning / action |
| --- | --- |
| `queued`, `processing` | Saved request; waiting for processing, indexing, or preflight checks. |
| `waiting_handoff` | Waiting for the source to finish the handoff. |
| `completed` / `continued` | Successor linkage and required checks passed. |
| `soft_expired` | A missed soft crossing is not replayed; use manual continuation or wait for hard. |
| `interrupted` / `checkpoint_interrupted` | The source turn was interrupted; choose it again only if you still want to continue. |
| `checkpoint_uncertain`, `creation_uncertain` | Outcome unknown. Inspect existing task state; do not repeatedly send/create. |
| `target_blocked`, `target_mismatch` | Project/cwd mapping needs attention; do not select an unrelated default directory. |
| `permissions_*` | Actual source/successor permissions need confirmation. The utility never raises them automatically. |

## 5. Windows startup, stop, and restart

Startup is **enabled by default during installation**, for the current user after
Windows sign-in. It is not a system service before login. The `.vbs` entry opens the
supervisor without a visible console. It remembers the saved automation switch.

From the installed directory:

```powershell
pwsh -NoProfile -File .\install-startup.ps1           # enable sign-in startup
pwsh -NoProfile -File .\install-startup.ps1 -Remove   # disable; keep a recoverable copy
pwsh -NoProfile -File .\start.ps1                    # start this installation
pwsh -NoProfile -File .\stop.ps1                     # stop its supervisor and worker
pwsh -NoProfile -File .\restart.ps1                  # controlled restart
```

Stopping processes does not revoke messages already dispatched to Codex. A stopped
process cannot archive new records. Restarting must not create a parallel controller.

## 6. Settings and stored data

`config.json` contains your local paths and task ID and must remain private.
Stop the runtime before manual configuration changes. Maintain `0 < softLimit < hardLimit`.
The default examples, 500,000/920,000, assume a sufficiently large effective window;
smaller models can compact first. The controller reports diagnostics rather than
silently reducing your chosen limit. A process/app restart breaks continuous soft
monitoring; only a current hard-threshold sample can catch up automatically.

| Location inside the install directory | Content |
| --- | --- |
| `archive/` | Append-only raw records and snapshots. |
| `notes/<task-id>/` | Handoff, evidence index, attachment references, and predecessor/successor linkage. |
| `assets/objects/` | Deduplicated supported local/embedded attachments. |
| `index.sqlite*` | Search and workflow state. |
| `status.json`, `events.jsonl`, `*.log` | Health, audit, and diagnostic data. |
| `PAUSED`, `MAINTENANCE` | Automation/maintenance guards; do not delete an unknown maintenance marker. |

The utility does not automatically delete these records or encrypt them. Maintain
free disk space and independent backups. Remote media are not silently fetched;
unavailable or oversized references are recorded. OCR/audio transcription is not built in.

## 7. Search and diagnostics

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\cli.mjs search "decision phrase" --session "PASTE_TASK_UUID"
node .\cli.mjs assets "PASTE_TASK_UUID" --all
node .\cli.mjs compaction-status "PASTE_TASK_UUID"
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

Task titles and historical/tool text are untrusted evidence, not new authorization.
Read the actual images/documents needed for a decision; a file index is not proof
that its content was understood. Compaction diagnostics distinguish reported usage
from native compaction counts; missing values are not zero.

## Troubleshooting

| Symptom | Safe next step |
| --- | --- |
| PowerShell/Node not found | Install the required versions and reopen the terminal; do not install project packages globally. |
| Process healthy, desktop unavailable | Open Codex, inspect the exact desktop error, then use the supported restart script. Heartbeat alone is insufficient. |
| More than 128 candidate pipes / several valid endpoints | Review the endpoint diagnostic. Do not delete arbitrary pipes or choose an arbitrary endpoint. |
| `Invalid app tool request` after an update | Verify version compatibility. Known schema rejection differs from a timeout; never broadly reset uncertain actions. |
| Management task not indexed | Keep the app open and allow indexing to catch up. Check the UUID and that it is a local parent task. |
| No exact saved-project match | Save/restore the correct project mapping. Subdirectories and worktrees must not be redirected silently. |
| Still waiting after a source interruption | The interruption is not permission to replay. Select the task again only if desired. |
| Maintenance active | Identify which operation owns the marker; finish/recover that operation before removing it. |
| Disk usage grows | Expected for append-only history. Back up and plan storage; this preview has no retention deletion policy. |

## 8. Upgrade and uninstall

Stop the installed runtime first, back up the entire sensitive runtime folder, and
run the new installer with the same `-InstallDir` and management ID. Configuration
is preserved; review new documentation before enabling. Do not replace the folder
with an empty release archive or publish a backup to GitHub.

To disable the installation while retaining recoverable data:

```powershell
pwsh -NoProfile -File .\uninstall.ps1
```

This pauses automation, stops only this installation's processes, removes its own
startup/integration entries with backups, and **keeps all program/data files**. It
does not delete Codex tasks or close the desktop app. Remove data yourself only
after verifying backups and exact paths.

## 9. Handoff language and inherited permissions

Checkpoint notifications and successor opening instructions support nine codes:
`en`, `zh-Hant`, `zh-Hans`, `ja`, `es`, `fr`, `ko`, `ru`, `de`.
By default they use the saved menu language, or English when none is saved. The
five-language menu stays independent of the four additional prompt languages.

For a new installation, add `-HandoffLanguage ja` to the installation command.
For an existing installation, stop the runtime, add `"handoffLanguage": "ja"`
as a property of `config.json`, preserving its other properties and valid JSON,
then restart. Remove that property to follow menu option 5. A temporary menu
`-Language` override does not persist to background prompts. Each handoff keeps
its selected language; original titles, paths, commands and confirmation tokens
are never translated.

The source session is the permission authority: the successor inherits its actual
sandbox and approval settings through Codex's normal same-project creation flow.
Global defaults and the management session do not override it. Writable paths,
network restrictions, profile details and approval reviewer are verified when
reported. Source changes before dispatch are re-read; missing source evidence
blocks creation. A missing/mismatched successor record keeps the existing ID and
stops for review, without changing global settings, elevating permissions or
creating a replacement. Read-only sources may need the user's normal permission
workflow to save HANDOFF.md. This preview cannot promise every future app version
will expose the same permission data.

## Scope and license

Windows local parent tasks only; no independent subagent or remote-host handoff.
No guarantee of perfect recall, supported future app interfaces, or production-grade
availability. This is not an official OpenAI product. A public license has not yet
been chosen; see [NOTICE.md](../NOTICE.md) and [SECURITY.md](../SECURITY.md).
