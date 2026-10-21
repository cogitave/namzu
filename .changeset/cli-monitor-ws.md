---
'@namzu/cli': patch
---

When the model asks the monitor tool to watch a WebSocket while web access is off, the refusal now says how to turn it on: set `web.fetch: true` in your Namzu config file (`~/.namzu/config.yaml`). It cannot be switched on from the environment. Nothing to change if you already have it on.
