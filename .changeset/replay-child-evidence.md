---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Open a finished delegated child from the evidence it already writes to disk.

**`@namzu/sdk`** gains one static method and the type it returns:
`RunDiskStore.listChildren(baseDir, parentRunId)` and `DelegatedChildRun`. It
walks `<baseDir>/<parentRunId>/children/`, reads each child's `run.json`, and
reports the run id, its directory, and whatever the file recorded of the agent,
the model, the status, the timings and the token total. Every field from the
file is optional: `run.json` is written on a run's terminal path, so a child
killed before it got there leaves a transcript worth reading and no recorded
ending, and absent means "the file did not say" rather than zero.

Additive. Nothing existing changed, and in particular **`listRuns` is
unchanged** — do not read this as a fix to the index. `addToIndex` still
returns early for any run with a `parentRunId`, so a delegated child still
never appears in the browsable catalogue, which is what keeps it out of a
host's conversation listing. `listChildren` is the separate read for a caller
that wants the evidence anyway. It performs no writes: binding a `RunDiskStore`
to a run creates that run's directory, which is why discovery is a static walk
and not a bound method.

**`@namzu/cli`** can now open a delegated child that is no longer live — evicted
by the activity monitor's eighty-agent bound, or left behind by a process that
has since exited. The agent cockpit lists it from disk and drills into its saved
transcript, rebuilt through the same projection a live child renders through, so
the past and the present look alike.

It cannot be continued, and the screen says so: a replayed row is marked `saved`,
its transcript is headed `Replayed from saved evidence. This child cannot be
continued.`, it never appears in the live panel above the composer, and there is
no message or cancel affordance on it. Resume has never restarted delegated
tasks or reconnected their processes, and opening one does not either. Replay is
read-only — no file is written, moved or pruned by looking at a past run — and a
torn transcript opens with the records that could be read plus a row saying it is
partial; one that cannot be read at all opens with that row alone, beside what
`run.json` recorded, rather than dropping the child from the list.

Two limits worth knowing before relying on it. Streaming deltas never enter a
run's durable log, so a replayed transcript carries tool calls, their results and
any failure text but not the assistant prose that streamed between them; the
child's `report.md` holds its answer. Delegation lifecycle events enter no log
either, so a replayed child's `workflow` and `phase` labels are not recovered:
saved children are grouped by the parent run they belonged to and carry the
unlabelled default workflow, as a live child launched without labels does.

Child run directories accumulate and nothing prunes them. That predates this
change — the directories were always written — but this is what makes the growth
visible. Reclaiming the space today means deleting `children/` directories by
hand; a prune command is follow-up work.
