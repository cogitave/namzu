---
'@namzu/cli': major
---

`web_fetch` is now available by default; the old default of `web.fetch` was `false`, which left the tool out. Each new domain is asked about once, and the answer can be allow for this session or allow always. To keep the old behaviour, set `web.fetch: false` in `~/.namzu/config.yaml`. Scheduled jobs still refuse `web_fetch`, and a WebSocket monitor now follows the new default.
