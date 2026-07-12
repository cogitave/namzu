---
"@namzu/sdk": minor
---

Injection hygiene (ses_016).

Model-facing frames are now authenticated rather than escaped. Sub-agent results and advisory blocks are wrapped in `<task-notification-{nonce}>` / `<advisory-result-{nonce}>` tags carrying a per-run nonce, and the system prompt states that only nonce-bearing tags are framework-authored. A sub-agent or advisor that emits a closing tag can no longer forge a frame — and because the boundary is now the thing an attacker cannot reproduce, the payload inside a frame stays VERBATIM, so code and paths reach the model byte-exact. Tool names and descriptions in the prompt catalogue are still escaped: they are metadata, not content the model has to reproduce.

Namespaced tool names are provider-valid and injective by construction. The plugin namespace separator is `__`, and components are validated so none may contain it (`read_file` stays legal). Names the plugin author controls — the plugin name, its own tools, its MCP server aliases — are validated strictly, because their author can fix them. Names supplied by a third party — an MCP server's own tool names, connector methods — are canonicalized onto `[a-zA-Z0-9_-]{1,64}` instead, deterministically and stably across restarts; the server is still invoked under its original name. A single nonconforming remote tool (`notion.search`, `db:query`) is repaired, or at worst skipped with a `plugin_tool_skipped` event, and never fails the whole plugin enable.

Veto probes fail closed: a throwing handler — or a throwing `where` filter — denies. Plugin hooks gain an `onError: 'continue'` policy whose errors stay visible on `plugin_hook_completed`. Plugin MCP `env` values support `${VAR}` / `${env:VAR}` interpolation with a `$${VAR}` literal escape, failing enable loudly on a missing variable; `EnvInterpolationError` never embeds the offending value, because MCP `env` is exactly where credentials live.

Three behavior changes a consumer can notice:

- **A veto handler that throws now DENIES.** Previously the throw was logged and the operation proceeded. A handler whose body or `where` filter crashes on an unexpected event shape will start denying tool calls. Opt out per handler with `probe.veto(kind, handler, { onError: 'allow' })`.
- **The plugin namespace separator is `__`, with NO legacy resolution of the old `:` form.** A `:` name is simply unknown. Resolving it was a privilege-escalation hole: the probe vetoes, the plugin `pre_tool_use` hooks and the verification gate all match on the raw model-supplied name, so a tool denied as `github__delete_repo` was still reachable as `github:delete_repo`. Histories and manifests that persisted `:` names must be re-created.
- **An unknown tool name returns a tool error to the model instead of throwing.** A mistyped or hallucinated name used to reject out of the executor's tool batch and abort the whole run; it now comes back as an error result the model can correct, and the other calls in the batch still execute.
