---
type: Reference
title: The review policy
description: The five modes a turn resolves tool review under, which calls skip review, and how a host supplies the person to ask.
resource: packages/sdk/src/runtime/query/review-policy.ts
tags: [sdk, hitl, permissions]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The review policy

An authorization rule says what a tool may do. A review policy resolves calls the gate routed to review, either because no rule covered them or because a matching rule requested review. Calls already allowed or denied by the gate never reach it, so a mode cannot reopen a denial.

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

`policy` is an `ApprovalPolicy` whose `name` is the mode, so a durable log can say which one approved a call. Swap it on a turn's `SessionApprovalPolicy` to change mode without ending the turn. `createReviewHandler` returns only the `ResumeHandler`.

The prompt receives the originating `turnId` alongside `toolCalls`. Hosts can use this exact identifier to attribute concurrent child reviews; tool names or arguments are not ownership evidence. The field is optional for custom prompt callers, but `createReviewHandler` always supplies it.

# The modes

| Mode | Calls routed to review |
| --- | --- |
| `prompt` | Ask the person. The default when a `prompt` is supplied. |
| `auto` | Approve. The default without one. |
| `accept-edits` | Approve a batch of non-destructive `edit` and `write` calls; ask when anything else rides along, because the batch is reviewed as a unit. |
| `plan` | Refuse every mutation with `PLAN_MODE_REFUSAL`, which tells the model to present its plan. A batch of reads that is here only for a path outside the roots is asked about instead, as in `prompt`. The kernel's `permissionMode: 'plan'` is the floor under this. |
| `strict` | Refuse with `STRICT_MODE_REFUSAL`: nothing runs unless a rule allowed it. |

A plan-approval request is approved and every other checkpoint continues. An answer of `approve-all` is remembered in the `remembered` box for the rest of the turn; a host that shows that state passes its own box.

# Which calls skip review

`isReviewExempt(registry, name, input)` says yes for a tool that declares itself read-only and is trusted to say so (`isTrustedReadOnly`, the authorization gate's own predicate) and for the bookkeeping writes in `REVIEW_EXEMPT_WRITES`: `task_create`, `task_update`, `update_goal`. It says no for a `network` tool even when read-only, because the request leaves the machine to an address the model chose, and for a tool the registry does not know. `batchNeedsReview` is the batch rule: any explicit review request, destructive call or non-exempt call means the batch is reviewed.

The built-in `job` classifies each prepared action: reading/listing owned output
is exempt by default; stopping work is not. `DefineToolOptions.readOnly` supports
typed input predicates for other mixed-purpose host tools.

A `custom_pattern` authorization rule can explicitly return `review`. Matching
calls retain `authorization.explicitReview: true` in `ToolCallSummary`, including
durable review requests. That marker prevents read-only and accept-edits
exemptions from silently resolving the request. The selected review policy still
decides: prompt modes ask, strict/plan refuse, and auto or remembered approval
can approve. Existing scoped tool grants remain prior approval; a deny rule still
outranks them. Custom hosts providing their own handlers own those decisions.

# Escalated calls

A call carrying `ToolCallSummary.escalation` — a path outside the turn's roots, or a request to leave the sandbox — is always reviewed: `batchNeedsReview` is true for it and `accept-edits` does not approve it alone. A path outside the roots is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and refused with `OUTSIDE_ROOTS_UNATTENDED_REFUSAL` when there is no `prompt`. A sandbox escape is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and approved only with its id in `confirmedEscalations`; with no `prompt` it is refused with `SANDBOX_ESCAPE_UNATTENDED_REFUSAL` unless `unattendedSandboxEscape: 'allow'`. See [Crossing the tool boundary](escalations.md).
