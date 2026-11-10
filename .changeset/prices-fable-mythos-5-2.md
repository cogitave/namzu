---
'@namzu/sdk': patch
---

Prices `claude-fable-5-2` and `claude-mythos-5-2` ($8 input, $40 output, $0.20 cache read, $10 five-minute cache write per million tokens). Before, a turn on either model reported its cost as unknown, so a turn with `turnConfig.costLimitUsd` and no `pricing` table of your own was refused or stopped with `cost_unmeasurable`. No action needed; upgrade to get a cost figure and a working cost limit on these models.
