---
'@namzu/sdk': minor
---

The auto-review classifier now sees how each earlier call ended, and the working tree before a git command that can destroy local work.

- `ToolMessage` has an optional `outcome` (`ToolResultOutcome`: `interrupted`, `rejected`, `blocked_by_permissions`, `blocked_by_auto_mode`, `auto_mode_unavailable`), written by the executor where it makes the result of a call that did not simply run. `createToolMessage` takes it as a fifth, optional argument. The classifier's transcript shows each earlier call's ending in words (`ok`, `error`, `interrupted`, `rejected by the person`, ...), read from these fields and never from the result's text, so a call that comes back after a person's no or a block is judged as a second try.
- `ResumeContext.gitStatus(line, dialect)` and `AutoReviewRequest.gitStatus` carry `git status --porcelain --branch` (capped, read with a 2 second deadline in the folder the command runs in) for a hard reset, a forced clean, a checkout or restore over changes, a forced push, a forced branch deletion, a dropped or cleared stash, and a rebase. Nothing is attached when the folder cannot be known from the line or git does not answer.
- `AutoReviewLimits.noVerdict` (off unless set) counts answers in a row that were no verdict. The block that completes the run carries `noVerdictLimitReached`, and the review policy then refuses the batch, calls the new `ReviewPolicyOptions.onClassifierUnavailable`, and ends the turn, with or without a person to ask.
- A call held back because the check gave no verdict is now told `autoReviewUnavailableFeedback(reason)` ("Auto mode could not check this action: ... it may be tried again") instead of the block text. A host that matched on the text "Blocked by auto mode:" to find every auto mode refusal should also match `AUTO_REVIEW_UNAVAILABLE_PREFIX`, or read `ToolMessage.outcome`.

Nothing else changes for a host that sets none of the new options.
