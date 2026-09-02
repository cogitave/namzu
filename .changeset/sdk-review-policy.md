---
"@namzu/sdk": minor
---

The review policy: what a run does with the calls no rule decided.

- **`createReviewPolicy({ mode, prompt, exempt | registry, remembered })`** — an `ApprovalPolicy` named after its mode, and **`createReviewHandler`** for a host that wants only the `ResumeHandler`. Five modes: `prompt` (ask the person the host supplies), `auto`, `accept-edits` (approve a batch of non-destructive `edit`/`write` calls, ask when anything else rides along), `plan` (refuse every mutation with `PLAN_MODE_REFUSAL`, the words that make the model present a plan), `strict` (refuse with `STRICT_MODE_REFUSAL`). A plan-approval request is approved and every other checkpoint continues. Only calls the gate routed to review reach it, so a mode can never reopen what a rule closed.
- **`isReviewExempt(registry, name, input)`** — the calls that skip review: a trusted read-only declaration or one of `REVIEW_EXEMPT_WRITES` (`task_create`, `task_update`, `update_goal`); never a `network` tool, never a tool the registry does not know. **`batchNeedsReview(toolCalls, exempt)`** — the batch rule.
- Types `ReviewMode`, `ToolReviewRequest`, `ToolReviewAnswer`, `ToolReviewPrompt`, `ReviewPolicyOptions`, `ReviewExemption`; constants `REVIEW_MODES`, `ACCEPT_EDITS_TOOLS`.

Nothing existing changed. The kernel's `permissionMode: 'plan'` stays the execution-time floor; `createReviewPolicy({ mode: 'plan' })` is the review-time counterpart that gives the model feedback instead of an error.
