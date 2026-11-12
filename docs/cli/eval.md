---
type: Reference
title: namzu eval
description: Run eval suites with repeats, settings snapshots and a tune and held-out split, read a report with its intervals and disclosure, and compare two reports paired by case.
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
namzu eval --dir packages/evals --split held-out --settings tight.json --out held-tight.json
namzu eval compare a.json b.json
```

## Options

- **`--dir <path>`**: where to look for suites (default `packages/evals`).
- **`--tag <tag>`**: run only suites that export this tag.
- **`--out <file>`**: write the whole report as JSON. The file has `schemaVersion: 2`, a `run` object with the numbers for every suite together, and a `suites` list with each suite's full report.
- **`--timeout-ms <ms>`**: how long one suite may run before it counts as inconclusive.
- **`--repeat <n>`**: run every case `n` times, from 1 to 100. Default 1. It reaches every suite, including one written before the option existed, because the runner opens a scope that `runExperiment` reads; a suite that sets `repeats` in its own config is overridden by the flag.
- **`--seed <n>`**: the seed for the intervals, an integer from 0 to 4294967295. Default 1. The seed is written into the report.

- **`--settings <file>`**: run the suites under the settings in this JSON or YAML file and write them into the report as a named snapshot. See [Settings snapshots](#settings-snapshots).
- **`--settings-name <name>`**: the snapshot's name. Default: the file's name without its extension; `default` when there is no file.
- **`--split tune|held-out|all`**: run one split of the tasks. Default `all`, which is what the command did before the option existed. See [Splits](#splits-tune-and-held-out).

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
- **Splits.** A case may declare `split: 'development'` or `split: 'held-out'`; the report gives the numbers for each. A suite with no held-out case says so, because a score on cases the suite was shaped against says how well it fits them and little about cases it has not seen. No suite has to declare a split. This is what a suite states about its own cases; the split every task is in, and the one `--split` selects, is described under [Splits: tune and held-out](#splits-tune-and-held-out), and a case declared `development` is `tune` there. The line about no held-out cases is left out of a run made with `--split held-out`.
- **How it ran.** The `disclosure` records the harness version, the SDK version, the date, the number of cases and repeats, the seed, the suite version (and the commit, when the suites sit in a git checkout; `-dirty` is appended when tracked files have changed since it), whether the suite is scripted, ran a real model or used none, the provider and model of each role, the routing configuration and the reasoning effort. A suite states what it knows through `disclosure` in its `runExperiment` config. The kernel does not check those statements against the provider that actually ran, so moving a suite to a real model means changing its `disclosure` too; a fact it does not state is written `unknown`, never guessed.

The whole-run summary after the last suite repeats the numbers over every case of every suite, with its own interval.

The intervals assume the cases are independent. Several cases made from one scenario are not, and then the interval is narrower than it should be.

## Settings snapshots

A comparison of two harness settings is only as trustworthy as what each report says about the settings it ran under. Every suite report and the whole-run summary carry a snapshot: a `name`, a `digest` and the `values`.

```text
  settings: "tight", sha256 583e43cb5c08
