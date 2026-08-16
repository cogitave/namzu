---
uid: namzu.conventions.a-gate-must-say-where-it-looks
title: A gate must say where it looks, and derive it
description: A check reports on what it scanned, never on what you assumed it scanned. Five gates here claimed a scope broader than their code, and four of the five kept it in a hand-written list that went stale the day somebody added a package.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-17T00:00:00Z
lastReviewed: 2026-08-17
tags: [convention, verification, ci]
---

# A gate must say where it looks, and derive it

A green gate is a claim about the files it opened. It is silent about every
file it did not, and silence reads exactly like approval.

That is the whole failure. Nobody misreads a red run. What gets misread is a
green one over a scope narrower than its name — and the narrower scope is
almost never written down as a decision, because it arrives as a glob that
looked right, or a list that was right once.

## The five

Found in one session, in five gates that were all working correctly against
the scope they actually had:

| Gate | Claimed | Looked at |
|---|---|---|
| Log standard | `packages/*/src` | one directory below `packages/`, so seven driver packages were never scanned |
| Public surface | "public-surface regression guard" | one entry point of one package, out of twenty-three |
| publint step | the publishable packages | eleven names typed by hand; four packages were missing |
| Doc fences | the fences under `docs/` | one directory, and its import map held one specifier, so no page documenting an optional package could ever compile |
| Docs standard | `docs/` | five directories, with the remainder printed every run |

Two of those are honest and three are not, and the difference is the rule.

## Printing the remainder is what makes a partial scope legitimate

The docs gates were partial **on purpose**, said so in their headers, and
printed the count they had not looked at on every single run:

```
docs gate: 0 problem(s) across 26 checked file(s)
           59 file(s) under docs/ not yet migrated to the standard
```

That is a scope you can act on. It stays in front of whoever reads the log,
it shrinks visibly as the migration proceeds, and the day it reads zero is a
day someone notices. Their headers also state the reason for going slowly —
"a gate that claims the whole tree on day one gets switched off on day two" —
which is a real argument, not an apology.

The other three said nothing. The log gate's glob *looked* like it covered
`packages/*/src` and a reader had no reason to doubt it; the surface gate was
named for a job an order of magnitude larger than the one it did.

**So: a partial scope is fine. An unstated one is not.** If a check cannot
cover everything yet, print what it skipped, in the same output, every time.

## A dated measurement is not a check

The log gate's header did better than most — it recorded the gap and even
dated it:

> Measured empty of console/stream/logger hits at seed time (2026-08-15); a
> provider package that starts writing to a stream directly will not be caught
> here until this glob is revisited.

Honest, specific, and carrying its own expiry. It is still not a check. The
tree was re-measured a day later and was still clean, which is the *only*
condition under which widening a gate is free — so the glob was widened
instead, and a `console.error` planted in a driver package is now reported by
name where it previously passed unseen.

Re-measure before you widen. If the widening finds violations, that is a
backlog item and the scope note stays until it is cleared. If it finds none,
the note has no reason to exist.

## Derive the scope; a list is wrong the day someone adds a package

Four of the five kept their scope in a literal:

```sh
for pkg in sdk sandbox telemetry computer-use providers/anthropic …
```

Eleven names. Four publishable packages were not among them, and **one of them
had been added by the same session that found the omission** — the list was
already wrong by the hand of the person reading it.

The workspace already knows the answer. `private !== true` is the same signal
`pnpm publish` reads, so a list derived from it cannot disagree with what
actually ships:

```sh
pnpm list -r --depth -1 --json   # then keep every entry with private !== true
```

A new package then joins the check by existing, which is the only way a
per-package gate stays true. Where a derived list can legitimately come back
empty, fail on that too — an empty loop passes by checking nothing.

Deriving is not the same as walking everything. Bound the descent to the
shapes the repository actually has (`packages/<pkg>` and
`packages/<group>/<pkg>`), or a recursive scan will wander into a nested
`node_modules` and a fixture package's own source.

## Ask what the consumer asks

Two checks in this repository look at the same packages and disagree about
what "empty" means, and both are right:

- one asks whether a **file** has content, and catches a module committed at
  zero bytes;
- the other asks whether an **entry point** has a surface, and catches a
  subpath that is 44 bytes of `export {}` — an import that resolves, returns
  nothing, and is discovered wherever the missing symbol is first called.

The second question is the one a consumer is really asking when they write the
import. Pick the scope from the question, not from what is convenient to
enumerate.

## What to do

- Say in the gate's own output what it did **not** cover. Every run.
- Derive the scope from something that cannot drift — the manifest, the
  workspace, the `exports` map — rather than listing it.
- Re-measure a documented gap before you inherit it. A dated note has an
  expiry written into it.
- When a scope note says "revisit", that is a task, not a disclaimer.

## Related

- [A check that cannot fail is worse than no check](./a-check-that-cannot-fail.md) —
  the same disease one step further along: this rule is about a check that
  never looks, that one is about a check that looks and cannot object.
- [One site is not every site](./one-site-is-not-every-site.md) — the fix that
  lands at the one place the bug was reported.
- [Verify claims, including your own](./verify-claims-including-your-own.md) —
  a gate's scope is a claim like any other.
