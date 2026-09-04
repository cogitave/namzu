---
"@namzu/cli": minor
---

A headless run can be given a longer leash. `--max-iterations <n>` and `--token-budget <n>` on `run` and `run-stream`, and a file-only `limits: { maxIterations, tokenBudget }` key they override, replace the fixed 50 model calls and one million tokens every run used to get — the numbers a chat turn wants, which a long autonomous task (a benchmark, a migration) outgrows and hit silently.
