---
title: Verify the claim, including your own, including a comment's
description: Re-establish every claim against source before acting on it — a reporter's finding, a comment already in the tree, and what you yourself concluded an hour ago are all claims of the same kind.
type: Convention
status: stable
tags: [convention, verification, review]
generated: { by: human:bahadirarda, at: 2026-08-04T00:00:00Z }
verified:
  - by: process:conventions-migration
    at: 2026-08-07T00:00:00Z
---

# Verify the claim, including your own, including a comment's

Ratified 2026-08-04, from two sessions.

Re-establish every claim against source before acting on it. This applies to a
reporter's findings, to a comment already in the tree, and to what you yourself
concluded an hour ago.

## The rule

Grade the evidence, then match the effort to the grade:

- **MEASURED** — a command produced a number. Strongest, but the number came
  from someone else's environment.
- **PROBED** — something was executed against a fixture. Reproduce it here.
- **READ** — source inspection only. Weakest. **Execute it rather than
  re-reading it.**

Every claim that has failed verification in this repository came from the READ
tier, and executing is what caught them.

## A reporter is often right and sometimes not

Of one reporter's fifteen items, twelve held, one was wrong outright
(`CHILD_PROMPT_MAX_CHARS` does not exist in this repository), and two were right
about the symptom with the wrong mechanism. A later report of six items had five
hold and one — a claim that a model family rejects the sampling parameters —
supported by no reference page. **It was not implemented**, and the changeset
says why: silently dropping sampling parameters that would have worked is its
own defect.

Acting on an unverified claim does not fail safe. It ships a second bug wearing
the first one's justification.

## Your own conclusion from an hour ago is a claim

`z.never()` was shipped to close a fail-open roster. A verification pass then
executed the repository's own schema renderer and found it emits `{"not":{}}`,
which sits outside the keyword subset strict validators accept — and a rejected
tool schema fails the whole request, not one tool. The conclusion survived; the
mechanism was replaced.

Citations are claims too: a Saltzer and Schroeder locator was wrong in three
places, and the *principle* cited for one half was the wrong principle
(complete mediation, not fail-safe defaults).

## A comment's claim of universality is a claim to check

`glob.ts` was fixed with a comment reading *"every sibling builtin already
remembers this branch."* `ls.ts` did not. The comment was written in good faith
by someone who had just fixed the neighbours.

So: when a comment asserts that something holds everywhere, grep for the
everywhere. Counting `context.sandbox` references across the builtins is what
found it — every sibling had at least two and `ls.ts` had none.

> **Illustrative, and deliberately not pinned.** Those per-file counts were a
> snapshot taken while the defect was open. They have already moved: `ls.ts`
> carries the branch now, and two siblings have grown further references since.
> Re-run the count rather than trusting this paragraph — which is the rule this
> document is about, turned on the document itself.

## Read a peer's source to find what you cannot see in your own

Reading another runtime's delimiter system revealed that this repository's own
untrusted-content envelope was forgeable: content containing the closing tag
closed the boundary early, and everything after read as the agent's own
instructions. The label was the entire mitigation and the labelled party could
delete it.

That would not have been found by re-reading our code, because the belief that
it was correct is what produced it.

## Related

- [Mutate every test](mutation-check-every-test.md)
- [Refuse, do not silently degrade](refuse-do-not-degrade.md)
- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  — where a universality claim is about code paths rather than files.
