---
type: Reference
title: Answer verification
description: Command-backed answer review, interrupted checks, cancellation and the distinction between settled and verified work.
resource: packages/sdk/src/run/command-gate.ts
tags: [sdk, harness, verification]
status: stable
---

# Answer verification

A settled run and a verified objective are different facts. `Run.status` describes
execution; `stopReason` records why it stopped. A model's closing answer is a claim,
and passing tests establish only the behavior those tests cover. Acceptance checks
should be independently derived from the task's requirements and current state.

`reviewAnswer` examines a model's proposed prose answer and can return
`{ accept: false, feedback }` to request another iteration. The feedback is runtime
context, not a new operator instruction. `maxAnswerReviews` bounds the permitted
rejections; exhaustion stops with `answer_rejected`. `AnswerReviewContext.signal`
carries run cancellation and should be forwarded to verification operations.

```ts
import { createCommandGate } from '@namzu/sdk'

const reviewAnswer = createCommandGate({
  commands: ['pnpm typecheck', 'pnpm test'],
  cwd: process.cwd(),
  maxRetries: 3,
  timeoutMs: 60_000,
  maxOutputChars: 4_000,
})

// Supply reviewAnswer and maxAnswerReviews: 3 to query() or drainQuery().
```

The command gate runs operator-supplied shell commands in order and stops at the
first failure. Default command timeout is ten minutes; default execution attempts
are three. The model does not supply these commands. Custom executors own their
containment and must honor the timeout and cancellation options they accept.
The default executor owns its local process group and receives run cancellation.

Every command must finish with exit zero and no termination receipt. A process
that handles a timeout or cancellation by exiting zero has not completed the
verification. Executor exceptions become rejection feedback, so an unavailable
verifier cannot become an accepted answer through the generic hook's exception
path. If cancellation arrives during review, the run remains cancelled.

After a normal failed check, a workspace fingerprint can avoid an identical retry.
An unavailable or throwing fingerprint means the command may run again; it never
means success. Interrupted checks and executor failures are not cached as stable
source failures. The detector includes the Git commit and Git-visible uncommitted
state, so committing a fix cannot look like the previous clean commit. Interrupted
Git commands cannot establish a fingerprint even when they exit zero. It excludes external
services, ignored artifacts or every possible input to a command. It is an
optimization, not proof that two verifications must have identical outcomes.
Use a custom `fingerprint` that includes the command's relevant inputs, or returns
`null` to always run checks, when verification depends on state outside Git.

`maxOutputChars` is a nonnegative safe integer. The clipped diagnostic, including
its omission marker, stays within that allowance. Zero suppresses the diagnostic
body; short positive allowances may contain only an ellipsis. The surrounding
feedback also names the command and failure, so this option is not a cap on the
entire review message. Custom executors must separately bound captured output.

## Scope and limits

Review is called on ordinary prose completion. Forced finalization, terminal tools
and structured-output settlement have separate paths; `reviewAnswer` is not an
unbypassable objective-verification boundary. Generic custom review hooks still
fail open on an exception, and an uncooperative asynchronous hook can delay
cancellation. The built-in command reviewer contains command/fingerprint errors
and forwards cancellation, but cannot make arbitrary host callbacks cooperative.

The CLI's headless `run` and `run-stream` commands accept repeatable `--gate`
commands and `--gate-retries`; the TUI does not automatically install this gate.
Output guardrails can judge the final result across more settlement paths, but
streamed text may already have reached the host. Neither mechanism infers a
complete acceptance specification from arbitrary natural language.

The [cognitive architecture research](cognitive-architecture.md) separates model
assertions, independent behavior checks and proposed executive control. A hidden
test suite that rejects a completion is evidence of a missing behavior, not proof
that memory loss caused it.
