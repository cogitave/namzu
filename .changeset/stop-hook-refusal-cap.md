---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A `turn_end` or `subagent_stop` hook that keeps refusing to let a turn end no longer keeps it going until `maxIterations`. After 8 refusals in a row the turn ends anyway and one message in the transcript names the hook; a tool call between refusals starts the count over, and a hook that refuses fewer times behaves as before. Set the limit with `TurnConfig.maxHookRefusals` in the SDK or `limits.maxHookRefusals` in the CLI config; `0` removes the limit and restores the old behaviour. Nothing else to change.
