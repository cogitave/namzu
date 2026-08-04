---
title: Evaluation
description: Score agent behaviour with a dataset, deterministic scorers, and a model-graded judge, so a behaviour change ships with a regression signal behind it.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk"]
---

# Evaluation

Namzu's most load-bearing behaviour is tuned by constants nobody can eyeball: how many deferred tools `search_tools` activates, when compaction fires, how long a tool description runs. Change any of them and the agent may take four tool calls where it took one — no error, no failing type, no test. The evaluation harness is what makes that visible.

## 1. Surface

| Piece | Owns | Main exports |
| --- | --- | --- |
| Dataset | inputs and what a good run looks like | `EvalCase` |
| Run adapter | turn a real run into something scoreable | `evalRunFromQuery`, `evalRunFromRun`, `EvalRun` |
| Deterministic scorers | pure functions over the run | `trajectoryScorer`, `completionScorer`, `stepBudgetScorer`, `containsScorer`, `customScorer` |
| Model-graded scorer | judge an open-ended answer | `judgeScorer` |
| Harness | run the dataset, score it, report | `runExperiment`, `formatReport` |

## 2. A Minimal Suite

```ts
import {
  completionScorer,
  formatReport,
  runExperiment,
  stepBudgetScorer,
  trajectoryScorer,
} from '@namzu/sdk'

const report = await runExperiment({
  name: 'file-editing',
  cases: [
    {
      name: 'reads before writing',
      input: 'Fix the typo in README.md',
      expectedTools: ['read', 'edit'],
    },
  ],
  scorers: [trajectoryScorer(), completionScorer(), stepBudgetScorer(6)],
  run: async (input) => evalRunFromQuery(query({ prompt: input, /* … */ })),
})

console.log(formatReport(report))
```

Every scorer must return a `reason`. A CI log that says `0.62` is a log that sends someone back to reproduce the failure by hand, so a scorer that cannot explain itself is one that should not exist.

## 3. Trajectory, Not Just The Answer

`trajectoryScorer` compares the tool sequence the run produced against the one the case expected, as F1 over the longest common **subsequence**. Order carries meaning: reading a file before editing it is not the same run as editing then reading, and a set-based comparison cannot tell them apart. Extra calls cut precision, missing calls cut recall — so a run that does the right thing wastefully and a run that skips a step score differently, which is the distinction a final-answer score collapses.

## 4. The Model-Graded Judge

`containsScorer` can check that a required phrase appears. It cannot tell a correct explanation from a fluent wrong one — and that is usually the dimension most worth guarding.

```ts
import { judgeScorer } from '@namzu/sdk'

judgeScorer({
  provider,
  model: 'your-judge-model',
  rubric: [
    'The answer names the failing test and the file it lives in.',
    'It states one concrete cause, not a list of possibilities.',
  ].join('\n'),
  scale: 4,
})
```

Four choices in here are deliberate, because each is a place these go wrong:

- **The rubric is required.** A judge asked to rate "quality" rates fluency, which correlates with little worth measuring and drifts whenever the judge model changes. `judgeScorer` throws rather than run without one.
- **An ordinal scale, not a 0..1 float.** Models place a continuous score poorly and cluster on round numbers; a short scale against a written rubric is a judgement they can actually make. The result is divided down to 0..1 for the report. The default scale of 4 is **even** on purpose: an odd scale has a midpoint, and a midpoint is where an uncertain judge parks.
- **Temperature 0.** Sampling noise is indistinguishable from a regression.
- **Truncation is disclosed in the prompt.** A judge shown a silently cut answer marks it down for stopping mid-sentence, which scores the harness rather than the run.

`details.judgeTokens` carries what the judging itself cost. A judge is the most expensive scorer there is, and a bill nobody can attribute is a bill nobody controls.

## 5. Unavailable Is Not Zero

A judge is a network call, so it can fail to answer at all — and **a failed measurement is not a measurement of zero**. Scoring a rate limit as `0` says "the run was bad" when the truth is "we do not know", and the two demand opposite responses: one is a regression to chase, the other is a broken harness to fix.

So a scorer that throws returns `unavailable: true`, and:

- the score is excluded from the case mean's numerator **and** its denominator;
- a case where every scorer was unavailable is reported as `inconclusive`, neither passed nor failed;
- `byScorer` averages each scorer over the cases it actually judged, and omits one that was never available rather than reporting it as `0`;
- `formatReport` surfaces the inconclusive count **above** the failures, because it means every number below covers less evidence than it appears to.

```ts
if (report.inconclusive > 0) {
  // The harness is broken, not the agent. Fix this before reading `mean`.
}
```

A run that **threw** still scores zero: that is a real failure of the thing under test, not of the measurement.

## 6. Operational Notes

- Two scorers sharing a name is an error, not a silent overwrite. Scores are keyed by name, so the second would replace the first and the mean would be computed over the wrong denominator.
- A case that throws is a result, not a crash — a suite whose first broken case aborts tells you nothing about the other forty.
- `concurrency` defaults to 1, so ordering is deterministic unless you ask otherwise.

