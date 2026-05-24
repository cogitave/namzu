---
'@namzu/cli': patch
---

**M0 hotfix** (`ses_002-clawtool-bridge`) — align CLI shape with the TUI-as-default product vision.

- **Removed:** `namzu chat` stub command. The `chat` subcommand was a misread of the product shape: namzu's primary user surface is a TUI (like claude-code, gemini-cli, opencode, and hermes-agent's TUI), and the TUI **is** the chat. Having a separate `chat` subcommand framed the CLI as "command-first" when it's actually "TUI-first with utility subcommands".
- **Added:** default behavior for `namzu` (no args) — prints a one-line placeholder (`namzu — TUI coming in M3. For utility subcommands run namzu --help.`) and exits 0. M3 will replace this with the actual Ink + React TUI launch.
- `namzu --help` still lists the utility surface (`doctor`, `tools`, `providers`, `skills`, `serve`).

Reference TUIs vendored at `cogitave.com/vendor/{google-gemini/gemini-cli, sst/opencode, NousResearch/hermes-agent}` guide the M3 shape: minimalist scrolling transcript + bottom composer + dialog overlays, slash-command registry, permission-with-inline-diff for tool calls.

No library API changes; the doctor command and all M0 plumbing (Commander shell, output formatters, config cascade, sysexits mapping) remain identical.
