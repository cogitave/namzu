---
uid: namzu.conventions.mutation-check-every-test
title: Mutate every test, and never trust a helper test to prove its caller
description: A passing test proves nothing until you have watched it fail. Break the thing it covers, confirm that that test and not a neighbour goes red, read the whole run rather than the summary line, and treat a table where everything dies as a map of what you have not tested rather than a proof.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-09
tags: [convention, testing, verification]
---

# Mutate every test, and never trust a helper test to prove its caller

Ratified 2026-08-04 from three sessions; amended 2026-08-06 with
"read the run, not the summary line".

A passing test proves nothing until you have watched it fail. Break the thing
it covers and confirm that *that* test, and not a neighbour, goes red.

## The rule

For every test that pins a behaviour:

1. Mutate the source it covers back to the broken state.
2. Confirm the intended test fails, and that tests asserting *preserved*
   behaviour still pass. Both halves matter — a mutation that fails everything
   says the tests are coupled, not that they are good.
3. Restore, and confirm green.

Record the mutation profile in the session log. "5 of 9 fail, and the 4 that
pass are the preservation cases" is evidence; "tests pass" is not.

## Six vacuous tests found this way in one session

- Asserted `dangling.hasDangling` where the property is `isValid`.
- A fallback-path test that never reached the fallback.
- "Normal urgency appends nothing" — twice, the second attempt tautological
  because `urgency ?? 'normal'` collapses the branches.
- `disconnect()` on a never-connected client, emitting nothing either way.
- Bookkeeping nothing read.
- Human-in-the-loop tests that all drove the bare-config branch and never the
  builder.

## A unit test on a helper does not prove the caller invokes it

This is the sharpest form of the rule, because both halves look green.

- `attachSteering` had 9 passing unit tests. All 9 still pass with the loop
  never calling it. Only the end-to-end file — a real run, with a tool that
  steers from inside its own `execute` — fails when the wiring is reverted.
- One driver's capability resolver had 27 passing tests. Reverting it to its
  old passthrough failed **none** of them; 5 of the 9 request-body tests
  failed instead.
- Counting `assertThinkingUnsupported(` call sites in source proves nothing
  about whether the guard fires. Each driver got a test that drives the real
  `chatStream`.

So: whenever a helper exists to be *called from somewhere*, one test must drive
the somewhere.

## Choose the mutation honestly

A mutation that produces a type-invalid state is not a fair one. Replacing
`if (override === 'disabled') continue` with `if (false) continue` left
`register(tool, 'disabled')` — a value outside the availability union — and the
catalog dropped the tool for the wrong reason, so the test passed by accident.
The honest mutation was reverting to the pre-fix line.

Conversely, a mutation that fails nothing can be correct: removing the lexical
pre-check from `resolveWithinReal` broke no test because the canonical check
catches traversal independently. That is defence-in-depth working. Two
mutations were needed to say anything true about one function.

## The harness itself can lie

A mutation script reported all five write-file mutations as *not caught*. All
five were caught — its failure-name regex did not survive an em-dash plus
terminal colour codes, and the child process was not merging its error stream.
It surfaced only because one result contradicted a failure watched by hand.

A harness that reports false negatives certifies vacuous tests as sound. Make
it print the summary line when it finds no failures, so "not caught" can be
told apart from "could not read the output".

## Read the run, not the summary line

`N passed` is a subset of the result, not the result. Read the **exit code**,
the **file count**, the **skip count**, and any **unhandled rejections**. Four
false greens in one session came from reading the summary and stopping:

- A fake run manager of `{ id }` broke `emitEvent`, which appends to the run
  store. Five unhandled rejections fired *after* the assertions passed: the
  suite exited 1 while every summary line read green. The exit code is now
  checked directly rather than inferred from the summary.
- Moving a host callback above the run manager's init produced 25 unhandled
  rejections — `RunDiskStore not initialized` — and the run still reported
  2763 passed.
- The formatter split an inline type import across lines with a trailing comma.
  The bundler rejected the file, it transformed to nothing, and the suite
  reported `no tests` for it while the summary looked ordinary. Caught only by
  the file count: 302 where 301 was expected. **A test file that fails to load
  is not a failing test — it is an absent one.**
- `156 passed | 35 skipped` was read as green. The 35 skips were the live
  contract tests and no credential was set anywhere. Supplied, the suite ran
  191 → 194 and every live file passed — and a live run then found a defect no
  mock could reach.

Record the shape of the run, not just its verdict: files, tests, exit code.

## A test that cannot run must say so

Symlink tests wrapped creation in try/catch and returned early on failure. On
one platform that reported three tests as **passed** having exercised nothing.
Use a capability probe and `it.skipIf`, so the reporter prints them skipped —
and do not claim the behaviour works until a run that actually executed them is
read.

A skip is a result to look at, not a rounding error. Platform-gated with the
reason written in the file is fine; a contract test skipped for want of a
credential is a hole wearing a green summary.

## A kill has a size, and one unit is not a kill

Amended 2026-08-09.

"The mutation killed it" is not the whole result. **By how much** is part of it,
and when the margin is one unit the fixture is doing the discriminating rather
than the code.

A test asserted that the composer stops being padded down the screen once an
expanded tool body fills the viewport. It measured the longest run of blank rows
in the frame and required it under 4. Mutating the caller to stop measuring tool
bodies produced **4** — a kill, by one row.

