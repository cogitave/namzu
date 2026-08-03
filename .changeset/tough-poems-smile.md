---
'@namzu/sdk': minor
---

Add an evaluation harness with trajectory scoring.

There was no evaluation harness of any kind — no dataset, no scorer, no judge,
no trajectory assertion. So namzu's most load-bearing behavior was tuned by
constants nobody could measure: `search_tools` activates the top 5 deferred
tools, compaction fires at 0.7 of the window, six state lists cap at 25. Change
any of them, or a builtin tool description, or the deferred-tools prompt block,
and there was no way to learn the agent now takes four tool calls where it took
one — short of a user hitting it.

```ts
import { runExperiment, trajectoryScorer, completionScorer, evalRunFromQuery } from '@namzu/sdk'

const report = await runExperiment({
  name: 'file-editing',
  cases: [{ name: 'edits after reading', input: msgs, expectedTools: ['read', 'edit'] }],
  scorers: [trajectoryScorer(), completionScorer()],
  run: (input) => evalRunFromQuery(query({ provider, tools, messages: input, /* … */ })),
})
```

- **`trajectoryScorer`** scores the tool sequence as F1 over the longest common
  *subsequence*. Subsequence, not set intersection: reading a file before
  editing it is not the same run as editing then reading. Extra calls cut
  precision, missing calls cut recall — so "did the right thing wastefully" and
  "skipped a step" get different scores, which a final-answer assertion
  collapses into one.
- `completionScorer`, `stepBudgetScorer`, `containsScorer`, and `customScorer`
  for anything else — including a model-graded judge, which is just an async
  predicate that calls a provider.
- **Every `Score` carries a required `reason`.** A bare number tells you a run
  got worse without telling you how, which is exactly when you need to know;
  `formatReport` prints those reasons for failures rather than a bare mean.
- A case that throws is a *result*, not a crash: a suite whose first broken
  case aborts tells you nothing about the other forty. Same for a scorer that
  throws.
- `evalRunFromRun` / `evalRunFromQuery` bridge a finished `Run` into the shape
  scorers consume. That bridge is three lines of mapping only because
  `Run.steps` exists — otherwise a trajectory scorer would have to correlate
  raw `RunEvent`s by iteration number and diff cumulative counters.
