---
'@namzu/sdk': patch
---

`claude-sonnet-5` is priced at $2 input and $10 output per million tokens, with $0.20 for a cache read and $2.50 for a five-minute cache write. The catalogue had $3 / $15 / $0.30 / $3.75. That was the increase the vendor scheduled for 2026-09-01 and then cancelled; $2 / $10 is now its standard price.

What changes for you: a Sonnet 5 turn reports two-thirds of the cost it reported before. A `turnConfig.costLimitUsd` set against Sonnet 5 now allows about 1.5 times as many tokens before it stops the turn. To keep the old ceiling, lower the limit to two-thirds of its value, or pass your own `pricing` table.
