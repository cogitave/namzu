---
type: Reference
title: The review policy
description: The five modes a run resolves undecided tool calls under, which calls skip review, and how a host supplies the person to ask.
resource: packages/sdk/src/runtime/query/review-policy.ts
tags: [sdk, hitl, permissions]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The review policy

An authorization rule says what a tool may do. A review policy says what happens to the calls the rules did not cover: the batch the gate routed to review. Only those calls reach it, so a mode decides the undecided and can never reopen what a rule closed.

# Build one

```ts
import { createReviewPolicy, ToolRegistry, type ToolReviewPrompt } from '@namzu/sdk'

const registry = new ToolRegistry()
const prompt: ToolReviewPrompt = async ({ toolCalls }) => {
  // Show the calls to the person; return what they decided.
  return toolCalls.length > 0 ? { kind: 'approve' } : { kind: 'reject', feedback: 'nothing to run' }
}

const policy = createReviewPolicy({ mode: 'accept-edits', prompt, registry })
```

`policy` is an `ApprovalPolicy` whose `name` is the mode, so a durable log can say which one approved a call. Swap it on a run's `RunApprovalPolicy` to change mode without ending the run. `createReviewHandler` returns only the `ResumeHandler`.

# The modes

| Mode | Undecided calls |
| --- | --- |
| `prompt` | Ask the person. The default when a `prompt` is supplied. |
| `auto` | Approve. The default without one. |
| `accept-edits` | Approve a batch of non-destructive `edit` and `write` calls; ask when anything else rides along, because the batch is reviewed as a unit. |
| `plan` | Refuse every mutation with `PLAN_MODE_REFUSAL`, which tells the model to present its plan. The kernel's `permissionMode: 'plan'` is the floor under this. |
| `strict` | Refuse with `STRICT_MODE_REFUSAL`: nothing runs unless a rule allowed it. |

A plan-approval request is approved and every other checkpoint continues. An answer of `approve-all` is remembered in the `remembered` box for the rest of the run; a host that shows that state passes its own box.

# Which calls skip review

`isReviewExempt(registry, name, input)` says yes for a tool that declares itself read-only and is trusted to say so (`isTrustedReadOnly`, the authorization gate's own predicate) and for the bookkeeping writes in `REVIEW_EXEMPT_WRITES`: `task_create`, `task_update`, `update_goal`. It says no for a `network` tool even when read-only, because the request leaves the machine to an address the model chose, and for a tool the registry does not know. `batchNeedsReview` is the batch rule: any destructive or non-exempt call means the batch is reviewed.
