---
"@namzu/sdk": minor
---

The coding-agent doctrine's multi-agent text is renamed to match the mode's new name, hypermode. New: `CODING_AGENT_HYPERMODE_DOCTRINE`, and `codingAgentDoctrineContribution({ hypermode: true })`. Deprecated, still working until the next major: `CODING_AGENT_ORCHESTRATE_DOCTRINE` (the same string) and the `orchestrate` option (either flag set to `true` appends the text). Replace both names now; no other change is needed.

The text itself now names the mode as the operator sees it: it starts `### Hypermode` and `This session has hypermode on:` instead of `### Orchestrate mode` / `This session has orchestrate mode on:`. The rest of the text is unchanged. If you compare the rendered prompt byte for byte, or cache on it, expect one change when the flag is on; with the flag off the output is byte-identical.
