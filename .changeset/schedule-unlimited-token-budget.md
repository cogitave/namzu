---
"@namzu/cli": major
"@namzu/sdk": minor
---

New scheduled agent phases now default to unlimited tokens (`tokenBudget: 0`)
instead of 500,000 tokens. A positive request or configured limit still applies,
and existing saved jobs retain their confirmed values. Set `limits.tokenBudget`
to `500000` or pass `--token-budget 500000` to retain the old default for new jobs.
To remove an existing job's limit, run `namzu schedule edit <name> --token-budget 0`
and confirm the edit. Iteration and timeout defaults remain unchanged.

The SDK schedule tool accepts zero for an unlimited agent token allowance.
Unlimited previews omit the numeric daily ceiling and identify the absence of a
token limit; usage accounting continues to measure actual tokens.
