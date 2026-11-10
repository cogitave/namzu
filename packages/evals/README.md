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
| Baseline: two children replacing one file from the same read, sharing the parent's ledger: the later write is not refused | 2 | 180 | 1 |
| Baseline: two children replacing one file, the later one reading after the first wrote | 2 | 180 | 1 |
| A child that fails comes back as a failure with no answer | 1 | 80 | 0 |
| A finished child continued with a follow-up keeps its conversation | 1 (2 delegations) | 40 | 0 |
| `continue_task` refuses a finished child and names its state | 1 | 110 | 0 |
| A delegation at the depth cap is refused with the documented words | 0 | 60 | 0 |
| A delegation one level under the depth cap starts | 1 | 80 | 0 |
| A third parallel child over a width cap of two is refused | 2 | 100 | 0 |
| The same with queueing on: the third waits for a slot and finishes | 3 | 120 | 0 |

The two "baseline" rows pin what the kernel does today where nothing says what
it should do, so a change to them is a decision and not an accident. A child
runs with its parent's file ledger, so two parallel children share one, and
whichever writes first records its write there as the newest observation of the
file. The second child's copy then matches the ledger, so its write is not
refused as stale: it replaces the first edit, both children report one file
changed, and nothing the parent reads says an edit was lost. That holds whether
the second child read before the first wrote (the order is forced by holding its
write until the first has landed) or after. The case that read first used to be
refused as stale; it stopped when children began sharing the parent's ledger,
and it comes back as a refusal if each child gets a ledger of its own. Parallel
writers to one file lose an edit without the parent being told.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
