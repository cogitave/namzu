---
'@namzu/cli': major
---

`web_fetch` is now available by default; the old default of `web.fetch` was `false`, which left the tool out. Each new domain is asked about once, and the answers are "Yes", "Yes, and don't ask again for <host> in this project" (saved to the project's local config) and "No". To keep the old behaviour, set `web.fetch: false` in `~/.namzu/config.yaml`. Scheduled jobs still refuse `web_fetch`, and a WebSocket monitor now follows the new default.
