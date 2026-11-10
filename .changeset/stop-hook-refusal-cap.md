---
'@namzu/sdk': minor
'@namzu/cli': minor
---

The SDK gains an optional `TurnConfig.maxHookRefusals`: how many times in a row a `turn_end` or `subagent_stop` hook may refuse to let a turn end before the turn ends anyway. Nothing changes for a host that does not set it. The CLI now ends a turn after 8 end-of-turn hook refusals in a row with no tool call between them (a tool call starts the count over, so a hook that sends the agent back to work is unaffected) and names the hook once in the transcript. Set `limits.maxHookRefusals: 0` in the CLI config to restore the old behaviour, where only `maxIterations` ends such a loop.
