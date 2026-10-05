# Security and privacy

codex session continuity stores conversation history, tool output, local file references,
attachments, and handoff notes on your computer. Treat the entire installed runtime
folder as sensitive. It can include source code, credentials that appeared in an
original conversation, personal information, or confidential business data.

- Never upload `config.json`, SQLite databases, `archive/`, runtime `assets/`,
  `notes/`, logs, state files, or backups to a public issue or repository.
- There is no added telemetry or separate cloud upload client in this utility.
  Normal Codex task creation and messages still use your existing Codex account
  and may be processed by the service according to your account settings.
- Attachments are copied only from explicit references. Remote assets are not
  silently downloaded. Saving bytes does not perform OCR or interpret media.
- History and artifacts are not automatically deleted. Monitor disk usage and
  maintain an independent backup. Local copies are not encrypted by this utility.
- The app-tools pipe is a local interoperability interface, not a stable public
  API. Keep the desktop app and this utility compatible. Never weaken identity,
  project, permission, or ambiguous-outcome checks to make a blocked task proceed.
- Installation does not edit `config.toml`, elevate privileges, or auto-trust hooks.
  Review hooks through Codex's normal trust workflow.
- Do not run multiple installations. The single-controller guard is intentional.

For a vulnerability, contact the repository owner without publishing private logs
or exploit payloads. Until a private reporting channel is configured, open an issue
asking for one and include no sensitive details. This preview has no formal support
or security-response SLA.
