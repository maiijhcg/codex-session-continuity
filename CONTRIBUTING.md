# Contributing

Use Node.js 24+ and PowerShell 7+ on Windows. There are no third-party runtime npm
dependencies. Run `npm test`, `npm run check`, and `npm run package` before proposing
a change. Tests must use temporary fixture roots, fake bridges, and synthetic task
IDs. Never use an active user's session as a test target.

Preserve these invariants:

1. Only explicitly eligible local parent tasks are continued; subagents are excluded.
2. Keep the exact saved project, cwd, existing checkout, and permissions.
3. An uncertain send/create is reconciled, never blindly repeated.
4. Soft thresholds require a continuously observed crossing; hard thresholds use current usage.
5. Raw history is append-only. Media bytes, provenance, and interpretation are distinct.
6. No mutation is a health probe; use a read-only capability check.
7. All five menu locales have the same keys and formatting placeholders.
8. Release files come only from the explicit publication manifest, never a runtime directory scan.

Include the app version, platform, minimal synthetic reproduction, and sanitized
diagnostic codes in an issue. Do not attach your runtime folder or original
conversations. See [SECURITY.md](SECURITY.md).

README hierarchy is inspired by Clash Verge Rev; keep the artwork and prose original.
No open-source license has yet been selected; discuss contribution/reuse terms with
the repository owner before submitting substantial contributions.
