---
uid: namzu.conventions.a-check-that-cannot-fail
title: A check that cannot fail is worse than no check
description: A guard placed where its condition can never be false protects nothing, and it teaches the next reader that the checks in this file are decoration — so the one that matters gets skimmed too.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-07
resource: packages/cli/src/integrations/subagents/runtime.ts
tags: [convention, verification, code-review]
---

# A check that cannot fail is worse than no check

A guard placed where its condition can never be false does not protect
anything. It costs a reader's attention, and it teaches the next person that
the checks in this file are decoration — so the one that matters gets skimmed
too.

When adding a guard, name the input that makes it fire. If you cannot, either
the guard belongs somewhere else or the situation it imagines does not exist
yet. Write a comment saying what would make it real, and leave the call out.

## The incident

`@namzu/sdk` 14.0.0 gave `Project` a status and made spawn and both handoffs
refuse an archived workspace. Two call sites in the CLI create sessions
directly through the store, bypassing that gate. They look identical and are
not:

- The session store reads the project id back out of `.namzu/cli.json`, so from
  the second run in a directory onward it attaches to a project it did not
  create. The gate is real there and was added.
- The subagent runtime builds a fresh store four lines earlier and its project
  two lines earlier, neither outliving the call. A freshly created project is
  always open, so the gate could never fire. It was left out, with a comment
  naming what would make it real: a persistent store, or a project id arriving
  from a caller.

Establishing which case each site was in took one reading and changed the
answer for one of them.

## The sharper form

The same rule catches a test that cannot fail. A test whose assertion holds
under the bug it was written for is the same object: something that looks like
a check and is not.

## Related

- [Mutate every test](mutation-check-every-test.md) — how you establish that a
  check can fail, rather than arguing that it can.
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — a guard that cannot fail because its precondition was defaulted away.
