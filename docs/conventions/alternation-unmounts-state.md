---
uid: namzu.conventions.alternation-unmounts-state
title: Rendering two things in a ternary destroys the state of both
description: A component swapped for another at the same position is unmounted, and its state goes with it. The guard written to preserve that state reintroduced the loss when it changed the element type it returned.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-09T00:00:00Z
lastReviewed: 2026-08-09
resource: packages/cli/src/tui/__tests__/app-draft-survives.test.tsx
tags: [convention, react, state, ui]
---

# Rendering two things in a ternary destroys the state of both

Ratified 2026-08-09, from the composer-unmount fix.

React reconciles by **element type at a position**. Render a different type in
the same slot and the old subtree is unmounted, its state discarded and its
effects torn down. This is correct, documented behaviour. It becomes a defect
when the state being discarded is the user's, and when nothing on screen says it
happened.

## The incident

The TUI's permission overlay was rendered as the alternative to the composer:

```tsx
{permission ? <PermissionOverlay … /> : <ComposerFrame><Composer /></ComposerFrame>}
```

The draft lives in `Composer`'s own `useState`. So when the agent asked to run a
tool, the composer was unmounted and the operator's half-typed sentence, paste
chips and pasted images went with it — on an event they did not trigger, with no
keypress, and no message saying anything had been lost.

The fix makes them siblings and hides the composer instead of replacing it.

## The same mistake, inside the fix

The first version of that fix had `ComposerFrame` return early when hidden:

```tsx
if (hidden) return <>{children}</>   // was: <Box …>{children}</Box>
```

That changes the element type at the position from `Box` to `Fragment`, so React
unmounted and remounted the subtree — **reintroducing the exact destruction the
guard had just been written to prevent.** The children were still "rendered", the
prop was honoured, the code read as obviously correct, and it would have passed
review.

Three tests caught it, and that is the argument for having written them first: a
guard whose own defect is caught by its own tests costs an hour, and the same
guard shipped costs a user their message with no way to know why. The tests
asserted the draft was *back on screen* after a real prompt cycle — not that a
state hook still held a value, which would have passed.

So: when a component must disappear without dying, **keep the element type
stable and vary its decoration**. Here the `Box` became unconditional and only
its border and margin change; the children render `null` while hidden, so an
undecorated box around nothing prints nothing.

## The rule is about alternation, not about conditionals

This is the half that keeps the rule usable rather than superstitious, and it
was measured rather than assumed. Putting a component behind a condition is
fine. Two shapes, one destructive:

```tsx
{cond ? <A /> : <B />}      // ALTERNATION — swaps the type, unmounts
{cond ? <A /> : null}       // fine — the slot stays, holding nothing
```

A conditional sibling *above* a component does not remount it: `{cond ? <X/> :
null}` keeps the slot count stable, so the component after it stays at the same
position. This was confirmed by mutation — inserting exactly that sibling killed
no test, correctly.

Read as "never render a component conditionally", the rule would be wrong and
would be cargo-culted into worse code. It is narrower than that: **only
alternation destroys.**

## Where to look for it

The shape is worth grepping for wherever a component owns state a user typed:

- a ternary whose two branches are different components;
- an early `return` in a component that changes what element type it yields;
- a wrapper that drops its own element when some prop is set.

## A tell: a test whose green depended on the defect

When the draft started surviving, an unrelated test broke. It typed a slash
command straight after a permission cycle, and had only ever worked because the
composer was being emptied for it — with the draft preserved, the command was
appended to the leftover text and submitted as prose.

This is the inverse of a mutation check. A mutation check asks whether a test
fails when the code breaks; this is a test that passed *because* the code was
already broken. It is rarer and it has no automated form, so the tell is worth
knowing: **a test that starts failing when you fix a defect may have been
depending on it.** Read such a failure before adjusting the test — it is
evidence about the old behaviour, not noise.

## What this rule is pinned to

`resource:` points at the regression test, not at `App.tsx`. The first version
pointed at the component and the gate fired within a day — on a change to the
picker's exit keys, which touches nothing this rule depends on. That is the
failure mode this gate's own guidance warns about: a file that churns for
unrelated reasons trains everyone to wave the failure through.

The test changes when the behaviour changes and not otherwise, so a firing here
is a real question about whether the rule still holds.

## Related

- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  — the same shape: the mechanism was right and one path through it did not use
  it.
- [Mutate every test](mutation-check-every-test.md) — including the negative
  results, which are what made the alternation rule precise here.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — a test asserting a hook's value rather than the screen would have been one.
