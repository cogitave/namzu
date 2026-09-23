---
type: Reference
title: Tool handoff
description: How a tool stops the turn for a person — ToolResult.handoff, the checkpoint and turn_paused it produces after the batch is committed, resuming from it, and why a delegated child fails instead.
resource: packages/sdk/src/runtime/query/iteration/phases/handoff.ts
tags: [sdk, tools, hitl, checkpoints, session-log]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# Tool handoff

Some results need a person before the turn can go on: a sign-in page, a
CAPTCHA, a second factor, a prompt only the operator may answer. The model must
not try to answer those itself, and calling it again with the result invites it
to try. A tool says so with `ToolResult.handoff`:

```ts
import type { ToolHandoff, ToolResult } from '@namzu/sdk'

const handoff: ToolHandoff = {
	kind: 'human-required',
	reason: 'Sign in to example.test in the browser window, then continue.',
	detail: { origin: 'https://example.test' },
}

const result: ToolResult = {
	success: false,
	output: 'The page is a sign-in form.',
	error: 'sign-in required',
	handoff,
}
```

`reason` is operator-facing text: what the person has to do. `detail` holds
string facts a host may render or act on, such as an origin or a command.

## What the kernel does

The result is handled like any other. The whole batch runs, and every result in
it, the one that asked and its siblings, is appended to the transcript and
queued for the session log. Then, instead of the next model call, the kernel:

1. writes a checkpoint of that state (`checkpoint_written`, and the live
   `checkpoint_created` event);
2. ends the segment with `turn_paused`, whose `reason` is the handoff's reason
   and whose new optional `handoff` field is the `ToolHandoff` itself;
3. returns the turn with `stopReason: 'paused'`.

In the session log the order is: the batch's `message` records (role `tool`),
then `checkpoint_written`, then `turn_paused`. The pause is durable. A process
killed straight after it leaves a turn that another process resumes.

When several results in one batch carry a handoff, the first one speaks for the
batch. A person who comes to look answers both.

A handoff pause has no open decision (`decision_requested`), so nothing needs
approving. `resumeSession` (the CLI's `resumePaused`) continues it exactly as
it continues a pause after a provider failure: from the checkpoint, under the
same `turnId`, and the next step is a model call that sees the results. No tool
in the batch runs again.

Hosts see the field on every surface that carries `turn_paused`: the
`SessionEvent`, the `turn_paused` session-log record, the SSE bridge
(`turn.paused` with `handoff`) and the A2A bridge (in the status update's
metadata). The AG-UI adapter does not forward it.

## Inside a delegated child

A turn with a `parentSessionId`, which is a sub-agent's turn, has nobody
watching it to resume it, and its parent is waiting on a result. There a
handoff fails the child's turn instead of pausing it: `turn_failed` with a
non-retryable `tool_error` whose message is `<tool> needs a person: <reason>`.
The parent gets an ordinary failed child result, `status: 'failed'` with that
message as `lastError`, which its model can read and act on. For example, it
can tell the operator.

## In the CLI

- The interactive terminal shows the reason and `press Enter to continue · Esc
  to stop`. Enter on an empty composer resumes the turn, and Esc abandons it,
  as `/abandon` does. `/resume` also continues it.
- `namzu exec` prints `Turn paused — needs you: <reason>` with the checkpoint;
  `--json` carries `handoff` on the `paused` event.
- A scheduled run records `awaiting-approval` with the reason. See
  [Scheduled tasks](../cli/scheduled-tasks.md#approvals).
