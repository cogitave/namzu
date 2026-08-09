---
uid: namzu.conventions.refuse-do-not-degrade
title: Refuse, do not silently degrade
description: A capability that quietly does nothing produces an answer that looks like an answer, leaving the caller no signal to tell a considered result from a request that was dropped on the floor.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, error-handling, api-design]
---

# Refuse, do not silently degrade

Ratified 2026-08-04, from two sessions.

When a request cannot be honoured, say so. A capability that quietly does
nothing produces an answer that looks like an answer, and the caller has no
signal to distinguish "the model chose not to" from "nobody asked it to".

## The rule

If you cannot do what was asked:

1. **Error, naming who refused and what to do instead.** In a multi-driver
   setup, "which one refused" is the difference between a bug report about the
   model and a one-line config fix.
2. **Or omit the capability entirely**, so it is never offered.
3. **Never accept and drop.**

Turning something OFF is not a refusal — a config shared across backends saying
`{ type: 'disabled' }` must not fail on the ones that were never going to do it
anyway.

## Degrading is worse than failing when the degradation is invisible

Five drivers accepted `thinking` and dropped it. The caller got an ordinary
completion with an empty `reasoning` array — indistinguishable from a model
that reasoned and had nothing to show. One driver refused instead, with the
reasoning written out beside it. The rule had been decided once and applied
once while five siblings stayed silent, which is why it now lives in the SDK
where a new driver inherits it.

## Omission is a legitimate refusal, and sometimes the better one

Two shapes, both correct, chosen by what the caller can act on:

- **`create_task` on an empty roster is not mounted.** Mounting it with a
  schema nothing satisfies reaches the same verdict the expensive way: the
  model is shown a tool every turn and pays a turn to discover it cannot use
  it. Not offering a capability is cheaper than denying it per call.
- **A `disabled` thinking request on a model that cannot stop thinking omits
  the field.** Throwing teaches nothing the driver's own rejection would not,
  and it breaks a caller whose config spans models.

## Do not fake a refusal you cannot perform

Aborting a request is not cancelling the work. A remote sandbox backend that
"honoured" `signal` by aborting the transport call would abandon the *wait*
while the command kept running — the exact failure the option exists to
prevent, wearing the appearance of a fix. Those backends ignore it and say so
in the source, so the next reader does not "fix" it by wiring the transport's
own signal through.

## Refuse an ambiguity rather than guessing at it

Two sources contributed one tool name and nothing ranked them. Warn-and-replace
is a fine registry default and the wrong answer for a contract surface: the
model keeps a tool whose behaviour depends on registration order. Refusing, and
naming both escape hatches in the error, is the fail-safe reading.

## Related

- [A declaration nothing drives is a defect](declared-but-undriven.md)
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — the same rule where the thing being degraded is a precondition.
