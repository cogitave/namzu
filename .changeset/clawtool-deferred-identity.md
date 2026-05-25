---
'@namzu/cli': minor
---

**clawtool tools are now deferred (no token bloat), and namzu identifies as itself.**

- **Deferred clawtool tools.** Instead of loading clawtool's ~70-tool catalog as active (which re-sent every tool's JSON schema on every agent-loop iteration — a single message could exceed 200k tokens), the catalog is registered as **deferred** tools. Deferred tools cost only a name line in the prompt; the model loads the ones it needs on demand via the built-in `search_tools`. The default active set stays lean (bash/read/write/edit/glob/grep + remember + search_tools), and the connect line shows e.g. `8 tools (+72 on demand)`.
- **namzu identity.** namzu now presents as namzu — not Claude / Claude Code — even on the Anthropic OAuth path (which requires a "You are Claude Code" prefix for the token to authorize). A namzu identity is injected into the system context so "who are you?" answers "I'm namzu".
