---
"@namzu/cli": minor
---

The agent can reach the web when you say so.

A new `web` config key, file-only and off by default: `web: { fetch: true }` mounts `web_fetch` over the SDK's guarded provider (private and loopback addresses refused, redirects and body bounded) and adds the citation guidance to the prompt. Every fetch is reviewed like a shell command under `prompt` and `accept-edits`, whatever the tool declares about itself — a request leaving the machine to an address the model chose is one the operator sees first. Sub-agents do not receive the tool. There is no search backend in this kernel, so `web_search` is not offered and there is no `search` key. Without the key nothing changes: no tool, no provider, no guidance.
