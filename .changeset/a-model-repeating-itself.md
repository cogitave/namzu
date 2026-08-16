---
'@namzu/sdk': minor
---

The kernel now notices when a model issues the identical tool call over and over, and says so on the next `tool_result`. A mild notice at the third repeat, escalated wording at the fifth, each said once. `repeatCallAdvisory: false` on `query()`/`drainQuery()` opts out.

Nothing observed cross-call repetition before this. The guardrails screen calls in isolation — input at run start, output at run end, one result at a time — so a model re-running a failing command or re-applying a diff that does not apply got no correction from anything in the kernel. The only lever was an operator-configured iteration checkpoint, which fires on a count regardless of whether anything is repeating and needs a human at the other end.

**It advises and never denies**, deliberately. Polling for a build to finish is the same call by design, and a tracker that refused would break that case to fix a different one. What the model lacks is not permission but the observation, which it cannot make about itself: each turn it sees a history, not a count.

"Identical" is decided by the key `ToolGrantSet` already uses, so the same call means one thing across the runtime — arguments differing only in object key order are the same call. The tracker is run-scoped, like the grant set: a count carried into a later run is a claim about work nobody repeated.
