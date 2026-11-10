---
'@namzu/sdk': patch
'@namzu/anthropic': patch
---

Prices `claude-fable-5-2` and `claude-mythos-5-2` ($8 input, $40 output, $0.20 cache read, $10 five-minute cache write per million tokens), `claude-sonnet-5-5` ($2, $10, $0.10, $2.50) and the retired `claude-opus-4` and `claude-sonnet-4`. Before, a turn on these models reported its cost as unknown, so a turn with `turnConfig.costLimitUsd` and no `pricing` table of your own was refused or stopped with `cost_unmeasurable`. `claude-haiku-5-5` stays unpriced on purpose: the vendor charges it by prompt length, which one rate cannot express, so its cost is still unknown and a cost limit still needs your own `pricing` entry for it.

`claude-haiku-5-*` now resolves to a 1M-token context window instead of the 200k default, so compaction triggers later on it.

`@namzu/anthropic` now matches the vendor on Sonnet 5.5, and the `claude-sonnet-5-5` behaviour changes. A forced tool choice (`toolChoice: 'required'` or a named function) is refused before sending with `forced_tool_choice_unsupported`, as the API would answer 400; use `toolChoice: 'auto'` or `responseFormat`. A `thinking: { type: 'disabled' }` setting is no longer sent to it, because the API rejects it: the request runs on the model's default adaptive thinking, as already happens on Opus 5.5. `claude-sonnet-5` is unchanged. On `claude-haiku-5-5`, `disabled` is still sent but `effort` `xhigh` or `max` alongside it is refused locally, as the API rejects it.
