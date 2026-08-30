---
uid: namzu.conventions.declared-but-undriven
title: A declaration nothing drives is a defect, not a roadmap
description: A field, option or type that is declared, exported and read by no code path is not a feature pending. It is a lie the type system tells, and fourteen instances shipped in a single week.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-30
tags: [convention, api-design, types]
verified:
  - by: process:conventions-migration
    at: 2026-08-07T00:00:00Z
---

# A declaration nothing drives is a defect, not a roadmap

Ratified 2026-08-04, from three sessions that each found the same shape.

A field, option or type that is declared, threaded through the type system,
exported publicly, and read by no code path is not "a feature not built yet".
It is a **lie the type system tells**, and it costs more than the missing
feature would: a caller sets it, gets no error, and believes the thing is on.

## The rule

Before shipping a declaration, name the code that reads it. If you cannot, do
not ship it. If it is already shipped and nothing reads it, either drive it or
remove it — and say which, in the changeset.

An audit that finds these is a `config field → reader count` grep. Zero readers
is the finding.

## What it looked like, fourteen times in one week

- `SandboxExecOptions.signal` — declared, documented with the exact failure it
  prevents, honoured by **no backend**. So the failure its own docstring
  described (a stop could only ever abandon the *wait*) was what always
  happened. **Repaired**, and the repair is what `resource` above points at:
  a regression test that drives the real provider, because a stub asserting
  "the signal was passed along" would have passed against the broken code. The
  every shipped backend now either terminates locally or uses a separate
  reserve/cancel ownership protocol that confirms the remote process group is
  gone before reporting cancellation. Older remote images are detected and a
  signal is refused rather than forwarded to the *wait* — see
  [Refuse, do not silently degrade](refuse-do-not-degrade.md).
- `ThinkingConfig.display` — on the type, never serialized into the request.
  And its values were wrong: `'full'` was not a value any driver accepted.
- `runtimeToolOverrides` — honoured at two call sites, ignored at the third,
  which was the one a host would most want.
- `AgentManager.queueMessage` / `drainMessages` — a mid-run message queue the
  loop never drained.
- `ToolCatalogSurface` / `ToolsetPolicy.surfaces` — no producer, no reader,
  shipped in two minors before removal.
- `create_task` on an empty roster — mounted, unsatisfiable, advertised every
  turn.
- `PrepareStepResult.activeTools` — documented as the way to withhold a tool
  from a surface where neither `prepareStep` nor `activeTools` exists.

## Why "roadmap" is the wrong frame

A roadmap item is absent. A declared-and-undriven field is *present and
wrong*: it type-checks, autocompletes, appears in the docs, and survives review
because reviewers read the declaration and assume the wiring. Every instance
above passed review.

## The tell

The comment on the declaration usually describes the failure it prevents. When
nothing drives it, that comment is a precise description of what your users are
experiencing.

## Related

- [Refuse, do not silently degrade](refuse-do-not-degrade.md) — the same
  failure seen from the caller's side.
- [Mutate every test](mutation-check-every-test.md) — how these survive a
  green suite.
- [Reachability is its own property](reachability-is-its-own-property.md) —
  the case where the reader exists and the road to it does not.
