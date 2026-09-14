---
"@namzu/sdk": major
"@namzu/cli": major
---

Background job `read` and `list` calls now count as read-only observations by default; starting commands and `job kill` retain their existing approval requirements. SDK `defineTool` accepts an input predicate for `readOnly`.

Explicit CLI `ask` rules are now enforced rather than omitted, so they can request review ahead of a wildcard allowance or the read-only default. SDK custom-pattern rules support `decision: 'review'`, with an `authorization.explicitReview` marker on review summaries. Read-only and accept-edits exemptions honor it; explicit auto modes and prior approvals keep their meaning.

To keep reviewing every background-job operation in prompt mode, configure `permissions: { job: ask }`, or supply a matching SDK custom-pattern review rule. If an old `ask` entry was intended to inherit default behavior, remove that entry instead. Deny rules, plan-mode mutation restrictions, job ownership and sandbox boundaries remain enforced.
