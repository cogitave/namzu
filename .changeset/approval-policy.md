---
'@namzu/sdk': minor
---

The approval policy is a run-scoped, switchable, durably-logged value instead of a closure captured at `query()` start.

`ResumeHandler` was read exactly once, when the run began, and from nowhere a host could reach afterwards. So changing from "ask me about every write" to "go ahead, I'm stepping out" meant ending the run — discarding the in-flight step and the context that step was built from, to change one setting. That is the defect `permissionMode` had before it became a box the executor reads through, and this follows the same shape.

New: `ApprovalPolicy` (a named handler), `RunApprovalPolicy` (the box), the `onApprovalPolicy` query parameter that hands a host the box, and the `approval_policy_changed` run event — on the SSE wire as `approval_policy.changed`, and deliberately absent from A2A, where who supervises this host is not the peer's business.

The name is not decoration. A log entry that can only print `[Function (anonymous)]` cannot answer "who approved that, and under what rule" months later. An unattended run is named `auto-approve` by identity against the default handler rather than by presence — `resumeHandler` is required internally, so "is it set" is always yes and would name every run `host`, including the ones approving everything unattended.

A change is recorded **before** it takes effect: swap first and the log reads as approvals that precede the decision permitting them. `reason` is required for the same reason — an optional one is absent exactly when it matters, on the change nobody expected.

Existing callers are unaffected: omit `onApprovalPolicy` and the policy is set once from `resumeHandler` and never changes, which is what happened before.
