---
"@namzu/cli": major
---

The CLI moves to the SDK's session → turn → message model and to one state
layout under `NAMZU_HOME` (default `~/.namzu`). Conversations, checkpoints,
memory and resident state written by 26.x are **not read** by this version.

**Before you upgrade.**

- **Run `namzu drain` on 26.x** until it reports nothing parked. A turn still
  parked on a decision or a provider wait when you upgrade cannot be resumed.
- **Export any conversation you want to keep** with
  `namzu history --session <id> > conversation.json` on 26.x (with no
  `--session`, the latest one in the folder); it prints the messages as JSON.
  There is no migration: nothing is imported, so nothing is lost silently or
  brought back half-read.

## What changes for you

- **Where state lives.** Each working directory gets
  `~/.namzu/projects/<slug>/`, where the slug is the directory's canonical
  path with every character outside `[A-Za-z0-9]` replaced by `-`. A session is
  `<session-id>.jsonl` there, with its child sessions, checkpoints, tasks,
  feedback, goals, tool-result spills and file-history snapshots under
  `<session-id>/`. Memory moves to `projects/<slug>/memory/`, resident state to
  `projects/<slug>/residents/`, and git worktrees to
  `projects/<slug>/worktrees/`. `~/.namzu/index.sqlite` is an index rebuilt
  from the logs whenever it is missing or out of date; deleting it loses
  nothing. The CLI still never writes into the working directory; `.namzu/`
  there is read only, for the agents, skills, commands, plugins and
  `MEMORY.md` you put in it.
- **Old state is left alone and reported.** `namzu state` now prints report
  `version: 2` with a `legacy` category: the old top-level `state/`,
  `sessions/`, `titles.json`, `desktop-sessions.json`, `delegation-history/`,
  `checkpoints/`, `tenants/`, `goals/`, `feedback/`, `learning/`,
  `residents/`, `worktrees/` and `memory/`, and every `projects/<uuid>/`
  directory. It lists their paths and sizes and never opens, moves or deletes
  them; remove them yourself once you have exported what you need. A new
  `projects/<slug>/` is never reported as legacy.
- **One turn at a time per session.** A session has at most one active turn.
  `namzu run` and `namzu run-stream` against a session whose turn is still
  running, paused or interrupted now exit **75** (EX_TEMPFAIL) and name that
  turn: on stderr for `run`, as an NDJSON
  `{"kind":"error","code":"turn_in_progress",…}` event for `run-stream`. 75
  keeps its existing meaning for a provider pause too; a wrapper that already
  retries later on 75 needs no change. In the TUI the refusal offers
  `/resume` or the new **`/abandon`**, which closes the paused turn so the next
  prompt can start.
- **A rate limit on the first request pauses the turn.** A provider rate
  limit or outage on a turn's first request used to fail it (`namzu run`
  exit 1) with nothing to continue; it now pauses it at a checkpoint like the
  same fault later in the turn: `namzu run` exits 75 naming the checkpoint,
  `--wait-for-provider` waits and resumes it, and `/resume` or `namzu drain`
  continues it.
- **`/agents runs` is now `/agents batches`**, with no alias. `/agents runs`
  prints the unknown-subcommand usage.
- **NDJSON gains ids.** `run-stream`'s `done` and `usage` events carry
  `sessionId` and `turnId`, and a `paused` event names its `turnId` instead
  of a run id.
- **Hooks.** The events `run_start`, `run_end` and `run_interrupt` are
  `turn_start`, `turn_end` and `turn_interrupt`; a config that names an old
  event is refused at load with a message naming the new one. A hook's stdin
  carries `turn_id` (not `run_id`) and, on `subagent_stop`,
  `parent_session_id` and `parent_turn_id` (not `parent_run_id`); its
  environment carries `NAMZU_TURN_ID` (not `NAMZU_RUN_ID`). `session_id` and
  `NAMZU_SESSION_ID` are always set. `session_start` and `session_end` hooks
  receive no turn id: the CLI no longer invents one for them.
- **`namzu drain`** keeps its flag names and exit codes (0, 1, 64, 77), but
  `--store` means something else: it was the `runs/` directory a checkpoint
  store wrote to, and it is now the namzu home (`NAMZU_HOME`, `~/.namzu` by
  default) whose `projects/` hold the session logs. A `--store` without a
  `projects/` directory is refused with 64, so a wrapper that still passes its
  old `runs/` path must pass the home instead. A scope the store does not hold
  (an unknown session, one under another project or tenant, a child session)
  is also 64; state that cannot be read is 1. It finds parked turns through
  the session index, takes each session's lease, and continues the same turn
  from its checkpoint; a turn whose session lease another worker holds is
  skipped and reported.
- **Delegation history is not carried over.** The history block and
  `/agents` read finished child sessions from their logs; children recorded by
  26.x do not appear.
- **Checkpoints.** A session keeps each turn's newest 10 checkpoints under
  `<session-id>/checkpoints/`; one an open decision references is never
  pruned. `/restore` snapshots are under `<session-id>/file-history/`.
- **Crash dumps are gone.** The session log and per-iteration checkpoints hold
  everything an interrupted turn needs, so no `emergency/` dumps are written.
  An interactive session that was interrupted closes that turn as interrupted
  when you send the next prompt.
- **A stopped process gives its conversation back.** On SIGTERM, SIGHUP (a
  closed terminal) or SIGINT, the TUI, `namzu run` and `namzu run-stream`
  release the conversation's writer lease first, then stop the turn, close
  the session (tool servers, background jobs, the `session_end` hook) and give
  the terminal back, and then die of the signal they were sent: a wrapper
  sees 143, 129 or 130 as before. The turn is left interrupted, so `/abandon`,
  `/resume`, `namzu drain` or the TUI's next prompt take it at once; before,
  they were refused as "leased by a live writer" for up to five minutes. A
  second signal exits immediately. `run-stream` writes
  `{"kind":"error","code":"terminated",…}` and a final `done` before it exits,
  and `run` names the session on stderr. SIGKILL still leaves the lease to
  expire. The message follows where the signal found the turn: a turn that
  had already ended (the session still closing) is reported as recorded, not
  interrupted, and `run-stream`'s one `done` is then the turn's own; a
  `run --wait-for-provider` stopped during its wait says the turn is paused
  at its checkpoint, and does not resume it.
