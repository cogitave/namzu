---
type: Reference
title: Exit codes of namzu exec
description: What $? says after namzu exec — a reply, a failed or unfinished turn, a paused turn that kept a checkpoint or a session whose turn is still active, a missing prompt, a wrong argument, an untrusted folder, an invocation stopped by a signal — and what a wrapper should do with each.
resource: packages/cli/src/commands/exec.ts
tags: [cli, headless, exit-codes]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-05T00:00:00Z }
---

# Exit codes of `namzu exec`

`namzu exec` (alias `namzu e`) is built to be called by something that is not a person: a script, a cron job, a benchmark harness. That caller reads two things, the text on stdout and `$?`, and the exit code has to carry every distinction the caller would act on differently.

This page is the default mode, which prints the reply. `namzu exec --json`
streams events instead and sorts its exit codes on a different axis; see
[`namzu exec --json`](exec-json.md). Earlier releases called the default mode
`namzu run` and the streaming mode `namzu run-stream`; both names are gone and
the codes kept their meanings.

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
| 64 | An argument was wrong: an unknown option, a `--cwd` that is not a directory, an `--output-schema` file that cannot be read or represented, `--session` without `--json`. | Fix the invocation. |
| 75 | Try again later. Either the provider paused the turn — a rate limit or an outage — and the kernel kept a checkpoint, named on stderr, with any text on stdout partial; with `--wait-for-provider` the turn waits and attempts resume first, and 75 means its provider wait could not complete. Or the session already has an active turn — running, paused, or left interrupted by a process that died — and nothing ran; stderr names that turn and says `turn_in_progress`. | For a pause, use the provider's retry delay or a wait budget; resume still requires a resolved token ledger, and waiting cannot resolve unknown request usage. For an active turn, wait for it, or resume or abandon it (`/resume`, `/abandon` in the TUI), or use another session. |
| 77 | The folder has not been trusted and nothing ran. | Trust the folder once interactively, or pass `--trust` for this invocation. |
| killed by SIGTERM, SIGHUP or SIGINT (a shell shows 143, 129, 130) | The invocation was stopped from outside. It gave the session's writer lease back before it died, and stderr names the session and says where the signal found the turn: mid-flight, the turn is left **interrupted**, not closed; waiting out a provider pause (`--wait-for-provider`), it stays **paused** at the checkpoint stderr names and is not resumed; after it ended (the session still closing, for example a slow `session_end` hook), it is recorded and the reply may already be on stdout. | For an interrupted turn, close it with `/abandon`, or continue it with `/resume` or `namzu drain`; for a paused one, `/resume` or `namzu drain` continues it from its checkpoint. Any of them works at once; nothing waits for the lease to expire. A turn that ended needs nothing. |

## Why a pause is not a failure

A paused turn and a failed turn used to share exit code 1, and a wrapper could not tell them apart. That matters because the right response is opposite: a failure is not improved by trying again, and a rate limit is not improved by anything else. A harness that re-ran on 1 hammered a limited provider with the same request; one that gave up on 1 abandoned a turn that only needed twenty minutes.

A session with an active turn is the same kind of condition, which is why it shares 75. A session has at most one active turn, so a second `namzu exec` against it is refused rather than interleaved with the first; nothing is lost, and the same command succeeds once the active turn settles or is closed.

75 is `EX_TEMPFAIL` from the sysexits convention — "temporary failure, try again later" — which is what mail systems and job schedulers have meant by it for decades, so a wrapper written against that convention already does the right thing.

A request rejected before generation can be retried after its rate limit clears.
A lost response can leave its usage unknown. Its checkpoint remains available,
but the shared [token budget](../sdk/token-budgets.md) retains the outstanding
request and blocks further model calls. Waiting for the provider does not reset
that accounting state; a resumed turn can stop with code 1 and `token_budget`.

## An invocation stopped by a signal

A turn holds its session's writer lease for as long as it runs, renewed five
minutes at a time. A process that died holding it used to block the session
for up to those five minutes: `/resume`, `/abandon` and the next prompt were
refused as "leased by a live writer" although nothing was writing.

On SIGTERM (a supervisor stopping it), SIGHUP (its terminal closed) or SIGINT
(Ctrl+C at the shell), `namzu exec` in either mode and the TUI now give
every lease the process holds back first, then stop the turn and close the
session, bounded to a few seconds, and then die of the signal they were sent,
so the caller sees the usual status. A second signal exits at once. Nothing is
appended for the turn on the way out, because the dying process cannot know
how far it got: the turn reads as interrupted (no live lease, not paused), and
the next writer closes it explicitly. The TUI's next prompt does that on its
own, recording `turn_failed` with `failure.code: 'interrupted'`.

That is what a signal mid-turn leaves. `exec` words its stderr line from where
the signal actually found the turn, because the handler stays installed until
the command returns: a signal while `--wait-for-provider` is waiting finds the
turn recorded `turn_paused` with its checkpoint (the wait ends and the turn is
not resumed), and a signal after the turn settled, while the session is still
closing, finds it recorded `turn_completed` or `turn_failed`, with nothing for
`/abandon` to close.

SIGKILL runs no code, so a process killed that way, or one that crashes
outright, still holds its lease until it expires. See
[Session log](../sdk/session-log.md#a-writer-that-stops) for why an expired
lease, and not a check that the holder's process is gone, is what frees it.

## What `namzu exec` prints when a turn stops early

Stdout gets whatever text the model had produced, so a caller who piped it has what there is. Stderr gets one bounded description: the kind of interruption, the provider's reason when it differs, the retry delay when the provider gave one, the hint from the failure catalogue, and for a pause the checkpoint id. The non-zero code is what keeps the partial text from being mistaken for a complete one.

## A structured answer: `--output-schema`

`namzu exec --output-schema answer.json "<prompt>"` binds the final answer to
the JSON Schema in `answer.json`, through the provider's native structured
output. The path resolves against the directory the command was started in.
The schema must be an object schema the kernel can represent losslessly
(explicit `properties`, `required` and `additionalProperties`); a constraint it
would have to drop is refused rather than discarded. A schema that cannot be
read or represented exits 64 before any session is built.

The settled answer is the JSON text, printed on stdout like any other reply. A
turn that cannot produce a conforming answer within its retries stops with
`structured_output_failed` and exits 1. Passed before the command
(`namzu --output-schema f exec …`) the option is refused, because there it
belongs to the interactive TUI.
