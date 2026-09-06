---
"@namzu/cli": minor
"@namzu/sdk": minor
---

Let the interactive parent respond to new messages while delegated agents continue working. An interrupted delegation wait returns the running task's identity instead of waiting for every child to finish, and eventual results reach the same parent run once. Parent cancellation still stops its children. Cancelled CLI turns retain the kernel's tool and reasoning history so a follow-up can see work already performed.

The model can retrieve a task's complete output using `wait_for_task`, including text beyond a notification's preview. This only accepts tasks owned by the current parent run. Budget-stopped tasks retain available partial prose and report their stop reason.

Add optional `query({ waitForInbound })` arrival notification and cancellable `CompletionInbox.waitForArrival(timeoutMs, signal)` waits. Neither consumes operator messages or cancels child work; callers release arrival listeners when the supplied signal aborts. Task-completion notifications include the child's stop reason when available.

Open child transcripts in a distinct framed terminal screen with more visible history, line/page scrolling and explicit return navigation. Completed children remain readable through `/agents` while retained in the current session. Returning to the main conversation restores its draft.