```

- **`values`** are the settings the run was given. Without `--settings` there are none and the snapshot is called `default`. `namzu eval` does not read your own config files, so a report does not depend on whose machine made it. A value that equals a default but is written out is a value: it changes the digest.
- **`digest`** is the SHA-256 of the values in a canonical form: keys sorted at every level, list order kept, no whitespace. It is the same whatever order the keys were written in and whatever the snapshot is called, and it changes with any value. The name is a label.
- **`--settings <file>`** takes the shape of the config file, limited to what an eval may vary: `compaction`, `goal`, `handBack`, `limits`, `memory`, `model`, `refusalFallback`, `routing`, `smallModel` and `workflow`. Each value is checked by the loader's own reader, so a value that would stop Namzu starting stops the eval with the same sentence. A key that is not a setting is refused as unknown, and a key that is a setting but holds credentials, runs commands, reaches the network or only changes the terminal (`mcpServers`, `hooks`, `permissions`, `plugins`, `sandbox`, `telemetry` and the rest) is refused as not one an eval varies. All of that is a usage error (exit 3) and nothing is written.
- **Secrets never enter a snapshot.** Even among the allowed keys, a key whose name is a credential (an API key, a token, a secret, a password, an authorization header, a cookie) or a value shaped like one is refused, and the message names where, never what. A test asserts that no report holds a planted key.
- **A suite reads the settings, or it does not.** A suite shapes itself by them through `evalSetting('limits.maxIterations')` or `currentEvalSettings()` from `@namzu/sdk`. Asking marks the suite's report `read: true`; a suite that never asks is reported as not reading them and the run says so, because a setting nobody reads cannot have changed what that suite measured. Today `kernel/context` reads `limits.maxIterations` and `limits.maxResponseTokens`; the other suites read none, so a settings file changes only what a suite reads. The snapshot says which settings the run was given and nothing about whether a suite used them.

Not in the snapshot: the identity of the system prompt and the tool set. The kernel has no stable identity for either yet, so the report says nothing about them rather than guess.

## Splits: tune and held-out

Settings chosen on some tasks and judged on the same tasks have been shown to fit those tasks. Every task (a case, named by its suite and its id) belongs to one of two splits:

- **`tune`**: the tasks you choose settings on.
- **`held-out`**: the tasks you judge the choice on.

The split of a task is a function of its identity: the first 48 bits of the SHA-256 of the seed `namzu-eval-split-1`, the suite and the case id, read as a fraction; under 0.5 the task is held-out. The same task is in the same split on every machine, in every run. The seed and the share are fixed in the kernel and written into every report (`taskSplit.seed`, `taskSplit.heldOutFraction`); a hash cannot split a small suite evenly, and it does not split a small suite evenly: `kernel/answer-claims` has 6 held-out tasks and 2 tune, `kernel/goal-by-record` 3 and 5, and the one task of `kernel/salience` is tune, so that suite does not run on held-out. A case may state its split with `split: 'held-out'` or `split: 'development'` (the name an older suite uses for `tune`); a stated split wins over the hash. Cases that state none are the ones the hash decides.

`--split held-out` runs only the held-out tasks, `--split tune` only the tune ones. A suite with no task in the split is named and left out ("Suite kernel/salience has no task in the held-out split; it did not run."); if no suite has one the command exits 3. The report records `taskSplit`: what was asked for, the seed, the share, and the id and split of every task that ran. On the shipped suites the split is 35 held-out and 21 tune among 56 tasks.

Nothing else changes with `--split`: every number is computed over the tasks that ran, the way it always was.

## What a comparison will not say

A comparison names a winner in exactly one case: the two reports ran the held-out split, over the same tasks, under different settings snapshots, and the paired interval (and, when tasks flipped, the exact test) agree. In every other case the sentence starts `no winner is named:` and says why, still prints every number, and carries the reasons in the JSON as `verdict.withheld`:

- **`tune-split`**: "these are the tasks the settings were chosen on; run the held-out split to judge."
- **`identical-settings`**: the two snapshots have the same digest, so any difference between the reports is run-to-run noise.
- **`no-snapshot`**: a report has no snapshot (it was written before this existed). It still loads and compares, and its numbers are printed, but what the two runs changed is not known.
- **`tasks-differ`**: the reports ran different tasks. The cases only one side has are listed, as before.
- **`not-held-out`**: a report ran all tasks or a mix, which include the tasks the settings were chosen on.

The comparison prints each side's snapshot name and digest, the split each ran, and what differs between the two snapshots key by key (`limits.maxIterations: A not stated, B 2`). The JSON carries `settings` (`a`, `b`, `identical`, `differences`, `notRead`) and `split` (`a`, `b`).

## Honest limits

- **The split protects only if you use it.** It protects against choosing settings on the tasks you judge on only if you really choose on `tune` and judge on `held-out`. The tool records which split each report ran and says what it can; it cannot know what you looked at. Someone who reads the held-out failures and adjusts the settings has tuned on them, and nothing in a report will show it. Judge once, and a judgement you repeat after each change is a tuning loop.
- **A small suite gives wide intervals.** The paired comparison has two checks and a claim needs both. The interval needs at least 5 paired tasks. The exact sign test on the tasks that flipped needs, at best, 6 flipped tasks all one way (two-sided p = 2/2^6 = 0.031; with 5 it is 0.0625 and no claim is made), and 8 flips against 1 (p = 0.039); 7 against 1 is p = 0.070. So the smallest difference in pass rate a comparison can show is about 6 divided by the number of held-out tasks, and only when nothing flips the other way: 15 held-out tasks show nothing below 40 points, 30 show 20 points, 60 show 10 points, 120 show 5 points. The 35 held-out tasks the shipped suites have can at best show 17 points. A real model that does not answer the same way twice makes it worse.
- **Repeats are not tasks.** `--repeat` makes a task's pass more or less certain; it does not add tasks, and the interval and the sign test are over tasks.
- **A setting must be read to matter.** See above: a settings file does not change a suite that does not read it.
- **Splitting is by task, not by what the tasks share.** Several tasks made from one scenario land in both splits and the held-out ones are then not independent of the tune ones.

## How to compare two runs

`namzu eval compare <a.json> <b.json>` reads two files written by `--out`. A is the baseline and B the run judged against it. Cases are paired by suite and id, and the comparison prints:

- the cases only one side has, which are left out of every number below;
- the difference in mean score and in pass rate, B minus A, over the paired cases, each with a 95% paired bootstrap interval. A resample draws pairs, so both sides of a case move together. `--seed` sets the seed (default 1);
- how many cases flipped each way. A case passes when every one of its runs passed, so with repeats a case that fails once counts as failing;
- an exact two-sided sign test on the flips: under no difference each flip goes either way with probability one half, and the p value is twice the smaller tail of that binomial;
- one sentence: either `B is better than A by X in mean score, 95% interval [low, high]` (or worse), `no difference can be claimed at this size`, or `no winner is named: <reason>` (see [What a comparison will not say](#what-a-comparison-will-not-say); the first two are printed only when that section's one case holds). The first is printed only when the interval for the difference in mean score excludes zero at the precision it is printed (a bound that prints as 0.000 is zero), and, when any case flipped, only when the exact test on the flips is below 0.05 as well: two checks that disagree print the cautious sentence and say why. With fewer than 5 paired cases there is no interval and so no claim. A report in which one case id appears twice for the same repeat is refused, because its runs cannot be told from repeats of one case;
- the settings snapshot each side ran under and what differs between them, and the split each ran;
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
Whole run: 168/168 runs passed across 8 suites, 56 cases x 3 repeats
  mean score 1.000, 95% interval 1.000 to 1.000
  pass rate 100.0%, 95% interval 100.0% to 100.0%
  intervals: percentile bootstrap over cases, repeats kept together (56 cases, 2000 resamples), seed 7
  reliability across repeats: 56 of 56 cases passed in every one of 3 repeats (100.0%)
  no held-out cases: every number here is measured on cases the suite was developed against
  settings: "default", sha256 44136fa355b3
  split: all
  produced by: namzu eval 51.1.0, sdk 62.13.0, commit 14f09af4115563894935b6d029b9ab3aa9c1e53c, 2026-11-12T09:31:40.217Z, mixed
```