### Gate scorers versus soft ones

A case's verdict used to be one unweighted mean over every scorer against
one suite-wide threshold, and the two halves of that fought each other. At
the default threshold of 1 the harness never reports a false pass — but a
trajectory F1 and a graded judge can essentially never reach 1, so every
real suite lowers it. And every step down buys tolerance for the fuzzy
scorers by buying exactly the same tolerance for the deterministic ones: at
`passThreshold: 0.75`, trajectory 0 + completion 1 + contains 1 + judge 1
averages to 0.75 and reports **passed**. The regression the harness exists
to catch comes back green.

```ts
{ name: 'trajectory', severity: 'gate', threshold: 0.9, score }
```

| `severity` | Effect |
| --- | --- |
| `gate` | A miss fails the case outright, whatever the mean says |
| `soft` (default) | Contributes to the mean only |

`threshold` is per-scorer and falls back to the suite's `passThreshold`,
because "good enough" is not one number across dimensions: a trajectory
match at 0.8 may be fine while a completion check at 0.8 is meaningless —
it either finished or it did not. `completionScorer` and `containsScorer`
ship as gates for that reason.

A gate that came back **unavailable** does not fail the case: it did not
judge the run badly, it failed to judge it, which is the inconclusive path.
`CaseResult.failedGates` names the gates that missed, and `formatReport`
prints them above the individual scores — a case reported failed with a
mean of 0.75 otherwise sends somebody to read four scores and guess which
one mattered.
- `timeoutMs` bounds a single case. Unset means no deadline, which was the
  only behaviour available: a `run` closure that never settled blocked its
  worker and `runExperiment` never returned — no report, no partial
  results, nothing to read. A timed-out case is **reported** and the suite
  continues, exactly like a case that threw, and its `durationMs` is the
  real elapsed time rather than zero.
- `run` receives an `AbortSignal` as its third argument. A closure that
  drives `query()` should pass it through so the run actually stops; one
  that ignores it is merely detached, but the suite is unblocked either
  way. The signal does not fire for a case that finished in time — a
  spurious abort would train closures to ignore it.
- The documented path already inherits deadlines from the runtime it
  drives (a run-level timeout enforced between iterations, a per-tool
  abandon, provider request timeouts). `timeoutMs` covers what those
  cannot see: a closure that does not go through `query()`, and a
  mid-iteration provider stall.

### Caching case results

There is no built-in result cache, and that is deliberate — the `run`
callback is caller-owned, `onCaseFinish` fires per case, and `EvalRun` /
`CaseResult` / `ExperimentReport` are plain JSON, so caching is a few lines
of your own code:

```ts
const cache = new Map<string, EvalRun>()

const report = await runExperiment({
  name: 'cached',
  cases,
  scorers,
  run: async (input, evalCase, signal) => {
    const key = `${evalCase.name}:${JSON.stringify(input)}`
    const hit = cache.get(key)
    if (hit) return hit
    const fresh = await driveTheAgent(input, signal)
    cache.set(key, fresh)
    return fresh
  },
})
```

Persist the map however you like — the shapes are serializable. Building
this into the harness would mean owning a cache key policy that only the
caller can define correctly.

## 7. Running a Suite From CI

`namzu eval` discovers, runs, prints, writes an artifact, and sets an exit
code. Without it the harness's signal could not reach CI: every consumer
had to hand-write the runner and the report-to-exit-code mapping.

```bash
namzu eval --dir packages/evals --out eval-report.json
namzu eval --tag fast          # only suites declaring this tag
```

A **suite** is a file named `*.eval.js` that default-exports a function
returning an `ExperimentReport`, and may export a `tags` array:

```ts
export const tags = ['fast']

export default async function () {
  return runExperiment({ name: 'file-editing', cases, scorers, run })
}
```

The `run` callback stays caller-owned, so a suite module owns everything
about how its runs are constructed and hands back only the structured
result.

| Exit | Meaning |
| --- | --- |
| `0` | Every case passed |
| `1` | At least one case failed — a regression to chase |
| `2` | At least one case was inconclusive — a broken harness to fix |
| `3` | No suite found, one could not be loaded, or `--tag` matched nothing |

`2` is separate from `1` deliberately, for the same reason `unavailable`
is not zero: a suite that could not judge tells you nothing about the cases
it did judge, and collapsing the two sends somebody hunting a behaviour
change that never happened. It is checked first, so a run that is both
inconclusive and failing reports inconclusive.

`3` rather than `0` for an empty discovery: a gate that finds nothing to
run must not report green.

Suite ids are **path-derived** (`tools/read.eval.js` → `tools/read`,
always posix-separated) so two commits' artifacts describe the same
suites and can be diffed. Two files resolving to one id is refused rather
than resolved — a report would silently describe whichever ran last.

The artifact is the full report, not a summary, because a summary cannot
say which scorer moved.

## Related

- [Runtime](../runtime/README.md)
- [Observability](../observability/README.md)
- [Tools](../tools/README.md)
