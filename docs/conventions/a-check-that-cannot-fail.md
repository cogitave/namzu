---
title: A check that cannot fail is worse than no check
description: A guard whose condition can never be false protects nothing, and teaches the next reader that the checks here are decoration. The same shape reaches a matcher that accepts what it exists to reject, and a suite that never runs — whose absence the runner reports as success.
type: Convention
status: stable
tags: [convention, verification, code-review]
generated: { by: human:bahadirarda, at: 2026-08-04T00:00:00Z }
---

# A check that cannot fail is worse than no check

A guard placed where its condition can never be false does not protect
anything. It costs a reader's attention, and it teaches the next person that
the checks in this file are decoration — so the one that matters gets skimmed
too.

When adding a guard, name the input that makes it fire. If you cannot, either
the guard belongs somewhere else or the situation it imagines does not exist
yet. Write a comment saying what would make it real, and leave the call out.

## The incident

`@namzu/sdk` 14.0.0 gave `Project` a status and made spawn and both handoffs
refuse an archived workspace. Two call sites in the CLI create sessions
directly through the store, bypassing that gate. They look identical and are
not:

- The session store reads the project id back out of `.namzu/cli.json`, so from
  the second run in a directory onward it attaches to a project it did not
  create. The gate is real there and was added.
- The subagent runtime builds a fresh store four lines earlier and its project
  two lines earlier, neither outliving the call. A freshly created project is
  always open, so the gate could never fire. It was left out, with a comment
  naming what would make it real: a persistent store, or a project id arriving
  from a caller.

Establishing which case each site was in took one reading and changed the
answer for one of them.

## The sharper form

The same rule catches a test that cannot fail. A test whose assertion holds
under the bug it was written for is the same object: something that looks like
a check and is not.

## The loose matcher

Amended 2026-08-09.

The forms above are about *placement* — a guard in a spot its condition cannot
reach, a test driving a path the defect is not on. There is a third door, and it
is the quietest, because the placement is right and the path is right:

**the assertion is written with a matcher loose enough to accept the very value
it exists to reject.**

`toContain(old)` cannot detect a change that only **adds around** `old`. If the
new value contains the old one as a substring — appended, prefixed, or wrapped —
the assertion passes on both, so it is not an assertion about the change at all.
It has been met twice in this repository, once from each direction:

- **Prefixed.** A model with no explicit setting was marked `(default)`, which
  reads as the provider's current default and is in fact namzu's own pick out of
  a table compiled into the release. Corrected to `(namzu default)`. The test
  asserting the marker used `toContain('(default)')` — and `(namzu default)`
  contains `(default)`, so the test passed identically before and after. It
  could not have told the two apart in either direction.
- **Appended.** `toContain('/agents')` was meant to prove a command is listed in
  `/help`. It survives renaming the command to `/agentsXX`, because that
  contains it. The fix was to anchor on the whole entry — `/\/agents\s/` — since
  `/help` pads the name and a real entry is the name followed by whitespace.

## The tell, and the test for it

You are asserting on a string, and the change you are pinning **lengthens** it.
That is the moment.

Ask: *is the old value a substring of the new one?* If it is, a substring
matcher proves nothing, and mutation will not tell you — the mutation runs, the
suite stays green, and green is exactly what a passing mutation-restore looks
like when the test is sound. This is the one failure the mutation loop reports
as "kills nothing" when the truth is "cannot kill anything".

The fix is always the same: assert the **whole** phrase, or anchor it. Prefer
matching what a reader would see in full — the complete marker, the complete
line — over the fragment that happens to be distinctive today.

## The check that was never asked

Amended 2026-08-13.

The three forms above are all *present and evaluated* — a guard whose condition
cannot be false, a test on a path the defect is not on, a matcher that accepts
what it exists to reject. There is a fourth, and it is the worst of the family
because nothing about it is wrong except that it never happened:

**the check is correct, would have caught the defect, and is never run — and
the runner reports that as success.**

### The incident

`packages/sandbox` has a smoke suite that spawns a real container, completes
the worker handshake and asserts the leaf-mount permission contract. It is
careful work. Its docstring explains that on CI it *fails fast* rather than
skipping, "so a CI misconfiguration cannot silently mask a regression". A
dedicated workflow builds the reference image and runs it on every change to
the package.

It had never run. Not once.

Three things had to line up, and each is individually reasonable:

1. `vitest.config.ts` excludes `**/*.smoke.test.ts` so the default `pnpm test`
   stays daemon-free. Correct, and it governs **every run that config is used
   for** — including the `test:smoke` run that exists to run them.
2. `test:smoke` tried to re-include them by naming them as CLI arguments.
   Positional arguments are a **filter applied to what discovery already
   found**, not an include. They cannot re-add an excluded file.
3. `--passWithNoTests` turned the resulting empty run into exit `0`.

So the job printed `No test files found, exiting with code 0` and went green,
after building a Debian image with a browser and an office suite in it to run
nothing at all. Six words in a log, in a workflow nobody had reason to read,
because it was passing.

The fail-fast guard from the docstring could not fire either. It lives inside
a file that was never loaded. **A guard against misconfiguration cannot survive
a misconfiguration that prevents it from being read** — which is the same
lesson as the rest of this page, arriving one level up.

What it was hiding: the backend could not create a sandbox on its own
documented defaults. `create()` died inside a `docker inspect` template, and
the error blamed a container that was alive and well.

### The tell

You have a suite with a *dedicated* runner — a separate script, config, or
workflow, usually because it is slow, needs a daemon, or would flake beside the
unit tests. That separation is the risk. A suite in the default run announces
its own absence by changing the count; a suite with its own path announces
nothing to anyone.

Ask two questions of any such runner:

- **What is the last non-zero test count it printed?** Not "does it pass" —
  passing is what the failure looks like. Read the summary line and find the
  number. If you cannot find one in the log, that is the answer.
- **Does its exit code distinguish "everything passed" from "nothing ran"?**
  `--passWithNoTests` and its equivalents collapse the two on purpose, which is
  right for a package that genuinely has no tests and wrong for one whose whole
  point is a suite. Do not set it on a runner named after the suite it runs.

### The fix, both halves

Give the separated suite a config that *includes* it rather than a filter that
hopes to, and drop the pass-with-no-tests flag from that runner so an empty run
is a failure. Then check the two configs against each other: the exclude in one
and the include in the other are now a pair, and changing either alone makes
the suite invisible to both.

## Related

- [Never filter a verification](never-filter-a-verification.md) — the adjacent
  failure, and the contrast worth holding: there the check *runs* and its answer
  is discarded; here the check never runs and its absence is reported as a pass.
  Both end at a green summary line that means something other than "this is
  fine".
- [Mutate every test](mutation-check-every-test.md) — how you establish that a
  check can fail, rather than arguing that it can. The loose matcher above is
  the case mutation cannot report, which is why it is written down here as a
  shape to recognise before you run one. Note that mutation cannot reach the
  fourth form either: a suite that never runs kills nothing, and reads
  identically to a suite with no coverage of the mutated line.
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — a guard that cannot fail because its precondition was defaulted away.
