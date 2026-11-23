---
"@namzu/sdk": minor
---

A review policy in `classify` mode no longer refuses a call just because the safety check could not be completed when a person can be asked. With a `prompt`, an `unavailable` or `unreadable` answer from the classifier now puts the question to the person (as `prompt` mode would) and calls the new `onClassifierFellBack({ reason })`; it is not a refusal and does not count toward `noVerdictLimitReached`. With no `prompt` nothing changes: the call is refused and a run of `limits.noVerdict` answers still ends the turn. A host that relied on the old refusal for an attended session should leave `prompt` out, or ignore the question.

The classifier's `reason` for an unavailable check now names the class of failure in brackets (`could not be completed (provider returned 400)`, `(timed out after 60 s)`, `(no credential for the check model)`), exported as `describeCheckFailure(error, deadlineMs?)`; the provider's own message is logged at `warn`, never put in the reason. Anything that matched the old sentence word for word must match its start.

A per-call refusal that ends the turn (`endTurn`) and did not come from a person (no `declined`) no longer cancels calls already running or the calls of the batch that need no review (a read or search a rule allows); it refuses only what would have needed a question. A person's No, an abort and the turn's own cancellation still cancel running calls. A check that could not be completed no longer counts toward the consecutive and total block limits that take auto mode away; the `noVerdict` limit is its own.

`wait_for_job` returns the job's exit as typed command facts (`{ kind: 'command', jobId, exitCode }`) and the turn's outcome record reads it as the result of the background check the job runs, so a check that failed and then passed as a background job is a pass, not an old failure.
