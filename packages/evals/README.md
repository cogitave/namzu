<!-- okf
type: Reference
title: "@namzu/evals"
description: >-
  Namzu's own behaviour and security suites, runnable with `namzu eval`.
  Nothing here measures a model — a score that moves means the code changed,
  not that a vendor did.
tags: [readme, package, evals, testing]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
-->

<div align="center">

<h1>@namzu/evals</h1>

**Behaviour and security suites for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/evals.svg)](https://www.npmjs.com/package/@namzu/evals)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Namzu's own behaviour and security suites, runnable against an installed
kernel. Nothing here measures a model: the kernel suites run a scripted
provider and the security suites touch none, so a score that moves means the
code changed.

## Install

```bash
pnpm add -D @namzu/cli @namzu/evals
```

`@namzu/sdk >=44.0.0` is a peer dependency; `@namzu/cli` brings a matching one.

**Compatibility.** `@namzu/evals` before 1.0.0 breaks on `@namzu/sdk >=44`. Use
`@namzu/evals >=1` with `@namzu/sdk` 44.

## Usage

```bash
pnpm exec namzu eval --dir node_modules/@namzu/evals --out eval-report.json
```

The kernel suites drive a scripted provider and the security suites touch no
provider at all, so both are deterministic and cost nothing to run.

## The answer-claims suite

`kernel/answer-claims` measures what the kernel records when an answer says a
check passed, not whether a model would say so: the tool calls and the closing
words of every case are scripted. Each case scores the verdict of the turn's
outcome record and whether the comparison of the answer with that record fired
(`outcomeScorer`, `claimMismatchScorer`). It pins a pass claimed after a failing
check, after changes nobody checked and after a check whose result was hidden,
and the silence on the same words after a passing check, after nothing changed,
as a negation, and as an honest "I did not run it". The comparison is shadow only
and reads English claims only.

## The did-not-run suite

`kernel/call-did-not-run` measures what the outcome record says of a call that did not run, not whether a real model would make it: every model in it is scripted. A command that ran still makes the verdict `unknown`; a command the person declined, one a rule refused, a call to a tool that is not there and a mere launch of a background sub-agent leave it `unchanged`, and a launch followed by a command that ran says `unknown` again. Each case also scores how many times the scripted command really ran, read from the tool.

## The hand-back suite

`kernel/hand-back` measures what the kernel does when a model may hand a task back to a person, not whether a real model would: every model in it is scripted. Each case scores whether the turn was handed back and as which kind (`handedBackScorer`), the outcome record's verdict, the model calls, how many scripted edits actually ran (a call in the same step as the hand-back, or after it, must not), the kernel's closing sentence, whether the tool and its guidance were offered at all (with the setting off they must not be) and how a goal round ended. The exit status of `namzu exec` and the status of a scheduled run belong to the command line and are pinned by its tests.

## The delegation suite

`kernel/delegation` measures what the kernel does around a delegation, not what
a model decides: every model in it is scripted. The parent is the query loop
holding the SDK's own `Agent` tool over the real agent manager (one case uses
`create_task` and `continue_task`); each child is the query loop over its
scripted provider with the real `read` and `write` tools in a scratch directory.
The host application's own delegation tool is not run by it.

Each case records the number of child sessions started, the total tokens the
scripted providers reported, whether the parent's turn settled, and the edits
that were scripted but are missing from the files at the end. Correctness is a
gate: a miss fails the case. The two counts are soft scorers with a baseline and
a margin (child sessions exactly, tokens within ten percent). Nothing waits on a
clock: where one child must act after another has, its request is held on the
other's arrival.

Baseline on current `main`, to compare a later change to delegation guidance
against. Tokens are the scripted `usage`, so a change in the number means the
kernel made more or fewer requests, not that a model said more.

| Case | Child sessions | Tokens | Lost edits |
|---|---|---|---|
| A lookup comes back framed as untrusted and the parent can use it | 1 | 100 | 0 |
| A child that changed a file comes back with the kernel's record line after its block | 1 | 100 | 0 |
| Two parallel children writing different files: both land, each attributed to its child | 2 | 140 | 0 |
| Baseline: two children replacing one file from the same read | 2 | 180 | 1 |
| Baseline: two children replacing one file, the later one reading after the first wrote | 2 | 180 | 1 |
| A child that fails comes back as a failure with no answer | 1 | 80 | 0 |
| A finished child continued with a follow-up keeps its conversation | 1 (2 delegations) | 40 | 0 |
| `continue_task` refuses a finished child and names its state | 1 | 110 | 0 |
| A delegation at the depth cap is refused with the documented words | 0 | 60 | 0 |
| A delegation one level under the depth cap starts | 1 | 80 | 0 |
| A third parallel child over a width cap of two is refused | 2 | 100 | 0 |
| The same with queueing on: the third waits for a slot and finishes | 3 | 120 | 0 |

The two "baseline" rows pin what the kernel does today where nothing says what
it should do, so a change to them is a decision and not an accident. When two
children replace the same file from the same read, the second write is refused
because its copy of the file is stale, so only the first lands, and the parent
is told the second child changed nothing, not that an edit was refused. When the
second child reads after the first has written, nothing is refused: the first
edit is replaced, both children report one file changed, and nothing the parent
reads says an edit was lost. Parallel writers to one file lose an edit without
the parent being told.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
