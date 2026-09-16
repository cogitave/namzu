---
"@namzu/cli": minor
---

List past and running orchestration runs with `/agents runs`, a third
subcommand beside `/agents running` and `/agents available`.

Each row is one parent turn that delegated at least one child: its name, when
it started, the phases its children reported, agents done/total, tokens spent
and elapsed time — the same shape `/jobs` prints, newest run first. A run still
going is read straight from the live monitor; a finished one is read cheaply
from disk, one `run.json` per child, without opening any child's transcript.
A finished run has no `workflow` label to show — that annotation never
survives a restart — so its name is the opening words of the parent turn
instead; a live run still shows its `workflow` label when one was set. The
listing is capped at 20 rows, newest first, with an omitted count beyond that,
matching the delegation-history archive's own bound. An empty history says so
in words rather than opening an empty picker, and `/agents` with an
unrecognised subcommand still shows usage.

Enter opens the selected run in the same cockpit `Ctrl+T` opens, landing
directly on the first agent's transcript — so a finished run's `Replayed from
saved evidence. This child cannot be continued.` banner is the first thing on
screen, and nothing on it offers to message or cancel work that already ended
in another process.

Additive: a new subcommand and a new optional `listOrchestrationRuns()` on the
session object the TUI already builds. Nothing existing changed.
