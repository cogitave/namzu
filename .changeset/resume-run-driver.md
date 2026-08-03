---
'@namzu/sdk': minor
---

Ship the driver that picks a run back up in another process.

Every piece of a cross-process resume already existed. `CheckpointManager` wrote the history, budgets, working state, trace context and any human-decision park; `loadRunState` read them back; `query` accepted `runId` + `resumeFromCheckpoint` and restored all of it — budgets included, so a run recalled at $4.80 of a $5 cap does not come back with a fresh $5.

Nothing joined them. `resumeFromCheckpoint` had no caller anywhere outside `packages/sdk/src`, so the whole path shipped untravelled: every host was expected to write the same wiring and none did.

`resumeRun` is that wiring. The division of labour is the one the mechanism already implies — the caller brings what cannot be serialized (the provider client, the tool registry, the sandbox, the working directory), the store brings the state. A snapshot deliberately holds no socket and no open file, so it could never have carried the first half.

It refuses at both failure points rather than guessing:

- **No checkpoint** returns `{ resumed: false, reason: 'no-checkpoint' }`. Starting a fresh run here would be a different run wearing a recycled id, with the original's budget reset.
- **An outstanding park** returns the `PendingDecision` itself, so the host has what to put in front of a person, instead of resuming past a question the run is waiting on. A park with `resolvedAt` already set is an ordinary resume — blocking on an answered one would strand the run permanently.

`RunStateScope` is exported alongside it. It was internal, so a host calling the already-public `loadRunState` could not name the argument it had to construct.
