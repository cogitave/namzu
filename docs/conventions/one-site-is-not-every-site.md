---
uid: namzu.conventions.one-site-is-not-every-site
title: Finding an emitter is not evidence that every path reaches it
description: The mechanism is present, wired, tested and correct, and one of the paths into it does not use it. The check that finds a declaration nothing drives passes cleanly on this one.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-05T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, verification, testing]
verified:
  - by: process:conventions-migration
    at: 2026-08-07T00:00:00Z
---

# Finding an emitter is not evidence that every path reaches it

Ratified 2026-08-05; amended 2026-08-06 with the two-shapes-for-one-concept
variant.

> The question is *which callers arrive here*, not *does this exist*.

The sibling rule catches a declaration **nothing** drives. This one catches a
declaration driven from **one of its sites** — the mechanism is present, wired,
tested and correct, and one of the paths into it does not use it.

That variant is harder, because the check that finds the first one passes on the
second. Grep for the reader, find a reader, conclude it is wired. It is wired.
It is wired *there*.

## The rule

When you verify that a signal, option or hook is honoured, do not stop at the
first honouring call site. Enumerate the paths that reach the behaviour and ask
which of them arrive at that site. A signal emitted on one branch of a fork is
absent on the other, and the absence looks exactly like the presence from where
you were standing.

The grep is not `emits X`. It is `who computes the thing X reports, and do all
of them emit`.

## What it looked like

- **`compaction_completed`** — emitted from the structured working-state path
  only. `applyReducer`, the path taken by any host with its own
  `contextReducer` or `strategy: 'sliding-window'`, emitted nothing on success.
  The docstring said the event existed because a host could not otherwise show
  the user that context was dropped. For a large class of runs it still could
  not. A switch case rendering it would have been correct, complete,
  mutation-proven, and permanently silent.
- **`--cwd`** — reached the session store and the skill search, not the agent
  run. Three consumers, two wired. The agent globbed the launch directory and
  reported the user's files missing.
- **`thinking`** — settable on an agent config and forwarded by no ergonomic
  entry point, because each hand-lists the run-config fields it passes.
- **`activeTools`** — narrowed the request the model saw and not the dispatch
  that executed, so a withheld tool ran when the model named it anyway.

Each had the mechanism present and one path not using it. Each survived a full
green suite, because every test exercised the path that worked.

## A second axis: how many shapes does this concept have?

The four above are one mechanism reached by several paths. There is a second
geometry with the same signature, and it is not covered by asking about paths:
one concept declared as **two types**, each populated by its own mapper that
copies field by field.

`PlanStep.agentId` was added so a human approving a plan could see which agent a
step delegates to. It reached `PlanApprovalRequest` — what a host sees when it
installs its own handler on `PlanManager` — and **not** `PlanApprovalData`,
which is what every `resumeHandler` host receives. That type declared its own
step shape, and both mappers copy field by field, so a new field on the source
propagates to neither on its own.

The change shipped and was tested, and left the busier of the two surfaces
showing `toolName: 'create_task'` and nothing else — so the two delegated steps
the field existed to tell apart stayed identical in every field the approver
could read. The fix was correct, complete, mutation-proven, and landed on the
quieter half.

The repair is now in the tree, and the type carries the incident in its own
docstring — see `resource` above. Read it there rather than trusting this
paragraph.

So the question is not only *which callers reach this emitter*. It is also:
**how many shapes exist for this concept, and did the change reach all of
them?**

A **field-by-field mapper is the tell**. It is a place where adding a field to
the source is guaranteed not to propagate, it is usually written once and never
revisited, and it produces no error when it falls behind — the target type is
still satisfied. Grep the concept as a **type**, not as a field.

The mutation that proves it is cheap: removing the mapper line failed 2 of 2 on
the other surface, a signal nothing else in the suite gave.

## Why a green suite cannot see it

Tests are written against the path the author had in mind. The emitting path is
the one they were thinking about — that is *why* it emits. The other path has no
test asserting the absence of a signal nobody knew was missing, and no test
fails, because nothing is broken on the branch anyone looked at.

The test that finds it is the one asserting the **contrast**: that success and
failure are distinguishable, or that two entry points agree. One instance was
found writing a test that a *successful* compaction reports no failure — it went
red because success reported nothing at all.

## The tell

You are about to consume a signal, and you verified it exists by finding where
it is produced. That is the moment. One emit site plus more than one code path
into the behaviour is the shape.

A second tell: the feature has two strategies, backends or modes, and you read
the one named in the config you happened to be looking at.

A third: the concept has more than one type declaration, and something maps
between them field by field.

## Related

- [A declaration nothing drives is a defect](declared-but-undriven.md) — the
  zero-site case; this is the some-sites case, and it hides better.
- [Mutate every test](mutation-check-every-test.md) — mutation proves the test
  catches a change on the path it covers, and says nothing about the path it
  does not.
- [Verify the claim, including your own](verify-claims-including-your-own.md)
  — "emitted so a host can surface the loss" is such a claim. It was true of the
  emit site and false of the feature.
- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — the live run that "confirmed" `agentId` read it off the event stream, which
  always carried it. Missing a shape and observing the wrong channel are how the
  same defect survives twice.
