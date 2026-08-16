---
'@namzu/sdk': minor
---

Work that outlives one run: a durable objective on the Topic, advanced one round at a time.

Nothing in the kernel survived a single `query()` call. `stopWhen` and `prepareStep` shape one loop; the Topic was a container with no work state in it. A host wanting "keep going until X is done, stop safely if it stalls, let a human pause it" hand-rolled the store, the round cap and the compare-and-set outside the SDK.

New: `TopicObjective`, `InMemoryTopicObjectiveStore` / `DiskTopicObjectiveStore`, and `advanceObjective` / `driveObjective`.

The round is debited **before** the work runs. A counter advanced on success lets an objective that fails every round run forever, which is the runaway the cap exists to stop — so a round that crashes still counts, and a runner that throws leaves the objective `blocked` with a stated reason rather than `active`.

`driveObjective` bounds itself from the objective's own remaining rounds when the caller gives no budget, and throws `ObjectiveNotProgressingError` if a round completes without advancing the counter. Both came out of a mutation test: the first version defaulted to no bound, and breaking the debit turned it into a loop no timeout could interrupt — every `await` resolved as a microtask, so the event loop never reached a timer.

Interrupting is between rounds, never mid-round, via `signal`: the round in flight finishes and writes its verdict, and the next one does not start. A `paused` phase written by another host is picked up the same way, because the drive re-reads the record rather than trusting what it was handed.
