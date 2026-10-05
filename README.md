<div align="center">

# codex session continuity

**A little handoff helper for long-running Codex work on Windows.**

Keep the history. Write the handoff. Continue in the same project.

<p><kbd>Windows</kbd> · <kbd>Node.js 24+</kbd> · <kbd>PowerShell 7+</kbd> · <kbd>Experimental preview</kbd></p>

[Download](https://github.com/maiijhcg/codex-session-continuity/releases) · [Windows guide](docs/WINDOWS.md) · [What it does](#what-it-does) · [Privacy](SECURITY.md)

**English** · [繁體中文](docs/README.zh-Hant.md) · [简体中文](docs/README.zh-Hans.md) · [日本語](docs/README.ja.md) · [Español](docs/README.es.md) · [Français](docs/README.fr.md) · [한국어](docs/README.ko.md) · [Русский](docs/README.ru.md) · [Deutsch](docs/README.de.md)

![A small robot carries handoff notes from a full conversation to a fresh task, while an archive stays behind.](docs/images/hero.png)

</div>

> [!IMPORTANT]
> This is an independent, experimental Windows utility, not an official OpenAI product.
> It relies on the desktop app's local interfaces, which can change after an update.
> New installations start **paused**. Review your model's effective context window and the thresholds before enabling automation.

## What it does

Long tasks accumulate decisions, constraints, files, and unfinished actions. Session
Continuity keeps an append-only local trail and asks the original assistant to write
a handoff before continuing in a fresh task.

![Four illustrated capabilities and the six manual menu choices.](docs/images/overview.png)

| You want to… | The utility helps by… |
| --- | --- |
| Keep the trail | Archiving locally saved conversation records and indexing them for search. |
| Keep important context | Requesting `HANDOFF.md` with decisions, real progress, restrictions, verification, and next steps. |
| Continue without changing projects | Verifying the saved project, working directory, and permissions; retaining the existing checkout and uncommitted files. |
| Keep attachments usable | Saving supported, explicitly referenced local/embedded attachments and linking their provenance. Interpretation remains a separate step. |
| Stay in control | Offering pause/resume, status, and one manual handoff for a task you explicitly select. |

**It does not enlarge a model's context window, reload the entire transcript into the
new prompt, guarantee perfect recall, or silently repeat an uncertain external action.**
The artwork is conceptual; it is not a screenshot of the desktop app or a guarantee.

## How the handoff works

![Three steps: archive history, prepare a handoff notebook, continue in a fresh task.](docs/images/workflow.png)

1. **Archive.** The background process incrementally saves local records and attachment references.
2. **Prepare.** At an eligible threshold, or after your manual request, the source assistant writes a handoff and replies with a unique confirmation token.
3. **Continue.** After the source finishes and the checks pass, the controller creates one fresh task in the same project. The new assistant reads the handoff and retrieves additional evidence only as needed.

If a send/create result is uncertain, the controller preserves the state for
reconciliation. It does not blindly send it again.

## Install on Windows

### Requirements

- Windows with **Codex Desktop**, signed in, and the relevant project saved in the app.
- **Node.js 24 or later** and **PowerShell 7 or later**, available in a newly opened terminal.
- A dedicated **management task** in Codex. Copy its task UUID or `codex://threads/…` link. Keep this separate from the work you want to continue.
- Enough disk space: histories and attachment copies can grow considerably and are not automatically deleted.

### Quick start

1. Download the Windows ZIP from [Releases](https://github.com/maiijhcg/codex-session-continuity/releases), verify its SHA-256, and extract it.
2. Open PowerShell 7 in the extracted folder. Replace the placeholder below with your management task UUID:

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

3. Review the installed hook through Codex's normal trust workflow; installation never auto-trusts it. Open `Codex-Session-Continuity.cmd` from the installed folder.
4. Use **3** to check the process **and** desktop connection. Configure thresholds for your model, then use **1** to enable automation, or **4** for one explicit manual handoff.

The default install location is `%LOCALAPPDATA%\CodexSessionContinuity`.
**Windows sign-in startup is registered by default**: after a restart and sign-in,
the process runs invisibly in the background. This is per-user login startup, not a
pre-login system service. No administrator rights are required.

The background process can archive while automation is paused. Sign-in startup
does not reset your pause switch. Use `-NoStartup` to opt out, `-NoStart` to defer
starting the process, or omit `-WithIntegration` to defer the hook/guidance changes.

Read the [full Windows guide](docs/WINDOWS.md) for thresholds, upgrades, startup controls, and uninstalling without deleting history.

## Manual control, in five languages

![A user chooses pause or manual continuation while matching project folders are checked.](docs/images/control.png)

| Key | Action |
| --- | --- |
| **1** | Enable automatic continuation |
| **2** | Pause automatic continuation; keep local archival running |
| **3** | Refresh process, desktop connection, maintenance, and request status |
| **4** | Select a task for one manual continuation; paste a full task ID/link if needed |
| **5** | Choose and save the menu language |
| **0** | Close the menu; do not change the current switch |

The menu defaults to **English** and supports **繁體中文, 简体中文, 日本語, Español**.
The guides additionally support French, Korean, Russian, and German. Original task
titles, historical content, and low-level technical diagnostics retain their source
language; they are not machine-translated by the runtime.

```powershell
.\Codex-Session-Continuity.cmd -Language ja
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language es -Json
pwsh -NoProfile -File .\manual-switch.ps1 -Action Continue -ThreadId "PASTE_TASK_UUID"
```

Option 5 remembers your choice. `-Language` overrides it for the current invocation.
Tasks are ordered with active tasks first, then by recent activity. **Queued does not mean completed.**

## Handoff instructions and source permissions

Both the request sent to the old session and the instructions shown in the new
session support **English, 繁體中文, 简体中文, 日本語, Español, Français, 한국어,
Русский, Deutsch**. They default to English and follow the language saved by menu
option 5. An explicit `handoffLanguage` in the installed `config.json` overrides
the menu. Set it during a new installation with `-HandoffLanguage fr`, for example.
An existing configuration is preserved on upgrade. Stop the runtime before editing
its configuration, then restart it. Remove the override to follow the menu again.
A one-invocation menu `-Language` does not change background prompts.

The language is frozen for each handoff. Confirmation tokens, original task titles,
paths, commands, and permission values stay unchanged. Low-level diagnostics and
historical content retain their original language.

New sessions automatically inherit the **previous session's actual permissions**,
not the global default or the management task's permissions:

| Previous session | Global default | Successor expectation |
| --- | --- | --- |
| Read-only | Full access | Read-only, with the source approval policy |
| Workspace write | Read-only | The source workspace scope and restrictions |
| Full access | Workspace write | Full access, with the source approval policy |

The controller uses Codex's source-session creation flow, rechecks the source just
before dispatch, and verifies the successor's recorded sandbox, approvals,
writable scope, network limits and permission profile. It does not modify global
settings or existing sessions. A changed source is re-read before another
**unsent** attempt; an unknown/mismatched result stops for review and never causes
a duplicate task. App updates may affect this integration. A restricted source
that cannot save its handoff must resolve that limitation through the user's
normal permission workflow; the utility does not bypass it.

## Thresholds: know the difference

| Situation | Behavior |
| --- | --- |
| Usage crosses the soft threshold during uninterrupted monitoring | Request one handoff. |
| Startup/resume already finds usage above soft but below hard | Establish a baseline; do not replay a missed soft crossing. |
| Current usage reaches the hard threshold | Request a handoff when enabled and eligible. |
| Codex compacts before either threshold | Save what is locally available; do not claim that native compaction was prevented. |
| Manual request while automatic mode is paused | Process only the explicitly selected request, without changing the switch. |

Example defaults are **500,000 / 920,000** tokens. These are **not suitable for every
model**. The utility uses the product's reported current-context usage, not lifetime
billed tokens. Native compaction may use a different count or a smaller effective
window. Installation does not modify Codex's model or compaction settings.

## Privacy and safety

- Data stays in the installed runtime folder; there is no additional telemetry or independent cloud-upload client. Normal Codex task/messages still use your existing service/account.
- Do **not** publish the runtime folder. It can contain private conversations, tool results, source code, and attachments.
- Unknown outcomes, ambiguous endpoints, missing project mappings, and permission mismatches stop progress for review.
- Subagents are excluded. A worktree/subdirectory with no exact saved-project mapping is not silently moved elsewhere.
- Pausing does not cancel already dispatched work. Stopping the background process also stops archival until restarted.

See [SECURITY.md](SECURITY.md) before sharing a bug report.

## Troubleshooting and development

[Windows troubleshooting](docs/WINDOWS.md#troubleshooting) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Illustration prompts](docs/IMAGE-PROMPTS.md)

```powershell
npm test
npm run check
npm run package
```

Tests use isolated fixture data. They must not send messages to real tasks, create
live test tasks, edit the user's app database, or touch the user's Startup folder.

## Credits and licensing

README information hierarchy was inspired by [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev).
No code, logos, screenshots, or license text from that project were copied.
The four original illustrations were created with ImageGen; captions and accessible
text explain the actual behavior separately.

**A license has not yet been selected.** See [NOTICE.md](NOTICE.md). This preview is
not presented as MIT- or GPL-licensed software.
