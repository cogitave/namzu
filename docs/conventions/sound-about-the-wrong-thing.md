---
uid: namzu.conventions.sound-about-the-wrong-thing
title: A test can be sound and still be about the wrong thing
description: A test can run, cover a real path, and go red under mutation, and still be evidence about a property nobody needed. The machinery is honest and the subject is wrong.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-06T00:00:00Z
lastReviewed: 2026-08-08
resource: packages/sdk/src/runtime/query/index.ts
tags: [convention, testing, verification]
---

# A test can be sound and still be about the wrong thing

Ratified 2026-08-06; amended the same session with "a live run is still an
observation", and on 2026-08-08 with "it is not a rule about tests" and with the
provider-chain instance below.

A test can run, cover a real path, and go red under mutation, and still be
evidence about a property nobody needed. The machinery is honest; the
**subject** is wrong. The sibling rules catch a path that was never exercised.
This one catches a path that was exercised perfectly while you were standing
somewhere the difference does not show.

It recurred six times in one session. One instance shipped, and one was made by
a **live end-to-end run** — the remedy that is supposed to catch this class.

## The rule

Before writing the assertion, name three things:

1. **The property** — what differs between the broken state and the fixed one.
2. **The observer** — who has to be able to see that difference. A host? The
   model? A later turn? The party you are protecting is rarely the object you
   just edited.
3. **The moment** — when the difference is visible, and when it is erased.

Then read the property from where the observer stands, at a moment before it is
erased.

The check is one question: **would this assertion still hold with the fix
deleted?** Answer it by deleting the fix, not by reasoning about it. If you can
state what the test asserts without mentioning the defect, you have not written
the test yet.

## Six ways it went wrong

- **Read off the object under test instead of the consumer.** The plan
  settlement tests read the outcome from `PlanManager` through
  `onContextCreated` and proved the plan settled. `plan.completed` and
  `plan.failed` were folded into a bare `break` in `wirePlanManager`, so no run
  event was emitted and **no event consumer could see a settlement at all**.
  The tests proved the state changed without ever asking whether anyone could
  observe it. The unit suite structurally could not find this; a live
  end-to-end run did — which is not the same as live runs being safe, as the
  next section shows.
- **Measured after the difference was erased.** The first probe for the
  concurrent-fan-out budget bug measured the tracker *after settle* — and a
  settled child refunds. The tracker looked healthy exactly when the transient
  over-commitment was hidden.
- **Measured the bookkeeping instead of the harm.** The second probe measured
  the tracker rather than the allocations. The harm was never the ledger: it was
  four children each believing they might spend half a pool that has one half.
- **An assertion true under both states.** A completion-inbox case asserted
  `progressed` was `[]` twice. That holds whether the progress tee is fixed or
  broken. A test that cannot distinguish the two states is not evidence of
  either.
- **Drove the path where the defect cannot appear.** A provider-chain test
  asserted that a 404 falls over to the next member, and threw a raw 404 to do
  it. It passed with the fix deleted: an unclassified 404 reaches `not_found`
  through the status table and falls over regardless. The defect lives only on
  the *classified* path, where a driver that diagnosed its own 404 yields
  `invalid_request` and the status is the sole surviving evidence. Same
  property, same assertion, wrong one of two paths — and the mutation profile is
  what said so, reporting no failure where every sibling mutation had one.
- **Attributed the protection to the wrong mechanism.** The permission gate
  compiled the pattern before recording the tool names, and the comment claimed
  that ordering is what stops a mistyped pattern widening "deny this tool when
  its argument matches X" into "deny this tool". Reversing the two lines failed
  nothing — the real protection is the missing-pattern check at the top of
  `evaluateRule`, which returns before the name set is consulted. The test
  passed for a reason other than the one it named. The comment was corrected,
  a second test written against the real check, and the code left alone.

That last one is the rule pointed at source rather than at tests: a comment
claiming which line does the protecting is a claim to mutate.

## A live run is still an observation

