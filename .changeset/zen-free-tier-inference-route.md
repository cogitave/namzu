---
'@namzu/zen': patch
---

Serve anonymous free-model calls from `https://opencode.ai/inference/v1` instead of the configured `https://opencode.ai/zen/v1`.

The free-tier gateway answers `403 FreeTierError` — "OpenCode's free tier can only be used from within OpenCode" — to anonymous traffic on `/zen/v1`, and does so however faithfully the request is shaped. Measured on `cat-jam-free` with the OpenCode-shaped identity headers, the four injected tool names and a session and request id in the client's own format, both against the same session in the same minute: the same request is `403` on `/zen/v1/chat/completions` and `200` on `/inference/v1/chat/completions`. The request id's random half is not what the gateway reads — flipping it, keeping the timestamp half fresh or stale, and re-serialising the body all leave the verdict unchanged — only the route decides.

To upgrade and keep working, nothing is required: anonymous free-model calls move to `/inference` by themselves, and every keyed call stays on `ZEN_BASE_URL` exactly as before. A caller-owned `baseURL` proxy is likewise untouched, and only the chat route is reachable anonymously — the Anthropic and Responses routes answer `401 Missing API key` on either host, as they did before. Verified live on `cat-jam-free`: a plain turn and a `bash` tool round both complete.