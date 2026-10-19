---
"@namzu/cli": minor
---

A new `statusLine` config key runs your command and draws its output, dimmed, above the interactive footer. Set `statusLine: { command, padding?, refreshInterval? }` in `~/.namzu/config.yaml` or a trusted project's `namzu.config.json`; the command receives the session as JSON on stdin (model, workspace, cost, context window, effort, pull request, and more, under the reference terminal's field names) and re-runs 300 ms after the session changes. A failed or empty run shows nothing. Nothing changes for anyone who does not set the key, except that the type `StatusLineConfig` is exported.
