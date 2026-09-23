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

A stricter mode than the rules, `plan` above all, cannot refuse what never reaches it: a batch a rule allows, or one a grant from earlier in the turn covers, runs without asking the handler. A host that can be in such a mode passes `reviewAllowedCalls: () => boolean` on `QueryParams`; the kernel asks it once per batch, and `true` sends the batch to the handler anyway, each call carrying the gate's decision in `authorization`. A rule's `deny` still refuses whatever it returns. The CLI answers `true` only while its live mode is `plan`, so a mode entered mid-turn reaches the next batch.

The switch reaches delegated turns too. A child borrows its parent's handler, and without the switch a call covered by an approval given earlier in the CHILD's own turn skipped that handler after the parent had entered plan mode. `AgentTaskContext.reviewAllowedCalls` carries the parent's function to every child and grandchild: `AgentManager` stamps it onto the child config after the `configBuilder` runs (`BaseAgentConfig.reviewAllowedCalls`) and onto the child's own spawn context, `SupervisorAgent` hands its config's value to its workers, and `ReactiveAgent` and `SupervisorAgent` pass it to their `query()`. It is the function, not a sampled answer, so a mode entered while a child runs reaches that child's next batch. A child config that sets its own value keeps it, OR-ed with the inherited one: a descendant can add review, never answer `false` over a parent that answers `true`. A host that builds its own `AgentTaskContext` for a `TaskScheduler` sets the field from the same function it passes its own `query()`.

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

# Calls a skill pre-approved

A skill loaded earlier in the turn can pre-approve calls through its `allowed-tools`. The review phase marks each covered call with `ToolCallSummary.skillGrant = { skill }`, but only when no deny, explicit ask, destructive flag or escalation applies to it. `createReviewHandler` approves a batch without asking when every call it would have asked about carries the mark, and reports those ids in `approve_tools.skillGranted` so the kernel can record each approval in the audit trail under the skill's name. `plan` and `strict` refuse before that check, so a skill never outranks them. `skillGrants: 'ignore'` turns the check off. See [Skills and allowed-tools](skills.md).

# Escalated calls

A call carrying `ToolCallSummary.escalation` — a path outside the turn's roots, or a request to leave the sandbox — is always reviewed: `batchNeedsReview` is true for it and `accept-edits` does not approve it alone. A path outside the roots is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and refused with `OUTSIDE_ROOTS_UNATTENDED_REFUSAL` when there is no `prompt`. A sandbox escape is asked about in every mode that does not refuse it, `auto` and a remembered `approve-all` included, and approved only with its id in `confirmedEscalations`; with no `prompt` it is refused with `SANDBOX_ESCAPE_UNATTENDED_REFUSAL` unless `unattendedSandboxEscape: 'allow'`. See [Crossing the tool boundary](escalations.md).
