---
uid: namzu.conventions.a-falsifiable-comment-is-a-test
title: A sentence a test could falsify is a claim, not documentation
description: A docblock sentence naming a condition and an outcome has a truth value, so it is an unpinned assertion sitting where nobody checks it — the test goes in the suite and the comment points at it.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-10T00:00:00Z
lastReviewed: 2026-08-10
tags: [convention, verification, testing]
---

# A sentence a test could falsify is a claim, not documentation

Ratified 2026-08-10, from an agent that caught this shape inside its own
mutation harness, wrote the fix, and then committed it again three files later
in the same task.

**A sentence in a comment that a test could falsify is a claim, not
documentation. It goes in a test, and the comment points at it.**

## The tell is grammatical, which is what makes it usable

Two sentences from the docblock that produced this rule:

> *"Bounded like every other non-settling turn, by `maxIterations`."*
>
> *"The prose retry limit does not apply, because this turn DID call the tool."*

Neither explains a decision. Both are **present-indicative statements about
behaviour under a condition** — propositions with truth values, asserted in the
one place nothing checks. A reviewer reads them as established; the next author
relies on them; and nobody ever ran them.

So the trigger is mechanical rather than remembered:

> **When writing a docblock, mark every sentence that names a condition and an
> outcome. Each one is a test you have not written yet.**

## What camouflages it

Those sentences sat in the same paragraph as genuine reasoning about *why* the
design is shaped the way it is — and that reasoning belongs in prose, because
intent cannot be executed. The two kinds read identically and sit side by side.

The separation is not about tone or length. It is one question: **could a test
disagree with this sentence?**

- *"Refusing here is worse than discarding an answer, because the work already
  happened."* — an argument. Prose.
- *"A lone call still settles immediately."* — a condition and an outcome. Test.

A comment may then point at the test. That is the version worth writing: the
reader gets the reasoning and the address of the proof, and the proof is
somewhere it can go red.

## Why the rule is mechanical and not a matter of care

The agent that produced this had **just** caught the same shape one layer down
— an ambiguous mutation anchor that silently aimed at a neighbouring function
and reported SURVIVED, which reads exactly like "my tests do not cover this".
It found that, fixed the harness to refuse an anchor matching more than once,
and the fix immediately caught a second bad anchor.

Then it wrote two unpinned assertions into a docblock in the same task.

That is the useful part. **Catching an instance does not install the rule.**
The lesson landed, was understood, was acted on — and the habit reasserted
itself within the hour, because attention was on the thing being described
rather than on the describing. Only a mechanism survives that, which is why
this page gives a grammatical test rather than an exhortation to be careful.

## The same shape one level out

The same change altered documented behaviour and touched no file under `docs/`.
From inside the diff that is invisible: everything written was correct, and the
omission is a thing that is *not* there. That is exactly why the repository
makes it a gate rather than a habit — **the check has to sit outside the person
who believes they have been thorough.**

## Related

- [Verify the claim, including your own, including a comment's](verify-claims-including-your-own.md)
  — its mirror. That rule is about **consuming** a claim: re-establish it before
  acting. This one is about **producing** one: do not write a falsifiable
  sentence without pinning it.
- [Mutate every test](mutation-check-every-test.md) — a test written for one of
  these sentences still has to be able to fail.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — an unpinned comment is that, in prose: it reads as established and can never
  go red.
