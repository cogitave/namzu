---
uid: namzu.conventions.a-check-that-cannot-fail
title: A check that cannot fail is worse than no check
description: A guard placed where its condition can never be false protects nothing, and it teaches the next reader that the checks here are decoration — so the one that matters gets skimmed too. The same shape reaches assertions, where a matcher can accept the value it exists to reject.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-09
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

## The loose matcher

Amended 2026-08-09.

The forms above are about *placement* — a guard in a spot its condition cannot
reach, a test driving a path the defect is not on. There is a third door, and it
is the quietest, because the placement is right and the path is right:

**the assertion is written with a matcher loose enough to accept the very value
it exists to reject.**

`toContain(old)` cannot detect a change that only **adds around** `old`. If the
new value contains the old one as a substring — appended, prefixed, or wrapped —
the assertion passes on both, so it is not an assertion about the change at all.
It has been met twice in this repository, once from each direction:

- **Prefixed.** A model with no explicit setting was marked `(default)`, which
  reads as the provider's current default and is in fact namzu's own pick out of
  a table compiled into the release. Corrected to `(namzu default)`. The test
  asserting the marker used `toContain('(default)')` — and `(namzu default)`
  contains `(default)`, so the test passed identically before and after. It
  could not have told the two apart in either direction.
- **Appended.** `toContain('/agents')` was meant to prove a command is listed in
  `/help`. It survives renaming the command to `/agentsXX`, because that
  contains it. The fix was to anchor on the whole entry — `/\/agents\s/` — since
  `/help` pads the name and a real entry is the name followed by whitespace.

## The tell, and the test for it

You are asserting on a string, and the change you are pinning **lengthens** it.
That is the moment.

Ask: *is the old value a substring of the new one?* If it is, a substring
matcher proves nothing, and mutation will not tell you — the mutation runs, the
suite stays green, and green is exactly what a passing mutation-restore looks
like when the test is sound. This is the one failure the mutation loop reports
as "kills nothing" when the truth is "cannot kill anything".

The fix is always the same: assert the **whole** phrase, or anchor it. Prefer
matching what a reader would see in full — the complete marker, the complete
line — over the fragment that happens to be distinctive today.

## Related

- [Mutate every test](mutation-check-every-test.md) — how you establish that a
  check can fail, rather than arguing that it can. The loose matcher above is
  the case mutation cannot report, which is why it is written down here as a
  shape to recognise before you run one.
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — a guard that cannot fail because its precondition was defaulted away.