The settlement case above was found by a live end-to-end run, which invites the
conclusion *run it live and you are safe*. Later the same day that reading was
disproved.

`PlanStep.agentId` was checked by driving a real run through `resumeHandler` and
watching the plan step report its agent. It did. But that reading came off the
`plan_ready` run event, which carries whole `PlanStep`s and therefore **always
had the field** — while `PlanApprovalData`, the payload the handler actually
receives, did not. The run confirmed *the value exists somewhere*, which is not
the question *does the approver get it*.

Watching the event stream is not watching the approval channel.

A live run is a **stronger fixture, not a different kind of evidence**. It
removes the setup failures — the missing listener, the propped-up event loop,
the hand-built collaborator — and removes none of the aiming ones. All three
questions still apply to it, and the second is the one that bites:

> **The channel you observe must be the channel under test.**

When a value travels on more than one channel, reading it off the convenient one
proves it was produced. It says nothing about the channel whose consumer you are
protecting, and the convenient channel is convenient precisely because it
carries everything.

## It is not a rule about tests

The three questions are about **evidence**, and an operation produces evidence
the same way an assertion does. Recorded here because the instance was mine.

Two worktrees were stale and had to go. What ran was a loop over the whole of
`.claude/worktrees`, not over the two directories named — and one of the
directories it reached belonged to an agent that was still working. Then came
the verification: `git` was asked about refs, every ref was intact, and the
result was reported as **"no work lost"**.

That report was true. It was also not the question.

- **The property** was whether a live agent's working tree still existed.
- **The observer** was the agent, which reads files, not refs.
- **The check** asked git about commits — a store that a directory deletion
  does not touch, and therefore a store that would have answered *intact* no
  matter what the loop deleted.

**A sweep whose blast radius was a directory, verified by a check whose scope
was a ref.** The verification could not have failed, so it was not one; and it
sounded conclusive precisely because it was about the wrong thing. Nothing was
in fact lost — the agent's work was read-only — which is luck, and luck is what
the check was silently substituting for.

A second failure sat inside the first: the loop's `catch` rebound `$_`, so the
error text named the exception and not the path that raised it. The blast radius
was unbounded *and* unobservable, and that combination is what turns a mistake
into one you cannot even describe afterwards.

The rule for operations reads the same as the rule for tests, with one addition:
**name the blast radius before the command, and verify against the same store
the command wrote to.** If the operation touched the filesystem, ask the
filesystem. Asking a different store is how a destructive action gets reported
as safe by an honest sentence.

## How this differs from its nearest neighbour

They fail in opposite halves of the same sentence.

- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  asks **did the code run?** The mechanism is correct and one of the paths into
  it does not use it. The fix is to enumerate the paths.
- This rule asks **would I be able to tell?** The path ran, the defect was
  present or absent as designed, and the assertion reads a quantity that is the
  same either way — or reads it from a surface that is not the one that matters,
  or at a moment when the difference has already been undone. The fix is to
  relocate the observation, not to add a path.

A test can satisfy one and fail the other. The plan settlement tests drove the
right path through the right front door, and read the result off the wrong
party.

## The tell

You wrote the assertion against the thing you just changed. That is the moment
— the object you edited is the most convenient place to read from and almost
never where the consumer stands.

A second tell: the test's name describes a scenario and its body describes a
state. "Survives a concurrent fan-out" and `expect(x).toEqual([])` are not the
same claim, and the gap between them is where this hides.

A third: you confirmed the value **exists** rather than that the consumer
**received** it. "It is there" and "they get it" are different claims, and the
first is far easier to satisfy — which is why it is the one you accidentally
prove.

## Related

- [Mutate every test](mutation-check-every-test.md) — mutation proves the test
  can fail. It does not prove that what it measures is what matters; three of
  the instances above went red under *some* mutation.
- [A fixture unlike production tests a system that does not ship](fixture-must-match-production.md)
  — when the observation is right and the setup never reaches the defect.
