---
type: Reference
title: Exit codes of a headless run
description: What $? says after namzu run — a reply, a failed or unfinished turn, a paused turn that kept a checkpoint or a session whose turn is still active, a missing prompt, a wrong argument, an untrusted folder, a run stopped by a signal — and what a wrapper should do with each.
resource: packages/cli/src/commands/run.ts
tags: [cli, headless, exit-codes]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-05T00:00:00Z }
---

# Exit codes of a headless run

`namzu run` is built to be called by something that is not a person: a script, a cron job, a benchmark harness. That caller reads two things, the text on stdout and `$?`, and the exit code has to carry every distinction the caller would act on differently.

When the kernel settles, stdout uses its final result, including an explicitly
empty result after an output guardrail. Intermediate narration and answers later
rejected by verification are not concatenated into that result. The JSON
formatter uses the same value in `text`. A provider failure or pause without a
settled result may still return streamed partial text, with the nonzero exit and
stderr explanation below.

Repeatable `--gate` commands review proposed prose answers and return failures
for correction. See [Answer verification](../sdk/verification.md) for scope and
limits: a normal reply is not automatic proof that every task requirement has
been independently checked, and budget/cancellation can stop verification.

| Code | Meaning | What a wrapper does |
| --- | --- | --- |
| 0 | The turn finished and the text on stdout is the whole reply. | Use the output. |
| 1 | The turn failed, or stopped before it was finished: a provider error, an iteration cap, a token budget, a cancellation, a refused answer. Any text on stdout is partial and stderr says why. | Treat the output as incomplete. Re-running blindly repeats the same stop. |
| 2 | No prompt was supplied. | Fix the invocation. |
| 64 | An argument was wrong. | Fix the invocation. |
| 75 | Try again later. Either the provider paused the turn — a rate limit or an outage — and the kernel kept a checkpoint, named on stderr, with any text on stdout partial; with `--wait-for-provider` the turn waits and attempts resume first, and 75 means its provider wait could not complete. Or the session already has an active turn — running, paused, or left interrupted by a process that died — and nothing ran; stderr names that turn and says `turn_in_progress`. | For a pause, use the provider's retry delay or a wait budget; resume still requires a resolved token ledger, and waiting cannot resolve unknown request usage. For an active turn, wait for it, or resume or abandon it (`/resume`, `/abandon` in the TUI), or use another session. |
| 77 | The folder has not been trusted and nothing ran. | Trust the folder once interactively, or pass `--trust` for this invocation. |
| killed by SIGTERM, SIGHUP or SIGINT (a shell shows 143, 129, 130) | The run was stopped from outside. It gave the session's writer lease back before it died, so the turn it was running is left **interrupted**, not closed, and stderr names the session. | Close the turn with `/abandon`, or continue it with `/resume` or `namzu drain`. Any of them works at once; nothing waits for the lease to expire. |

## Why a pause is not a failure

A paused turn and a failed turn used to share exit code 1, and a wrapper could not tell them apart. That matters because the right response is opposite: a failure is not improved by trying again, and a rate limit is not improved by anything else. A harness that re-ran on 1 hammered a limited provider with the same request; one that gave up on 1 abandoned a turn that only needed twenty minutes.

A session with an active turn is the same kind of condition, which is why it shares 75. A session has at most one active turn, so a second `namzu run` against it is refused rather than interleaved with the first; nothing is lost, and the same command succeeds once the active turn settles or is closed.

75 is `EX_TEMPFAIL` from the sysexits convention — "temporary failure, try again later" — which is what mail systems and job schedulers have meant by it for decades, so a wrapper written against that convention already does the right thing.

A request rejected before generation can be retried after its rate limit clears.
A lost response can leave its usage unknown. Its checkpoint remains available,
but the shared [token budget](../sdk/token-budgets.md) retains the outstanding
request and blocks further model calls. Waiting for the provider does not reset
that accounting state; a resumed turn can stop with code 1 and `token_budget`.

## A run stopped by a signal

A turn holds its session's writer lease for as long as it runs, renewed five
minutes at a time. A process that died holding it used to block the session
for up to those five minutes: `/resume`, `/abandon` and the next prompt were
refused as "leased by a live writer" although nothing was writing.

On SIGTERM (a supervisor stopping it), SIGHUP (its terminal closed) or SIGINT
(Ctrl+C at the shell), `namzu run`, `namzu run-stream` and the TUI now give
every lease the process holds back first, then stop the turn and close the
session, bounded to a few seconds, and then die of the signal they were sent,
so the caller sees the usual status. A second signal exits at once. Nothing is
appended for the turn on the way out, because the dying process cannot know
how far it got: the turn reads as interrupted (no live lease, not paused), and
the next writer closes it explicitly. The TUI's next prompt does that on its
own, recording `turn_failed` with `failure.code: 'interrupted'`.

SIGKILL runs no code, so a process killed that way, or one that crashes
outright, still holds its lease until it expires. See
[Session log](../sdk/session-log.md#a-writer-that-stops) for why an expired
lease, and not a check that the holder's process is gone, is what frees it.

## What `namzu run` prints when a turn stops early

Stdout gets whatever text the model had produced, so a caller who piped it has what there is. Stderr gets one bounded description: the kind of interruption, the provider's reason when it differs, the retry delay when the provider gave one, the hint from the failure catalogue, and for a pause the checkpoint id. The non-zero code is what keeps the partial text from being mistaken for a complete one.
