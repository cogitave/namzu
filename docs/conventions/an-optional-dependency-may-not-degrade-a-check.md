---
uid: namzu.conventions.an-optional-dependency-may-not-degrade-a-check
title: An optional dependency may degrade a feature, never a check
description: A call site reading an optional method with a default has decided what its absence means. For a feature that is fine; for a precondition it turns "I cannot establish this" into "this is satisfied".
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-07
resource: packages/sdk/src/manager/project/lifecycle.ts
tags: [convention, api-design, verification]
---

# An optional dependency may degrade a feature, never a check

Marking an interface method optional is right when the cost of requiring it
falls on implementors: a host with its own store should not stop compiling
because the SDK grew a method. But a call site that reads an optional method
with a default has decided what its absence means. For a feature that is fine.
For a precondition it converts "I cannot establish this" into "this is
satisfied", which is the strongest possible wrong answer.

Where a dependency the check needs is absent, refuse and name it. A caller who
gets an error can implement the method or take another route; a caller who gets
a false pass finds out later, from the damage.

## The incident

`@namzu/sdk` 14.0.0 shipped archival that refuses rather than cascading: a
workspace holding a live session throws instead of closing over running work.
`ProjectManager.archive` read the session list through an optional store method
with `?? []` as the fallback. On a store not implementing it, the workspace
closed over live sessions and the call returned success — the refusal the whole
feature exists for was skippable by not implementing one method.

Both halves were individually correct. Three store methods were made optional
in the same change for exactly the right reason, and one method away in the
same file `write()` already threw when its optional dependency was absent. Only
the combination was wrong.

## Related

- [Refuse, do not silently degrade](refuse-do-not-degrade.md) — the general
  form. This is its precondition case, where the degradation is a false pass.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — a defaulted precondition is one way a guard stops being able to fire.
