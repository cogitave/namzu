---
'@namzu/sdk': major
---

**Breaking:** `ActiveNodeInfo` and `BranchStackEntry`, and the `activeNode` / `branchStack` checkpoint fields that carried them, are removed.

Both types described where a multi-node run stood — which agent was active, how deep, what each branch decided — and nothing ever wrote either one. `CheckpointManager.save` accepted them as optional `extra` arguments no caller passed, so every checkpoint ever written left both `undefined`, and a resume that consulted them would have found nothing to consult.

Resuming a fan-out is already covered, and by a general mechanism rather than a topology-specific one: delegation blocks and returns the worker's output as its own tool result, so a delegation is an ordinary tool call whose completion the transcript records — and the crash-resume path that answers already-executed tool calls answers delegations too. A worker that already ran does not run twice. That behaviour is now pinned by tests, so if delegation ever stops blocking, they fail.
