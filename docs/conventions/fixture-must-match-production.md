---
uid: namzu.conventions.fixture-must-match-production
title: A fixture unlike production tests a system that does not ship
description: The assertion is right and the observation point is right, and the test still proves nothing, because the setup never enters the branch the defect lives in. A harness is a configuration.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-06T00:00:00Z
lastReviewed: 2026-08-07
tags: [convention, testing, verification]
---

# A fixture unlike production tests a system that does not ship

Ratified 2026-08-06.

The assertion is right and the observation point is right, and the test still
proves nothing — because the setup never enters the branch the defect lives in.
A harness is a **configuration**, and a configuration production never runs in
describes a different system.

The sharpest form is an optional subscriber. Code inside `for (const listener of
set)` cannot throw when the set is empty, so a defect there is invisible to
every test that attaches no listener — and visible on every production run,
because production always attaches one.

## The rule

For every optional or defaulted thing in the fixture — a listener, a callback,
an injected dependency, an ambient runtime — ask whether production runs with it
on. If production always attaches it, the fixture attaches it.

And ask the inverse: **can any real caller produce the state this fixture is
in?** If not, everything standing on it is about a system that does not exist,
and its greenness is not a fact about the product.

Build collaborators the way the product builds them. A hand-assembled one is a
second implementation whose divergence from the real one is exactly the space a
defect hides in.

## The one that shipped

`sendMessage` handed a progress tee into the spawn, and the tee read
`task.taskId` — the `const` that the very same `await` assigns. A child that
emitted anything before the spawn resolved hit the temporal dead zone and killed
its own launch with `Cannot access 'task' before initialization`.

Two things kept it hidden, and both are this rule:

- A single sequential launch usually resolves before the child speaks, so
  ordering rarely bit. A **concurrent fan-out** is the production shape.
- The throw only occurs when a progress listener is **attached**. With an empty
  subscriber set the loop body never runs and the dead zone is never entered.
  Production always has one — the delegation tool attaches it for the idle
  bound. No unit test did.

It was live from the release that introduced the idle bound until it was found
by running the *published* package against the real service. Not by the
2700-test suite, which was green throughout.

Its regression test nearly repeated the defect: the first four cases attached no
progress listener — including the one literally named *"survives a concurrent
fan-out, which is how this was found"*, which therefore did not reproduce what it
was named after. Attaching the listener took the mutation from 1 of 4 failing to
3 of 4.

## Four more, same shape

- **The runner was holding the event loop open.** A run's own pending work did
  not keep its process alive: a bare `drainQuery` in a plain process died at
  `tool_review_requested` with `getActiveResourcesInfo() === []`, and the
  identical run completed when an unrelated ref'd interval held the loop open.
  Every test passed — including live-service ones — because the test runner *is*
  that interval. The regression test has to spawn a child process; in-process it
  is unwritable, and making it opt-in would have been the same trap again.
- **Incomplete dependencies meant the work never happened.** A hand-built
  `AgentManager` with partial deps never ran its children, so `allocations`
  stayed empty — indistinguishable from a pass.
- **A stub that could not survive being used.** A fake run manager of `{ id }`
  broke `emitEvent`, which appends to the run store. Five unhandled rejections
  fired after the assertions passed; the suite exited 1 while every summary line
  read green.
- **A fixture state no run can produce.** Eight task-listing tests seeded a
  gateway with tasks the tool set had never launched — precisely the sibling-run
  state that run-scoping later refuses. They broke when the scope landed, and
  they were the finding, not an obstacle: they had been describing a gateway
  state no run can reach. Rewritten to launch through the delegation tool first,
  they now cover launch then list. Weakening the scope to keep them green would
  have been fixing the test by reopening the hole.

## The tell

The defect is inside a subscriber loop, an `if (opts.x)`, a `catch`, or a branch
guarded by an optional dependency. Anything default-off in a fixture and
default-on in production is this rule waiting to happen.

A second tell: the test constructs a collaborator with an object literal. Ask
what the real one does that yours does not — and whether the difference is the
branch you are trying to cover.

A third: the property under test is about **concurrency or ordering**, and the
fixture does one thing at a time.

## Related

- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — the observation is wrong there; the setup is wrong here.
- [Mutate every test](mutation-check-every-test.md) — mutation is what exposes
  it. Both fan-out cases above were caught by watching the mutation profile fail
  to move.
- [A declaration nothing drives is a defect](declared-but-undriven.md) — a
  fixture that bypasses the surface a host constructs produces the same green
  suite over the same dead wiring.