and the comparison prints:

```text
A: a.json (56 cases)
B: b.json (56 cases)
Cases are paired by suite and id; 56 paired. Seed 1.

Only in A: none
Only in B: none

Mean score: A 1.000, B 1.000, difference 0.000; 95% paired interval [0.000, 0.000]
Pass rate: A 100.0%, B 100.0%, difference 0.0 points; 95% paired interval [0.0 points, 0.0 points]
Flips: 0 cases passed on B and not on A, 0 passed on A and not on B (56 passed on both, 0 failed on both). A case passes when every one of its runs passed. exact two-sided sign test on the cases that flipped: p = 1.0000

no winner is named: the two reports ran under identical settings (default, 44136fa355b3), so any difference between them is run-to-run noise.
  (a report ran on all tasks or a mix of splits, which include the tasks the settings were chosen on; run the held-out split to judge; the paired difference in mean score over 56 paired cases is 0.000, 95% interval [0.000, 0.000].)

Settings: A "default" (sha256 44136fa355b3), B "default" (sha256 44136fa355b3). Split: A all, B all.
The two runs ran under identical settings.

What differs in how the two reports were produced:
  kernel/answer-claims repeats: A 1, B 3
  kernel/context repeats: A 1, B 3
  kernel/delegation repeats: A 1, B 3
  kernel/goal-by-record repeats: A 1, B 3
  kernel/hand-back repeats: A 1, B 3
  kernel/salience repeats: A 1, B 3
  kernel/tool-loop repeats: A 1, B 3
  security/oauth-state repeats: A 1, B 3
```

All 56 cases pass in every run on both sides, so there is nothing to tell apart. Both runs are under the `default` snapshot and ran every task, so no winner could be named whatever the numbers were, and the comparison says so first. The only stated difference is the number of repeats.

### A comparison that can speak

Choose settings on `tune`, then judge them once on `held-out`:

```bash
namzu eval --dir packages/evals --split tune --settings tight.json --out tune-tight.json
namzu eval --dir packages/evals --split held-out --out held-default.json
namzu eval --dir packages/evals --split held-out --settings tight.json --out held-tight.json
namzu eval compare held-default.json held-tight.json
```

with `tight.json` holding `{"limits": {"maxIterations": 2, "maxResponseTokens": 128}}`. The comparison of the two held-out reports ends:

```text
no difference can be claimed at this size.
  (the 95% interval [0.000, 0.000] for the difference in mean score over 35 paired cases includes zero.)

Settings: A "default" (sha256 44136fa355b3), B "tight" (sha256 583e43cb5c08). Split: A held-out, B held-out.
What differs in the settings:
  limits.maxIterations: A not stated, B 2
  limits.maxResponseTokens: A not stated, B 128
Suites that ran under settings but did not read them (B): kernel/answer-claims, kernel/delegation, kernel/goal-by-record, kernel/hand-back, kernel/tool-loop, security/oauth-state
```

Only `kernel/context` reads those two settings, and its cases pass at either value, so the two reports are alike. Running the same comparison on the tune reports instead prints `no winner is named: these are the tasks the settings were chosen on; run the held-out split to judge.`
