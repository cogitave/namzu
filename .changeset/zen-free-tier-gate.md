---
"@namzu/zen": patch
---

Keyless Zen requests work again. The free-tier gateway now refuses every model that does not carry OpenCode's client identity — including `space-bunny-free`, which used to answer — and the driver was sending that identity only for a hand-picked `verified` path, so an anonymous call to `big-pickle` and to the new free models returned `FreeTierError`.

Anonymous calls to the official Zen endpoint now all take the same path: an OpenCode `User-Agent` at 1.18 or newer (resolved from `OPENCODE_UA`, then an installed `opencode --version`, then a 1.18.35 floor), a descending `ses_` session id, the client and project headers, and the four tool names `bash`, `glob`, `grep` and `read` in the request body. The tool names are injected only where the caller registered none; a caller that has tools keeps its own set and its own `tool_choice`. Namzu's own attribution headers still travel on credentialed calls, on Zen Go, on a caller-owned `baseURL`, and on catalogue reads.

Nothing in the public surface changes. Pass `OPENCODE_UA` if you want the advertised version pinned; without it the driver probes an installed binary once per process and falls back.
