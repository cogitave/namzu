---
type: Reference
title: namzu eval
description: Run eval suites with repeats, read a report with its intervals and disclosure, and compare two reports paired by case.
resource: packages/cli/src/commands/eval.ts
tags: [cli, evals, statistics]
status: stable
generated: { by: human:bahadirarda, at: 2026-11-12T00:00:00Z }
---

# namzu eval

`namzu eval` discovers `*.eval.js` suites under a directory, runs them, prints a report for each and a summary for the whole run, and sets an exit code. Suites are written with `runExperiment` from `@namzu/sdk`; the kernel and security suites that ship in `@namzu/evals` use a scripted provider or none, so what they measure is the code and never a vendor.

```bash
namzu eval --dir packages/evals --out report.json
namzu eval --dir packages/evals --repeat 3 --seed 7 --out report.json
namzu eval compare a.json b.json
```

## Options

- **`--dir <path>`**: where to look for suites (default `packages/evals`).
- **`--tag <tag>`**: run only suites that export this tag.
- **`--out <file>`**: write the whole report as JSON. The file has `schemaVersion: 2`, a `run` object with the numbers for every suite together, and a `suites` list with each suite's full report.
- **`--timeout-ms <ms>`**: how long one suite may run before it counts as inconclusive.
- **`--repeat <n>`**: run every case `n` times, from 1 to 100. Default 1. It reaches every suite, including one written before the option existed, because the runner opens a scope that `runExperiment` reads; a suite that sets `repeats` in its own config is overridden by the flag.
- **`--seed <n>`**: the seed for the intervals, an integer from 0 to 4294967295. Default 1. The seed is written into the report.

A value outside those ranges is a usage error (exit 3). The SDK options behind them are `repeats` and `seed` on `runExperiment`.

## Exit codes

Unchanged by repeats and intervals. `0` every run passed; `1` at least one run failed (with repeats, a failed repeat counts); `2` at least one run could not be judged, which is checked first because a harness that cannot judge says nothing about the rest; `3` no suite found, a suite that would not load, or a usage error. `namzu eval compare` exits `0` when it printed a comparison whatever the answer is, and `3` for a file it cannot read or a file that is not a report.

## How to read a report

Each suite prints a header line, then the numbers that say how far to trust it:

```text
kernel/context: 21/21 runs passed (7 cases x 3 repeats, mean 1.00) in 2524ms
  mean score 1.000, 95% interval 1.000 to 1.000
  pass rate 100.0%, 95% interval 100.0% to 100.0%
  intervals: percentile bootstrap over cases, repeats kept together (7 cases, 2000 resamples), seed 7
  reliability across repeats: 7 of 7 cases passed in every one of 3 repeats (100.0%)
  no held-out cases: every number here is measured on cases the suite was developed against
  ran as scripted: agent MockLLMProvider/scripted; routing off; effort not applicable; suite 1.0.3
```

- **Mean score** is the mean of the case scores over the runs that were judged. A run no scorer could judge is left out of it and is counted as inconclusive, never as a zero.
- **Pass rate** is passed runs over judged runs, pooled over every repeat.
- **The 95% interval** is a percentile bootstrap over cases. Each of 2000 resamples draws as many cases as the suite has, with replacement, and a case's repeats travel with it: repeats of one case are not independent evidence about the suite, so they do not narrow the interval. The seed makes the interval the same on every machine. With fewer than 5 cases that have a judged run no interval is computed, and the line says so and why; the number is still printed. Read the width, not only the middle: an interval from 40% to 100% says the suite cannot tell much, whatever the pass rate.
- **Reliability across repeats** (shown when `--repeat` is above 1) is the fraction of cases whose every repeat passed. A case that passes two of three times counts as passing in the pass rate and as not reliable here. The cases that did not pass every repeat are listed with how many did.
- **Splits.** A case may declare `split: 'development'` or `split: 'held-out'`; the report gives the numbers for each. A suite with no held-out case says so, because a score on cases the suite was shaped against says how well it fits them and little about cases it has not seen. No suite has to declare a split.
- **How it ran.** The `disclosure` records the harness version, the SDK version, the date, the number of cases and repeats, the seed, the suite version (and the commit, when the suites sit in a git checkout; `-dirty` is appended when tracked files have changed since it), whether the suite is scripted, ran a real model or used none, the provider and model of each role, the routing configuration and the reasoning effort. A suite states what it knows through `disclosure` in its `runExperiment` config. The kernel does not check those statements against the provider that actually ran, so moving a suite to a real model means changing its `disclosure` too; a fact it does not state is written `unknown`, never guessed.

