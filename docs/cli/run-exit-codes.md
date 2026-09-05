---
type: Reference
title: Exit codes of a headless run
description: What $? says after namzu run — a reply, a failed or unfinished run, a paused run that kept a checkpoint, a missing prompt, a wrong argument, an untrusted folder — and what a wrapper should do with each.
resource: packages/cli/src/commands/run.ts
tags: [cli, run, headless]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-05T00:00:00Z }
---

# Exit codes of a headless run

`namzu run` is built to be called by something that is not a person: a script, a cron job, a benchmark harness. That caller reads two things, the text on stdout and `$?`, and the exit code has to carry every distinction the caller would act on differently.

| Code | Meaning | What a wrapper does |
| --- | --- | --- |
| 0 | The run finished and the text on stdout is the whole reply. | Use the output. |
| 1 | The run failed, or stopped before it was finished: a provider error, an iteration cap, a token budget, a cancellation, a refused answer. Any text on stdout is partial and stderr says why. | Treat the output as incomplete. Re-running blindly repeats the same stop. |
| 2 | No prompt was supplied. | Fix the invocation. |
| 64 | An argument was wrong. | Fix the invocation. |
| 75 | The provider paused the run — a rate limit or an outage — and the kernel kept a checkpoint, named on stderr. Any text on stdout is partial. With `--wait-for-provider` the run waits and attempts resume first; 75 means its provider wait could not complete. | Use the provider's retry delay or a wait budget. Resume still requires a resolved token ledger; waiting cannot resolve unknown request usage. |
| 77 | The folder has not been trusted and nothing ran. | Trust the folder once interactively, or pass `--trust` for this run. |

## Why a pause is not a failure

A paused run and a failed run used to share exit code 1, and a wrapper could not tell them apart. That matters because the right response is opposite: a failure is not improved by trying again, and a rate limit is not improved by anything else. A harness that re-ran on 1 hammered a limited provider with the same request; one that gave up on 1 abandoned a run that only needed twenty minutes.

75 is `EX_TEMPFAIL` from the sysexits convention — "temporary failure, try again later" — which is what mail systems and job schedulers have meant by it for decades, so a wrapper written against that convention already does the right thing.

A request rejected before generation can be retried after its rate limit clears.
A lost response can leave its usage unknown. Its checkpoint remains available,
but the shared [token budget](../sdk/token-budgets.md) retains the outstanding
request and blocks further model calls. Waiting for the provider does not reset
that accounting state; a resumed run can stop with code 1 and `token_budget`.

## What the run prints when it stops early

Stdout gets whatever text the model had produced, so a caller who piped it has what there is. Stderr gets one bounded description: the kind of interruption, the provider's reason when it differs, the retry delay when the provider gave one, the hint from the failure catalogue, and for a pause the checkpoint id. The non-zero code is what keeps the partial text from being mistaken for a complete one.