That is a coin toss dressed as evidence. The terminal height was 24, and at 24
the live furniture and safety margin leave so little budget that the *unmeasured*
transcript also comes out barely padded: both answers were pressed against the
same floor and the assertion's threshold happened to fall between them. A
slightly taller live region, a slightly different safety constant, or a fixture
one row longer, and the same defect passes.

At 40 rows the two answers separate properly — **20 against 4** — because there
is room for the wrong estimate to be wrong in. Nothing about the code changed;
the fixture stopped compressing the difference.

**So: record the numbers, not the verdict.** `expected 20 to be less than 4` is
evidence. `expected 4 to be less than 4` is a warning that the next person to
touch an unrelated constant will silently turn this test into decoration. If a
mutation kills by a hair, re-size the fixture until the two answers are far
apart, and if they will not separate, the assertion is measuring the wrong
quantity.

This is the quantitative sibling of the fixture rule below: there, the setup
never reaches the defect's branch; here, it reaches it and then squeezes the
result until the difference will not fit.

## The inverse: a test whose green depended on the defect

Mutation asks whether a test fails when the code breaks. The rarer case is a
test that passed *because* the code was already broken, and it announces itself
by failing when you fix something unrelated to it.

Fixing the composer unmount broke a `/permissions` test. It typed a slash
command straight after a permission cycle, and had only ever worked because the
composer was being emptied for it; with the draft preserved, the command was
appended to the leftover text and submitted as prose.

There is no automated form of this, so the tell is the discipline: **a test that
starts failing when you fix a defect may have been depending on it.** Read the
failure as evidence about the old behaviour before adjusting the test, and
record why the adjustment was needed — otherwise the next reader sees an
unexplained edit to an unrelated test in a bug-fix diff.

## A kill that exists and is not evidence

Three independent sightings in one night, across three agents, of one shape:
**the mutation was restored, something did go wrong, and what went wrong was
not a failing test.**

- A mutation made a cursor a no-op, and three paging tests looped on that
  cursor with nothing stopping them. The suite **hung** instead of going red.
  A stall reads as flaky infrastructure and gets retried; a failure names the
  defect. Bounded every walk, and the same mutation then killed six tests in
  under a second.
- A test process was **killed on a timeout** at fifteen seconds. The kill is
  not a verdict on the code — it is a verdict on nothing at all — and it
  arrives looking exactly like one.
- A mutation's **margin vanished at a particular fixture size**, so the same
  mutation killed or did not depending on how much data the fixture carried.

The rule that follows: a mutation run yields three outcomes, not two — killed,
survived, and *did not answer*. Only the first two are evidence. Treat a hang,
a timeout kill, a crash before assertions, or a result that moves with fixture
size as an unanswered mutation and fix the harness or the test until it
answers. A table that folds "did not answer" into either column is reporting a
number it did not measure.

The same applies to the anchors a text-matching harness uses. They go stale
**exactly when the code they guard changes**, which is the only time any of it
matters, and a harness that skips a stale mutation and prints the rest reads
green while guarding less than it claims. Make a zero-match or a multi-match
anchor abort the run rather than become a row — a multi-match is the worse
one, because a string replace takes the first occurrence and reports a kill
for a mutation it only half made.

## A table where everything dies is not a proof

Thirteen mutations, aimed carefully, every one killed. An adversarial review
then reproduced **four** defects in the same file, from separate OS
processes, and not one of them was caught by any of the thirteen.

They could not have been. A mutation table is evidence about the paths the
tests **reach**, and all four lived in one branch — a stale lock being broken
by two workers at once — that no test entered. No mutation of code nothing
executes can fail anything, so the branch was invisible in exactly the way a
green table makes things invisible: it did not appear as a survivor, because
a survivor is a mutation you ran.

That is the fourth category, and it sits behind the three above. *Killed*,
*survived* and *did not answer* all describe mutations you ran. The fourth is
**the branch you never mutated, because no test would have noticed either
way.**

So: **the correct reading of a table where everything dies is not "the code
is proven". It is "aim next at the branches nothing covers" — and the table
itself tells you which those are.** Every mutation that died names a line
your tests execute. The lines that appear in no row are the map of what you
have not tested, and a full-green table is that map at its most complete.

Read it that way and the next move is mechanical: list the branches of the
thing you just proved, strike out the ones a mutation touched, and write a
test for what is left. The dangerous ones cluster where a comment says
"cannot happen", where two operations stand in for one, and on the failure
path of a guard — places a test has to be written *deliberately*, because
nothing about the happy path leads to them.

The stronger move, when the remaining branches are the concurrent or
partially-failed ones, is to delete them rather than cover them. The file
that produced these four was rebuilt so the dangerous operation does not
exist — the ordering became a filename, taking a run became a single
exclusive create, and the lock, the breaker and the window all went with it.
A branch that is gone needs no test and cannot rot.

## Related

- [A declaration nothing drives is a defect](declared-but-undriven.md)
- [Never filter a verification down to something that can read green](never-filter-a-verification.md)
  — the reading half of this rule, and its own incident.
- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — mutation proves a test *can* fail; it does not prove it measures what
  matters.
- [A fixture unlike production tests a system that does not ship](fixture-must-match-production.md)
  — the setup that makes a mutation profile refuse to move.