The whole-run summary after the last suite repeats the numbers over every case of every suite, with its own interval.

The intervals assume the cases are independent. Several cases made from one scenario are not, and then the interval is narrower than it should be.

## How to compare two runs

`namzu eval compare <a.json> <b.json>` reads two files written by `--out`. A is the baseline and B the run judged against it. Cases are paired by suite and id, and the comparison prints:

- the cases only one side has, which are left out of every number below;
- the difference in mean score and in pass rate, B minus A, over the paired cases, each with a 95% paired bootstrap interval. A resample draws pairs, so both sides of a case move together. `--seed` sets the seed (default 1);
- how many cases flipped each way. A case passes when every one of its runs passed, so with repeats a case that fails once counts as failing;
- an exact two-sided sign test on the flips: under no difference each flip goes either way with probability one half, and the p value is twice the smaller tail of that binomial;
- one sentence: either `B is better than A by X in mean score, 95% interval [low, high]` (or worse), or `no difference can be claimed at this size`. The first is printed only when the interval for the difference in mean score excludes zero at the precision it is printed (a bound that prints as 0.000 is zero), and, when any case flipped, only when the exact test on the flips is below 0.05 as well: two checks that disagree print the cautious sentence and say why. With fewer than 5 paired cases there is no interval and so no claim. A report in which one case id appears twice for the same repeat is refused, because its runs cannot be told from repeats of one case;
- what differs in how the two reports were produced: harness, suite versions, model, route, reasoning effort, repeats. A fact one report does not state (an older file has none) is listed as stated on one side only and is not read as a difference.

When more than one of those differs, the command warns: the difference in the scores cannot be attributed to any one of them. Change one thing between two runs you mean to compare.

`--json` prints the same facts as one JSON object. A report written before this existed still loads; its disclosure is read as unknown and its cases as single runs.

### Worked example

The scripted suites, once and then with three repeats, both written with `--out`:

```bash
namzu eval --dir packages/evals --out a.json
namzu eval --dir packages/evals --repeat 3 --seed 7 --out b.json
namzu eval compare a.json b.json
```

The second run ends with:

```text
Whole run: 120/120 runs passed across 6 suites, 40 cases x 3 repeats
  mean score 1.000, 95% interval 1.000 to 1.000
  pass rate 100.0%, 95% interval 100.0% to 100.0%
  intervals: percentile bootstrap over cases, repeats kept together (40 cases, 2000 resamples), seed 7
  reliability across repeats: 40 of 40 cases passed in every one of 3 repeats (100.0%)
  no held-out cases: every number here is measured on cases the suite was developed against
  produced by: namzu eval 51.0.1, sdk 62.12.0, commit 909b73c7c62a1a8b95968eaf1ce91a49e8c5a9ea, 2026-11-12T00:48:32.020Z, mixed
```

and the comparison prints:

```text
A: a.json (40 cases)
B: b.json (40 cases)
Cases are paired by suite and id; 40 paired. Seed 1.

Only in A: none
Only in B: none

Mean score: A 1.000, B 1.000, difference 0.000; 95% paired interval [0.000, 0.000]
Pass rate: A 100.0%, B 100.0%, difference 0.0 points; 95% paired interval [0.0 points, 0.0 points]
Flips: 0 cases passed on B and not on A, 0 passed on A and not on B (40 passed on both, 0 failed on both). A case passes when every one of its runs passed. exact two-sided sign test on the cases that flipped: p = 1.0000

no difference can be claimed at this size.
  (the 95% interval [0.000, 0.000] for the difference in mean score over 40 paired cases includes zero.)

What differs in how the two reports were produced:
  kernel/answer-claims repeats: A 1, B 3
  kernel/context repeats: A 1, B 3
  kernel/delegation repeats: A 1, B 3
  kernel/salience repeats: A 1, B 3
  kernel/tool-loop repeats: A 1, B 3
  security/oauth-state repeats: A 1, B 3
```

All 40 cases pass in every run on both sides, so there is nothing to tell apart: the interval is zero wide around a difference of zero and the sentence is the cautious one. The only stated difference is the number of repeats, one thing, so there is no warning. A comparison that found a case that failed on one side would show it under `Flips`, and would name a winner only if the interval for the mean score left zero out.
