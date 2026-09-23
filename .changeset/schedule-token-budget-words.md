---
'@namzu/sdk': patch
'@namzu/cli': patch
---

The `schedule` tool's input schema describes `budget.tokenBudget` as what the whole run may spend, with every model call resending the prompt, and the CLI's confirmation of a job warns when it allows fewer than 50 000 tokens. A model proposed 4 000 tokens for a browser job whose runs each took about 110 000.
