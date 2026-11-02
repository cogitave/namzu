---
'@namzu/sdk': minor
---

A workflow run can now be resumed. Nothing breaks: every new field is optional and the new run options default to the old behaviour.

- `WorkflowRunOptions.resume` (build it with `loadWorkflowResume(await journal.read())`) makes agents whose prompt and options are unchanged return the result saved in the journal instead of running. The first call that is new, edited, failed or was skipped ends reuse for the rest of the run; agents cut off by a stop, a closed session or the token budget run again without ending it. `usage.cachedAgents` and `WorkflowAgentEvent.cached` report the replays.
- `FileWorkflowJournal` now numbers and chains every line (`seq`, `prev`), can sign them (`new FileWorkflowJournal(dir, { runId, key })`), writes saved results and pass boundaries with `fsync`, serialises appends per file and drops a late record after a pass's `run_finished`. `read()` returns the records that passed the check. A journal written by an older version reads as `legacy` and is reported as not resumable; custom `WorkflowJournal` implementations keep working and may ignore the new fields and the optional third `writeScript` argument.
- `WorkflowRunOptions.deterministic` makes `Date.now()`, `new Date()` with no argument and `Math.random()` throw and removes `eval`. It defaults to `false`, so existing embedders are unchanged; set it for scripts you intend to resume.
- New exports: `loadWorkflowResume`, `readWorkflowJournalChecked`, `workflowCallKey`, `formatWorkflowJournalLine`, `workflowJournalSeed`, `workflowJournalLineHash` and the types `WorkflowResumeState`, `WorkflowJournalReader`, `CheckedWorkflowJournal`, `ChainedWorkflowJournalRecord`, `WorkflowCallIdentity`. `WorkflowAgentOutcome.sessionId` lets a host record where an agent ran.
- `FileWorkflowJournal.read()` and appends without `options.runId` take the run id from the file's first `run_started` (then the folder's parent name), so an embedder that keeps a journal in its own folder reads it back whole.
