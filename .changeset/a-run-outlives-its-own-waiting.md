---
'@namzu/sdk': patch
---

a run no longer kills its own process while waiting, mid-turn, and report success

`namzu run` and `namzu run-stream` could not finish a turn. The first tool call
completed and the process ended: no second turn, nothing written, no terminal
event, **exit code 0**. A user asking for a two-step task was told nothing had
gone wrong while nothing had been done.

Every human-in-the-loop park went through a timer that was deliberately
`unref`'d, so a pending park-recorder could never hold a process open after the
run settled. The hazard is real and the intent was right; the scope was wrong.
That promise is **awaited during the run**, on every park, including the
automatic ones a headless run resolves instantly. An `unref`'d timer does not
keep Node's event loop alive — so once the decision resolved and the run sat out
the rest of the delay, the loop had nothing left in it that counted, and the
process exited from under the run.

The timer is cancelled now instead of unref'd. It stays ref'd while the run is
genuinely waiting on it, and is cleared the moment the decision arrives, so
nothing dangles past the run either. A park that had already begun recording is
still awaited, so the unpark cannot race it.

Measured before and after on the same command: before, three events and an
unchanged file; after, the edit applied and a terminal event.

**Why no test caught it.** A test runner holds the event loop open for the whole
file, which is exactly the prop this bug hides behind — the entire suite passed
throughout, including tests that drive real runs against a live provider. The
regression test therefore spawns a real `node` process with nothing else in it,
and lives in its own suite (`pnpm --filter @namzu/sdk test:proc`, run as its own
CI step) because the spawn competes for CPU hard enough to flake the
timing-sensitive tests beside it.
