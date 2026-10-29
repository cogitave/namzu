---
"@namzu/cli": minor
"@namzu/sdk": minor
"@namzu/openai": patch
---

Prevent reasoning-only output cutoffs from silently ending CLI work. Empty
output-limit responses now use the CLI's existing bounded continuation policy,
and collected closing answers are visible in streaming clients.

Set `limits.maxResponseTokens` in the CLI config to increase each model call's
output allowance; omission retains 8,192 tokens. The setting reaches delegated
agents and is restored for paused turns. Compatible OpenAI endpoints can declare
their context size, maximum output and exact reasoning menu in `/models`;
streamed `reasoning_content` and `reasoning` text is retained.

Configure a process-local model profile with `NAMZU_PROVIDER`, `NAMZU_MODEL`,
`NAMZU_EFFORT_LEVEL`, `NAMZU_SMALL_MODEL`, `NAMZU_SUBAGENT_MODEL`,
`NAMZU_MAX_OUTPUT_TOKENS` and `NAMZU_AUTO_COMPACT_WINDOW`. Explicit launch flags
win; `--max-output-tokens` also works in interactive sessions and both exec modes.
The SDK's optional `autoCompactWindowTokens` budgets automatic summaries inside
the actual model window without redefining the provider's context capability.
