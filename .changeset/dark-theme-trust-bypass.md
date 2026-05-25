---
'@namzu/cli': minor
---

**Dark theme, trust-folder gate, bypass-permissions mode, Claude-Code-style tool rendering, and a big token-cost fix.**

- **Fully dark theme.** The TUI now uses a curated dark hex palette on a black canvas (the root fills with the background and the screen is cleared on launch) for a cohesive, immersed look.
- **Trust folder gate.** On first launch in a directory, namzu shows the working directory and asks you to trust it before reading/running/editing files there (Claude-Code style). Trusted folders are remembered in `~/.namzu/trust.json`; trusting a repo root covers its subfolders. Declining exits.
- **Bypass permissions.** `namzu --dangerously-skip-permissions` (alias `--yolo`) runs tools without the approval prompt; a red banner warns while it's active.
- **Claude-Code-style tool rendering.** Tool calls render as `⏺ Bash(ls -la)` with a dim `⎿ result` line hugging the call, grouped with one blank line between call+result units.
- **Token-cost fix.** clawtool's ~70-tool catalog no longer inflates the prompt (it could push a single message past 200k tokens). It's registered as deferred tools the model loads on demand via `search_tools` — see the separate changeset.
