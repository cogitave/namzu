---
uid: namzu.conventions.read-the-neighbour
title: The answer is usually already written, near where it is needed
description: Five defects in one session had their reasoning already in the tree — seventeen lines below, two columns away, forty lines above, in the sibling command. None needed measuring. All needed applying, and the cost of checking is one screen of reading.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-09T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, code-review, verification]
---

# The answer is usually already written, near where it is needed

Ratified 2026-08-09.

> The failure is not missing knowledge. It is **unapplied** knowledge.

A session fixing operator-facing surfaces produced five defects in a row where
the correct reasoning was **already in the repository, in writing, within
scrolling distance of the code that got it wrong**. Not inferable, not implied —
written out, in a docstring or a comment or a sibling file, by someone who had
already thought it through.

None of them needed measuring. All of them needed reading.

## The five

| The defect | Where its answer already was |
| --- | --- |
| `toolNames` shipped as a frozen array, so `/tools` listed a roster taken before some of the tools existed | `promptExemptTools`, **seventeen lines below in the same object**, is a function *and its docstring says why*: "the roster is not final when the session is built. Task tools register deferred inside the first `query()`, so anything captured earlier would report a set the operator never had." |
| Four picker notices said "showing **its** default", meaning the provider's | the row they render beside is labelled `(namzu default)`, **two columns away**, precisely because it is not the provider's |
| `run-stream --session` fell back to reading history from stdin when the store failed, answering against a conversation nobody asked for | `run.ts` refuses the equivalent **and writes down the argument**: "someone who asked for a specific conversation and got a new one that looks the same finds out several turns later, having already acted on it" |
| A failed save was swallowed, so a later `history` came back short with nothing to connect it to | the `notice` event kind, **forty lines above the same handler**, under a comment making exactly the case: "a host UI is the caller with no human watching" |
| The permission prompt named `y`/`n`/`a`/`esc` and omitted `Ctrl+C`, the only key that stops the turn | `docs/cli/tools.md` had the distinction spelled out |

Five different authors' worth of thinking, all of it correct, none of it reaching
the line that needed it.

## The rule

Before you decide how something should behave, **read its neighbours.** Four
places, in this order, because they are ordered by how cheap they are:

1. **The adjacent members.** The field above and below in the same interface or
   object literal. A neighbour that is a function where you are writing a value —
   or that carries a caveat yours does not — is telling you something.
2. **The docstrings of those neighbours.** This is where the reasoning lives. The
   `promptExemptTools` case is the pure form: the paragraph explaining why a
   snapshot is wrong was seventeen lines from the snapshot.
3. **The sibling that solves the same problem.** The other command, the other
   driver, the other renderer. If one of a pair refuses and the other degrades,
   one of them is wrong and the argument is written down beside whichever
   refuses.
4. **The published documentation for the surface you are touching.** It is the
   most-reviewed prose about the behaviour, and it is where a distinction the
   screen has lost is most likely to have survived.

This costs about one screen of reading. Every one of the five above would have
been prevented by it.

## The tell

**You are about to make a judgement call** — whose default this is, whether to
refuse or degrade, whether a failure is worth reporting, which keys to name.

That is the moment. A judgement call means someone has probably already faced
it here, because these questions recur inside a codebase far more than they
recur across one. If you cannot find the prior answer in the four places above,
you are genuinely first, and *then* the judgement is yours to make and to write
down where the next person will hit it.

A second tell: **you are writing a comment explaining why you chose X.** Search
the file for the words you are about to use. Twice in the session above, the
comment being written was a near-paraphrase of one already present.

## What this rule is not

It is not "do not measure". Most of the same session's findings went the other
way and **had** to be measured: a key that looked inert was inert only in the
case anyone would use, established by dumping frames; a status line's truncation
had a cause nobody had guessed, established at a real column count; a credential
check that could not fail was established by running it against invalid keys.
Reading would have found none of those.

The two are cheap in different directions. Reading the neighbour costs a minute
and settles questions of *intent and policy* — what should this do, whose choice
is this, what did we decide last time. Measuring costs longer and settles
questions of *fact* — what does this actually do right now. Reaching for the
second when the first would have answered is the waste this rule names; reaching
for the first when only the second can answer is
[verify the claim, including your own](verify-claims-including-your-own.md).

## Why a green suite cannot see it

There is nothing to see. Both the neighbour and the defect are internally
consistent; the code compiles, the tests pass, and the divergence exists only
between a comment and a line of code that no tool compares. The only automated
form is the narrow one the docs gate already implements — `resource:` drift,
which catches a document falling behind its code and nothing else.

So this is a reading discipline rather than a check, which is exactly why it is
written down.

## Related

- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  — the same geometry one level down. There a *mechanism* reaches some call
  sites and not others; here *reasoning* reaches some lines and not others, and
  the second is what produces the first.
- [Verify the claim, including your own, including a comment's](verify-claims-including-your-own.md)
  — the counterweight. Read the neighbour, and then check that the neighbour is
  telling the truth; a comment is evidence about intent, not about behaviour.
- [A declaration nothing drives is a defect](declared-but-undriven.md) — the
  same waste in the other medium: written, correct, and connected to nothing.
