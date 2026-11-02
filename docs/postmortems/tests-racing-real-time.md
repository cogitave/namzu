---
type: Postmortem
title: Tests that raced real time
description: Tests that decided their outcome against a real timer failed on loaded machines with nothing broken; they now use fake timers or wait on the real event.
resource: AGENTS.md
tags: [postmortem, testing, flaky-tests, ci]
status: stable
---

# Tests that raced real time

## What happened

Several tests failed on loaded CI runners and on a machine under CPU load,
and passed when run alone. Examples recorded in the history:

- A stalled-advisor test raced a 10 ms idle watchdog against a hand-written
  1000 ms real-time safety net. Under load the legitimate path outlasted the
  net, which aborted the caller, and the run ended `cancelled` instead of
  `completed`. A sibling test guarded two real waits with its own 500 ms and
  200 ms timers and failed with "advisor request did not start" before the
  request had failed to start.
- A paging test that drives a real renderer and terminal parser took about
  5.9 s at rest and about 25 s on two loaded cores, past the package's shared
  15 s timeout.
- A sandbox confinement file starts a real worker and interpreter for every
  test; under CPU starvation four of four files failed at 150 busy loops on two
  cores, so the framework's default timeout decided the outcome.
- Fake-guest sockets in a sandbox backend test had no error listener, so a
  reset connection became an uncaught exception that failed whichever test
  happened to be running.

## Mechanism

Each test measured how fast the machine was, not whether the code was right. A
guard such as `Promise.race` against a real `setTimeout`, a `'hung'` sentinel,
or a poll with a wall-clock deadline reads as "prove this does not hang" but
trips whenever the real work legitimately takes longer than the guard.

## What was changed

- The racing guards were replaced with fake timers advanced deterministically,
  or with awaiting the real event and letting the framework's own per-test
  timeout catch a genuine hang.
- A legitimately slow test (real subprocess, socket or file-system work) gets
  its own raised timeout with a comment saying why.
- Each fix was checked by repeated runs under CPU starvation (processes pinned
  to a core with competing busy loops).
- The rule is stated in `AGENTS.md` under Build & Test, and CI is reproduced
  locally by running with `CI=true GITHUB_ACTIONS=true` pinned to two cores.

## The lesson

See [Failure classes](failure-classes.md#an-outcome-decided-by-machine-speed).
