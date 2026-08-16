---
uid: namzu.conventions.reachability-is-its-own-property
title: Reachability is its own property, and it needs its own test
description: A knob can be declared on the config, honoured correctly by the machinery, tested at the layer that honours it, and still be unreachable from the surface a host actually constructs.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-06T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, testing, api-design]
verified:
  - by: process:conventions-migration
    at: 2026-08-07T00:00:00Z
  - by: process:ses_018-sdk-cleanup-and-audit-reach
    at: 2026-08-08T00:00:00Z
---

# Reachability is its own property, and it needs its own test

Ratified 2026-08-06, from two sessions.

Behaviour and reachability are two properties, and covering the first says
nothing about the second. A knob can be declared on the config, honoured
correctly by the machinery, tested at the layer that honours it, and still be
unreachable from the surface a host actually constructs.

Re-established 2026-08-08 after the file in `resource` had its temp-directory
teardown routed through the shared cleanup helper. That change touched three
lines — an import and the body of one `afterEach` — and left the docstring
quoted below byte-identical, so every claim on this page still stands against
the file as it is now. The drift gate is what raised it, and this is the answer
rather than a bumped date: the code moved, and the doc was checked against where
it moved to.

The doctrine is already written in this repository, at the top of the test file
named in `resource` above:

> A feature a consumer cannot reach is a feature that does not exist for
> them, so these assert reachability rather than behavior — the behavior
> already has its own tests one layer down.

That file exists because three config fields shipped inert in one session with
their behaviour fully covered.

## The rule

**Behaviour tests belong one layer down.** They prove the mechanism is right.

**A reachability test drives the front door** — the surface a host constructs,
not the internal the behaviour test builds — and asserts a consequence that
cannot occur without the hop.

**Verify by deleting the hop.** Cut the forward, run typecheck and the suite. If
both stay green, nothing tests the road and the knob is dead. This is a
measurement, not an argument: `allowDelegation` was suspected and confirmed
exactly this way — typecheck clean, 143 tests green, flag completely dead.

## Three that shipped inert, one session

- **`maxToolConcurrency`** — declared on `QueryParams`, honoured by the
  executor, forwarded by `ReactiveAgent`, and absent from
  `SupervisorAgentConfig`. The agent whose entire job is fan-out could not set
  the fan-out gate; the agent that does not fan out could.
- **`CreateTaskOptions.configOverrides`** — worse than unforwarded. It was
  declared and then *overwritten*: `createTask` built its own overrides object
  from the parent span and never read the field.
- **The sibling policy** — `applySiblingPolicy` was complete and correct, and
  only the hop from `SupervisorAgentConfig` was missing, so every host ran
  `'continue'`. Its own tests passed because they constructed the gateway
  directly, which is the fixture failure that lets this class ship.

Also from the same class: `runAgent` dropped the `skills` it was given and had
no `authorizationGate` at all, both hidden behind an `as never` cast on the
kernel seam — and the cast was not load-bearing.

## The trap inside the reachability test

The assertion has to be a consequence **of the hop**, not of the run having
worked. A first draft asserted `status === 'completed'` and passed with the
forwarding deleted, because the run completes either way. The corrected sibling
asserts the cancellation itself — the thing that cannot happen unless the policy
arrived.

A second trap: if a regression makes the test **hang**, it is a bad signal. One
sibling sat until the delegation timeout at 60s; a hang reads as flake, and
flake gets retried rather than read. Given a deterministic gate and a 250ms
safety release, the same regression fails in 302ms with
`expected [] to include 'task_patient'`.

## A remedy is a capability, and it is subject to this rule too

A documented workaround is only real for the callers who can perform it. When
writing *"if you want X, do Y"*, enumerate who hits X and confirm each of them
can do Y.

- **The invocation lock.** The docs prescribed "a host that wants parallelism
  constructs a second instance". True, and unreachable from delegation, where
  the definition owns the instance and the caller holds only an id. The fix was
  the doc's own remedy made reachable — `Agent.forRun()`, returning a fresh
  shell of the same class from the same metadata — not a different remedy.
- **`PrepareStepResult.activeTools`** was documented as the way to withhold the
  delegation tool from a surface on which neither `prepareStep` nor
  `activeTools` exists.
- **The plan-step bindings** named step ids that nothing had ever told the
  caller. A binding whose caller cannot name the thing is a binding that does
  not exist.

## Run it before deleting, too

The same check answers the opposite question, and it has come out both ways.

- **`PlanManager`** was proposed for deletion as dead. It is exported from
  `public-runtime.ts` and `drainQuery` hands it to hosts via
  `onContextCreated`. "Zero callers in this package" is not "zero callers" —
  the callers are hosts, outside the repository. The deletion would have removed
  a working approval gate.
- **`launchedTasks`** got the same check and failed it: a host *could* pass one,
  but nothing ever wrote a host-supplied map, so passing one did nothing and
  reading it back gave an empty map. Inert in both directions, so it went.

"Is this dead?" was the wrong question both times. **"Which half of this is
dead?"** was the right one: the launch signal was live and the accumulator that
consumed it was not.

## The tell

A config type and the type it feeds have different field sets. Or: you can name
the writer and you can name the reader, and you cannot name the road between
them.

## Related

- [A declaration nothing drives is a defect](declared-but-undriven.md) — the
  zero-reader case. Here the reader exists and is correct.
- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  — the same geometry seen from the emitting end.
- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — why `status === 'completed'` is not a reachability assertion.
- [A fixture unlike production tests a system that does not ship](fixture-must-match-production.md)
  — constructing the collaborator directly is how the missing hop stays green.
