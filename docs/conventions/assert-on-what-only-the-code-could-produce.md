---
title: Assert on something only the code under test could have produced
description: An assertion passes when its expected text is present for any reason, including a reason that has nothing to do with the behaviour being pinned — so a substring echoed from the test's own input, or a fragment that survives deleting the sentence around it, certifies a behaviour nobody checked.
type: Convention
status: stable
tags: [convention, verification, testing]
generated: { by: human:bahadirarda, at: 2026-08-18T00:00:00Z }
---

# Assert on something only the code under test could have produced

Ratified 2026-08-18, from three occurrences in one session.

A `toContain` passes when the text is there. It does not ask *why* it is there.
When the expected fragment can arrive by a second route — echoed from the
input, present in a neighbouring clause, produced by a different branch — the
assertion is green whether or not the behaviour it names exists.

This is the sibling of [mutation-check-every-test](mutation-check-every-test.md)
and it is what that rule finds. A mutation escapes; the escape is not a weak
guard in the code but an assertion that was never about the guard.

## The three shapes it took

**Echoed from the input.** A diagnostic was supposed to quote the rule that
decided, so an operator would not have to re-derive which of nine entries did
it. The test asserted the message contained `git push`. Deleting the rule's
reason from the message entirely — the whole point of the diagnostic — left the
test green, because the message also echoes the input, and the input is
`{"command":"git push --force"}`.

The fix is to assert on the part that has no other source. The compiled pattern
is `git push.*`; the input never contains `.*`. A second case was added whose
expected text (`No matching rule`) shares nothing at all with its input.

**Surviving the sentence it belongs to.** A review prompt had to allow "this
looks right" so a model with nothing to report was not forced to invent
something. The test asserted `say so in one line`. Deleting the condition —
"If the work looks right," — left that fragment intact, so the mutation passed
while the instruction had become an order to answer briefly, attached to
nothing. Asserted as one phrase across the wrap, it fails.

**Present for a different reason entirely.** A guard rejecting an empty anchor
was checked only by counting diagnostics. Removing the guard still produced a
diagnostic — a worse one, saying `"ask" is not "maybe"` — so the count was
unchanged. What the guard buys is the *message*, and the message is what the
test now names.

## The rule

Before writing `toContain`, ask what else in this system could put that text
there. If the answer is "the input", "the neighbouring clause" or "the other
branch", the assertion is not about the behaviour.

Two habits that make it concrete:

- **Prefer text the code transforms.** A compiled pattern, a rendered number, a
  reworded phrase — anything the input does not carry verbatim.
- **Assert the phrase, not the fragment**, when the behaviour is a whole
  sentence. `expect(text.replace(/\s+/g, ' ')).toMatch(/If the work looks right, say so in one line/)`
  fails when either half goes; `toMatch(/say so in one line/)` fails when
  neither does.

## Why it earns its own page

Every instance above was found by a mutation, so the mutation rule was doing
its job. But the diagnosis each time was "the code is fine, my test was
looking at the wrong string", and that is a distinct correction from the ones
[sound-about-the-wrong-thing](sound-about-the-wrong-thing.md) describes: the
test is about the right *behaviour*, and its assertion is about the wrong
*evidence*.
