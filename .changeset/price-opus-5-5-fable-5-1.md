---
'@namzu/sdk': patch
---

`claude-opus-5-5`, `claude-fable-5-1` and `claude-mythos-5-1` now have prices in the built-in catalogue. Before, their tokens were reported as unpriced. A turn that set `turnConfig.costLimitUsd` without its own `pricing` table was refused at the start on these models, or stopped with `cost_unmeasurable` when it reached one through a step or a fallback.

The rates are the vendor's list prices per million tokens:

| Model | Input | Output | Cache read | Cache write (5 min) |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` | $4 | $20 | $0.20 | $5 |
| `claude-fable-5-1`, `claude-mythos-5-1` | $10 | $50 | $0.25 | $12.50 |

On these three models a cache read costs less than the usual 0.1x of input: 0.05x on Opus 5.5, 0.025x on the 5.1 pair. The catalogue has one write rate, the five-minute one the Anthropic driver requests, so the one-hour rates ($8 and $20) are not represented. Nothing to change on your side.
