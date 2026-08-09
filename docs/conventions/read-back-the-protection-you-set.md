---
uid: namzu.conventions.read-back-the-protection-you-set
title: Read back the protection you set, and refuse if you cannot
description: Asking for a permission is not holding one. A protection must be re-read from the thing it was applied to and refused when the read cannot be made — and because the readback is usually platform-conditional, the predicate has to be pure or it is a check most contributors never see fail.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-09T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, verification, security, cross-platform]
---

# Read back the protection you set, and refuse if you cannot

Ratified 2026-08-09, from the subscription sign-in work.

When you apply a **protection** — a file mode, an access-control entry, an
ownership — do three things, in this order:

1. **Set it.**
2. **Read it back off the thing you set it on**, not off the value you passed.
3. **Refuse if the readback cannot be made**, and destroy what you were
   protecting rather than leaving it.

Asking for a permission is not holding one. `open(path, 'wx', 0o600)` is a
request; a umask, an inherited access-control list, a filesystem that does not
implement modes, or an operating system where the call means something else
entirely can all satisfy the call and not the intent. None of them returns an
error.

## Why this is not just "verify your own claim"

It is the same shape as
[verifying against the store you wrote to](verify-claims-including-your-own.md),
narrowed to the case where the property is a **protection** rather than a
**value**. The narrowing earns its own page because the consequence is
different in kind:

**A wrong value is usually visible. An unset file mode is invisible until it is
somebody else's problem.**

A record that saved with the wrong field is found by the next read, by a test,
by a user noticing. A credential file that saved world-readable behaves exactly
like one that did not — same content, same reads, same everything — until an
account that should never have seen it does. There is no failing path to
discover, so nothing discovers it. That is why the readback has to be a step
rather than a review question.

## Refusing means destroying, not warning

If the protection cannot be established, the artefact must not survive. Not a
warning, not a degraded mode, not a flag — the file is deleted and the caller
is told why.

This is [refuse, do not silently degrade](refuse-do-not-degrade.md) applied to a
secret at rest, and the argument for it is unusually clean: a store that cannot
show it is private is strictly worse than no store, because it takes something
that would otherwise have stayed in memory for one session and commits it to
disk under a guarantee nobody checked. Writing anyway and warning is the worst
of the three — the operator gets the exposure *and* a line of text they will
scroll past.

## The sharp half: a platform-conditional check cannot fail on almost every machine

Here is the part that is easy to get wrong while doing everything above
correctly.

A protection is almost always platform-specific. A POSIX mode means nothing on
Windows; an access-control list means nothing anywhere else. So the readback
gets written inside a platform branch — and **a check inside a platform branch
is a check that cannot fail on every machine but one.**

That is [a check that cannot fail](a-check-that-cannot-fail.md) pointed at a
*platform* axis rather than a logical one, and it is harder to see, because
nothing about the code looks unreachable. The branch is correct. The check
inside it is correct. It simply never executes where you are.

The consequence is about mutation, and it is what makes this worth a rule
rather than a note:

> **A predicate that runs everywhere can be mutated everywhere. A predicate
> guarded by a platform branch cannot.**

So the assertion has to come **out** of the branch. The branch decides which
protection applies and gathers the evidence; a **pure function** decides whether
the evidence is acceptable. The pure function is then tested — and mutated — by
whoever is running the suite, on whatever they are running it on.

```
platform branch  →  gathers the evidence   (spawns, stats, reads an ACL)
pure predicate   →  judges the evidence     (tested on every platform)
```

## The incident

The credential store applies a POSIX mode off Windows and an access-control
list on it, and both are read back.

A mutation run of twenty-two mutations was made against the sign-in work. Two
survived, and one of them was this:

**Deleting the POSIX mode readback killed nothing.** The run was on Windows, so
the branch containing the assertion never executed. The suite was green with
the check deleted. It would have gone red in CI, on a Linux runner — which is
exactly the reassurance that makes this dangerous, because it means the gap is
invisible to the person writing the code and visible only to a machine they are
not watching.

The fix was not to add a Windows test for a POSIX property. It was to extract
`assertOwnerOnlyMode(mode, path)` as a pure function and test it directly:
owner-only accepted, a group bit refused, an other bit refused, an execute bit
refused. Five cases, no platform branch, killed on every machine.

The mirror image is the evidence that the shape is right rather than a
rationalisation. The Windows half was written this way from the start —
`assertSoleOwnerSddl(sddl, sid, path)` takes a descriptor as a string, so the
mutations against *it* (accepting a second entry naming another account;
accepting an inherited list) died immediately, on Windows and everywhere else.
The same rule, applied and not applied, in one file, with the mutation run
telling the two apart.

## Applying it

- Name the evidence the platform branch produces, and make it a value: a mode
  integer, a descriptor string, an owner identifier.
- Put the judgement in a function that takes that value and the path, and
  throws with the path named. No spawning, no `platform()`, no filesystem.
- Test the predicate against the accepting case and **every** rejecting case
  you can enumerate, including the ones your own platform cannot produce.
- Then mutate it. If a mutation survives, you have found the platform axis, not
  a missing test.

## Related

- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — the same defect on a logical axis. This page is the platform axis, which is
  the one a local run cannot report.
- [Mutate every test](mutation-check-every-test.md) — how the incident above was
  found at all. A platform-guarded assertion is one of the few things that
  reports "kills nothing" for a reason other than a weak test.
- [Refuse, do not silently degrade](refuse-do-not-degrade.md) — why an
  unprovable protection deletes the artefact instead of warning about it.
- [Verify the claim, including your own](verify-claims-including-your-own.md) —
  the general rule this one narrows.
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — the neighbouring trap: if the tool that reads the protection back is
  missing, that is "I cannot establish this", never "this is satisfied".
