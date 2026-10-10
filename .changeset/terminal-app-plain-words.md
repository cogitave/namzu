---
"@namzu/cli": minor
---

The terminal app now reports problems in plain words. A failed or paused reply is one sentence that names the provider (for example "OpenAI did not accept your API key. Check it in /setup, or pick another provider with /model."), with no bracketed error ids, checkpoint ids, raw JSON or config-key names; a paused reply continues with Enter. The exit hint prints `namzu resume <id>` instead of the node path, and an unexpected crash prints one line and saves the stack to `~/.namzu/logs/crash-<time>.log`. If you scraped the old terminal text (`[provider.auth]`, `Checkpoint preserved:`, `Fatal:`), read the structured output of `namzu exec --json` instead, which is unchanged; set `NAMZU_DEBUG=1` or pass the new global `--debug` flag to see the technical detail on screen.
