---
"@namzu/zen": minor
"@namzu/cli": minor
---

Enable Zen's current public models without requiring an account key or an
OpenCode installation. Anonymous SDK calls and the CLI's Zen default use
`muse-spark-1.3-contributor-free`. Omitted, blank or `public` Zen keys select
anonymous access, restricted to six explicitly supported free model IDs;
paid or unknown models still require a real key. The SDK keeps
`glm-5.3-flash` as the default for credentialed Zen and Go calls, and Go
continues to require its own API key.

The CLI uses environment keys first, then reuses separate `opencode` and
`opencode-go` API-key entries from `OPENCODE_AUTH_CONTENT` or OpenCode's
data-directory `auth.json`, including the paired Windows home on WSL when
no absolute XDG override is supplied.
It leaves that file unchanged and does not reinterpret OAuth records as
API keys. Explicit `OPENCODE_API_KEY=public` selects anonymous access and
suppresses secondary Zen key aliases and stored account keys. With no
credential, Zen appears as public access without a login
or key prompt. Public model availability and service limits remain under
the upstream service's control.

Expose `@namzu/zen/models` for catalogue functions and model types without
loading the four native transport adapters during provider selection.

Send `strict: false` for all Responses function tools so optional parameters,
including nested read/edit fields, remain optional. This fixes HTTP 400
schema rejection when a backend defaults omitted strictness to true.
Responses also declines the capability-dependent `enforceToolInputSchema`
hint for these general schemas; Namzu continues to validate inputs before
tool execution. Other protocols retain their existing enforcement behavior.
