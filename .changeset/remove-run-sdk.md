---
"@namzu/sdk": major
---

The run is gone. The kernel's model is now **session → turn → message**: a
session is one conversation with one agent, a turn is one unit of work inside
it (a prompt, a goal round, a resident step, a verification step), and a
subagent is a child session. Each session is recorded in one append-only,
hash-chained JSONL log under `NAMZU_HOME`, and that log is the source of
truth; SQLite is only an index rebuilt from the logs. See
`docs/sdk/session-log.md` for the record schema.

**Before you upgrade: resolve or abandon parked runs on 43.x.** Run
`drainRuns` (or `resumeRun`) on the old version until nothing is parked. This
version cannot read a run tree, a `RunState`, an old checkpoint or an old token
ledger, so a run still parked when you upgrade cannot be resumed. There is no
migration.

## What breaks

**Identity and ids.**

- `RunId`, `generateRunId`, `asRunId`, `parseRunId` and `isEntityId(v, 'run')`
  are removed. Use `TurnId`, `generateTurnId`, `asTurnId`, `parseTurnId` and
  `'turn'`. A new `RecordId` names a log record.
- Every `generate*Id` mints a UUID version 7 instead of v4, so ids sort by
  creation time as strings. Every id check still accepts versions 1 to 8.
- Anywhere a `runId` field named the owner of something, it is now
  `sessionId`, plus `turnId` where the thing belongs to one turn:
  `ToolContext` (third-party tools read `context.sessionId` and
  `context.turnId`), the context a guardrail receives, `StepResult`,
  `PrepareStepContext`, `AnswerReviewContext`, probes and provider
  instrumentation, deliverables, plans and approval requests, bus owners,
  background-job owners, tasks, working memory and `HandoffLockRejected.details`
  (`turnId: TurnId`).
  `parentRunId` becomes `parentSessionId` plus `parentTurnId`.

**Core types (rename, same meaning unless noted).**

| Removed | Use |
|---|---|
| `Run`, `AgentRun`, `AgentSession` | `Turn`, `AgentTurn` (`Turn` gains `sessionId`; `replayOf` becomes `forkedFrom`) |
| `RunExecutionStatus`, `RunStatus`, `deriveRunStatus` | `TurnExecutionStatus`, `TurnStatus`, `deriveTurnStatus` (same members) |
| `RunCancelled` | `TurnCancelled` |
| `AgentRunConfig`, `RunConfigSnapshot`, `RunMetadata`, `RunStateMetadata` | `TurnConfig`, `TurnConfigSnapshot`, `TurnMetadata` |
| `RunPersistence`, `RunPersistenceConfig` (`.runConfig`) | `TurnRecorder`, `TurnRecorderConfig` (`.turnConfig`; `pruneKeepLast` stays on it) |
| `RunEvent`, `RunEventListener`, `PersistedRunEvent`, `RUN_EVENT_SCHEMA_VERSION`, `RunEventSchemaVersion` | `SessionEvent`, `SessionEventListener`, `SessionRecord`, `SESSION_RECORD_SCHEMA_VERSION`, `SessionRecordSchemaVersion` (the event field `schemaVersion` becomes the record field `v`) |
| `RunEventCursor`, `RunEventReplay`, `RunEventReplayRefusal`, `RunEventLogHead`, `resolveRunEventReplay` | `SessionLogCursor`, `SessionLogReplay`, `SessionLogReplayRefusal`, `SessionLogHead`, `resolveSessionLogReplay` |
| `RunState`, `RUN_STATE_VERSION`, `parseRunState`, `RunStateVersionError`, `captureRunState`, `loadRunState`, `RunStateScope` | `TurnState`, `TURN_STATE_VERSION` (1), `parseTurnState`, `TurnStateVersionError`, `captureTurnState`, `loadTurnState`, `loadSelectedTurnState`, `TurnStateScope`. `parseTurnState` refuses a `RunState` by name. |
| `resumeRun`, `ResumeRunParams` | `resumeSession`, `ResumeSessionParams` (same outcomes: `no-checkpoint`, `awaiting-decision`, `resumed`) |
| `claimRun`, `releaseRun`, `RunLease`, `ClaimRunOptions` | `claimSession`, `releaseSession`, `SessionLease`, `ClaimSessionOptions` |
| `drainRuns`, `DrainRun`, `DrainRunsParams`, `DrainRunsResult` | `drainParkedTurns`, `DrainTurn`, `DrainTurnsParams`, `DrainTurnsResult` |
| `listDurableRuns`, `paginateDurableRuns`, `toDurableRunEntry`, `DurableRunEntry`, `DurableRunOrder`, `DurableRunPage`, `ListDurableRunsOptions`, `CheckpointListingScope`, `assertContiguousListingScope` | `SessionIndex.listTurns` and `listPendingDecisions`; `DurableTurnEntry`, `DurableTurnOrder`, `DurableTurnPage`, `ListDurableTurnsOptions` |
| `DelegatedChildRun`, `ChildRunStorage`, `RunHierarchyNode` | `ChildSessionSummary` (`SessionIndex.listChildren`), `ChildSessionStorage`, `SessionTreeNode` |
| `replayRun`, `RunSummary` | `replayAudit`, `AuditSummary`. Audit entries are `audit` records in the session log; `AuditEvent.runId` becomes `turnId?`. |
| `RunQuery`, `RunQueryOptions`, `RunTranscriptUnavailableError`, `RunTranscriptUnavailableReason` | `SessionQuery`, `SessionQueryOptions`, `SessionTranscriptUnavailableError`, `SessionTranscriptUnavailableReason` |
| `RunReporter`, `createRunReporter`, `recordRunDuration` | `TurnReporter`, `createTurnReporter`, `recordTurnDuration` |
| `RunApprovalPolicy` | `SessionApprovalPolicy` (`ApprovalPolicy` is unchanged and still the `{ name, handler }` value) |
| `RunEvidence*`, `RunTextEvidence*`, `DiskRunEvidenceOptions`, `createDiskRunEvidenceSource`, `createDiskRunTextEvidenceSource` | `SessionEvidence*`, `SessionTextEvidence*`, `SessionEvidenceSourceOptions` (`{ scope, logPath, … }`), `createSessionEvidenceSource`, `createSessionTextEvidenceSource`; `ToolContext.captureRunEvidence` becomes `captureSessionEvidence`. Its source's scope is the session, not the turn: it reads every earlier turn in the session log and the running turn up to its latest record (the old capture read the running run's own transcript and nothing else). A reader for one turn only is `createSessionTextEvidenceSource` with `scope.turnId` over the session log. |
| `RUN_STATUS_READ_MODEL_ID`, `RunStatusReadModelOptions`, `RunStatusState`, `createRunStatusReadModel` | `SESSION_STATUS_READ_MODEL_ID`, `SessionStatusReadModelOptions`, `SessionStatusState`, `createSessionStatusReadModel` |
| `SharedRunWorkspace*`, `RegisterSharedRunPlanInput` | `SharedSessionWorkspace*`, `RegisterSharedSessionPlanInput` |
| `BidiRun`, `BidiRunParams`, `BidiRunEvent`, `startBidiRun` | `BidiTurn`, `BidiTurnParams`, `BidiTurnEvent`, `startBidiTurn` |
| `deriveRunOptions`, `DeriveRunOptionsInput` | `deriveTurnOptions`, `DeriveTurnOptionsInput` |
| `EvalRun`, `evalRunFromQuery`, `evalRunFromRun` | `EvalTurn`, `evalTurnFromQuery`, `evalTurnFromTurn` |
| `RunMemoryCandidate`, `RUN_MEMORY_TAG` | `SessionMemoryCandidate`, `SESSION_MEMORY_TAG` |
| `SubsessionSpawnedEvent`, `SubsessionMessagedEvent`, `SubsessionIdledEvent`, `SubsessionLifecycleEvent` | `ChildSessionSpawnedEvent`, `ChildSessionMessagedEvent`, `ChildSessionIdledEvent`, `ChildSessionLifecycleEvent` |
| `ReadRunEventsOptions` | `ReadSessionLogOptions` |
| `CheckpointRunScope` | `CheckpointScope` (`{ tenantId, projectId, sessionId, turnId }`) |
| `ReplayAttribution` (`Run.replayOf`) | `TurnForkOrigin` (`Turn.forkedFrom`, `{ sessionId, turnId, checkpointId }`) |
| `validateTokenBudgetSnapshot`, `OpenTokenBudgetOptions`, `DiskTokenBudgetStoreConfig` | `validateSessionTokenBudgetSnapshot`, `OpenSessionTokenBudgetOptions`, `DiskSessionTokenBudgetStoreOptions` |
| `TurnStatusResolver.blockingRun`, the handoff deps field `runStatus` | `blockingTurn`, `turnStatus` (on `SingleHandoffDeps` and the broadcast deps) |
| `Agent.forRun()`, `AbstractAgent.forRun()` | `forTurn()` |
| `AgentHandle.queueForNextRun()` | `queueForNextTurn()` |
| `CaseResult.run` | `CaseResult.turn` |
| `AdvisoryBudget.maxCallsPerRun`, `maxCostPerRun` | `maxCallsPerTurn`, `maxCostPerTurn` (the advisory stack is built per turn, so the bound always was) |

**`query()`, `drainQuery()` and `runAgent()`.** `query()` is now
`AsyncGenerator<SessionEvent, Turn>` and `drainQuery()` resolves to a `Turn`.
`QueryParams.runConfig` is `turnConfig`. `runStore`, `pathBuilder`,
`claimFence`, `emergencySave` and `supersedesEmergencySave` are gone
(`ReactiveAgentConfig.emergencySave` goes with them); pass
`paths` (a `SessionPaths`), `sessionLog`, `checkpointStore`, `lease`, `budget`
and `tokenBudgetStore` instead, and `turnId` with `resumeFromCheckpoint` to
continue a turn. `RunAgentResult.run` is renamed `turn`; `runAgent`,
`RunAgentOptions` and `RunAgentResult` keep their names.

**One active turn per session.** Starting a turn while the session has one
running, paused or interrupted throws `TurnInProgressError` (`sessionId`,
`activeTurnId`, `state`); `isTurnInProgressError` recognises one across package
copies. A paused turn is continued with `resumeSession` (same `turnId`) or
closed with the new `abandonTurn(sessionId, turnId, reason)`. Parallel work
goes to child sessions or separate sessions. Manual compaction between turns is
`compactSession`.

**A rate limit on a turn's first request pauses it.** A retryable provider
fault (a 429, an outage, a stalled stream) that survives the retries used to
fail the turn when it hit before the turn's first checkpoint, which in
practice meant its first request; the same fault one request later paused
it. It now pauses there too, on a checkpoint of the turn where its loop began
(`iteration: 0` for a fresh turn, the restored count for a resumed one), and
`resumeSession` restarts the turn from where that loop began: whatever the
failed iteration produced before the fault (a partial `max_tokens` answer, a
continuation prompt) is not in the resumed request. So after such a
fault the session holds a paused turn, and the next `query()` or `runAgent`
in it throws `TurnInProgressError` until the turn is resumed or closed with
`abandonTurn`: a caller that retried by starting a fresh turn resumes instead.
The returned `Turn` has `stopReason: 'paused'` rather than `status:
'failed'`, the event is `turn_paused` rather than `turn_failed`, and a paused
turn's `lastProviderError` now carries the classification (retry delay
included) that only a failed turn carried before. A permanent fault still
fails the turn.

**Event literals.** `run_started`, `run_completed`, `run_failed`, `run_paused`
and `run_resuming` are `turn_started`, `turn_completed`, `turn_failed`,
`turn_paused` and `turn_resuming`. `subsession_spawned`, `subsession_messaged`
and `subsession_idled` are `child_session_spawned`, `child_session_messaged`
and `child_session_idled`. Every event drops `runId`, carries `sessionId`, and
carries `turnId` inside a turn. The other 54 literals are unchanged.
`isEphemeralEvent` is now exported at runtime.

**Other string literals.** `HandoffLockRejectedReason` (and
`HandoffLockRejected.details.reason`) `'active_run'` is `'active_turn'`.
`ResidentConsumptionAttempt.receiptStatus` `'duplicate-run'` is
`'duplicate-turn'`. A caller that compares either value must match the new
one.

**Delegation records.** The parent turn appends `child_session_spawned` and
`child_session_ended` to its own log, reading them from the task scheduler's
new optional `onChildSessionEvent(callback)`. `LocalTaskScheduler` and
`DelegatingTaskScheduler` implement it. A host `TaskScheduler` that does not
still delegates, but its parent log names no children, so `SessionIndex`
cannot list them: implement it to keep them listable.

**Storage.**

- `RunStore`, `RunDiskStore`, `InMemoryRunStore` and `RunStoreConfig` are
  removed, with `writeRunMeta`, `writeMessages`, `readMessages`, `writeReport`,
  `addToIndex`, `listRuns` and `listChildren`. Use `SessionLog`
  (`DiskSessionLog`, `InMemorySessionLog`): metadata comes from records,
  messages from `foldSessionMessages`, and listing from `SessionIndex`
  (`openSessionIndex`, `SqliteSessionIndex`, or `ScanSessionIndex` where
  `node:sqlite` is unavailable). `readRunEventsIn` and `readRunMessagesIn` are
  `readSessionLog` and `foldSessionMessages`. `RunMessageSnapshot` is removed.
- `CheckpointStore`, `DiskCheckpointStore` and `InMemoryCheckpointStore` are
  `SessionCheckpointStore`, `DiskSessionCheckpointStore` and
  `InMemorySessionCheckpointStore`, keyed by `CheckpointScope { tenantId,
  projectId, sessionId, turnId }`. `prune(scope, keepLast)` is **required**; it
  was the optional `pruneCheckpoints`. A checkpoint document holds no messages
  and is refused on restore when it no longer matches its log. A child
  session's checkpoints are in its own directory,
  `<parent-session-dir>/subagents/<child-id>/checkpoints/`; a
  `DiskSessionCheckpointStore` you build for a child takes that place as its
  `session` option (`DiskSessionLog.locator`, which a log opened from its
  file path reads from that path, and which names the right place only for
  a file in that project's layout).
  `IterationCheckpoint` and the kind `run-checkpoint` are replaced by the
  `Checkpoint` document (`kind: 'checkpoint'`); an old one is refused by name.
- `TokenBudget`, `TokenBudgetStore`, `DiskTokenBudgetStore`,
  `InMemoryTokenBudgetStore`, `openTokenBudget` and their snapshot types are
  `SessionTokenBudget`, `SessionTokenBudgetStore`,
  `DiskSessionTokenBudgetStore`, `InMemorySessionTokenBudgetStore`,
  `openSessionTokenBudget` and `SessionTokenBudget*Snapshot`. The ledger is
  keyed by `(rootSessionId, rootTurnId)`, so each root turn has its own limit
  and a limit changed between turns no longer throws `Token budget root limit
  mismatch`. `TokenBudgetBinding` is `TurnBudgetBinding`. A version 1 snapshot
  is refused.
- `SessionStore.appendMessage`, `replaceMessages`, `loadMessages` and
  `loadSessionMessages` are removed: messages are written only by the turn
  recorder and read with `foldSessionMessages`. A custom `SessionStore` drops
  those methods. `SqliteSessionStore` and `SqliteSessionStoreConfig` are
  removed; `SessionIndex` replaces them.
- Tasks live under `<session-id>/tasks/<task-id>.json`, one store per
  session: `DiskTaskStoreConfig` is `{ paths, session, tenantId?, logger? }`,
  and a store opened on another session's tasks throws
  `TaskSessionMismatchError`. Each task records the turn that created it;
  `selectTaskContext(tasks, { turnId, turnStartedAt })` gives the tasks a turn
  sees (every open task, plus those it closed). The task tools take a
  `TaskToolScope` of `{ sessionId, turnId, turnStartedAt }`.
- `MessageFeedbackStore` is keyed by `(sessionId, messageId)` under
  `<session-id>/feedback/`, and feedback on a message the session log does not
  hold throws `UnknownMessageError`.
- Custom log backends are checked with `defineSessionLogConformance` from
  `@namzu/sdk/testing`. `defineCheckpointStoreConformance` and its types are
  removed, and so are `CHECKPOINT_STORE_CONTRACT_VERSION`,
  `CheckpointStoreCapabilities` and `DiskCheckpointStoreAttribution`: a
  checkpoint store is keyed by `CheckpointScope`, and `prune` is part of the
  interface rather than a capability to probe.
- `validateTokenBudgetBinding` is removed with no replacement of its own. It
  checked the budget binding a checkpoint carried; a checkpoint's binding is
  now checked with the rest of the document by `parseCheckpoint` (the
  `budget.binding` of `CheckpointSchema`).

**The emergency surface is removed.** `EmergencySaveManager`,
`EmergencySaveData`, `EmergencySaveConfig`, `EmergencySaveConfigSchema`,
`EmergencySaveId`, `generateEmergencySaveId`, `asEmergencySaveId`,
`EMERGENCY_DIR_NAME`, `EMERGENCY_EVENTS`, `EMERGENCY_SIGNALS` and
`projectEmergencyToCheckpoint` are gone. The log and the per-iteration
checkpoints hold everything a dump held. `prepareReplayState`,
`PrepareReplayInput` and `PreparedReplayState` are `prepareForkState`,
`PrepareForkInput` and `PreparedForkState`, and `fromCheckpoint: 'emergency'`
is no longer accepted: the selector (`CheckpointSelector`) is a checkpoint id
or `'latest'`. A replay forks a **new session** whose `session_started.forkedFrom`
names the source `{ sessionId, turnId, checkpointId }`.

**Layout.** Everything lives under `NAMZU_HOME` (default `~/.namzu`,
`resolveNamzuHome`): `projects/<slug>/<session-id>.jsonl` plus
`projects/<slug>/<session-id>/` for child logs, spills, checkpoints, budgets,
tasks, feedback, goals and the lease, and `projects/<slug>/{memory,residents,
worktrees}/`. `SessionPaths`, `ensureProject`, `slugForCwd` and `tempRoot`
compute it. `DefaultPathBuilder` and `PathBuilder` are removed. Nothing is
generated under the working directory: the default git worktree directory
moves from `<repoRoot>/.namzu/worktrees` to `projects/<slug>/worktrees/`. A project
id is minted once per working directory into `projects/<slug>/project.json`.
Old run trees, `sessions.sqlite`, checkpoints, ledgers and resident learning
databases are not read.

`defaultStateRoot`, `NAMZU_STATE_DIR` and `projectIdForDirectory` were on
unreleased `main` and never shipped; they are not in this release. Neither is
the per-run message history of that branch (`RunHistory*`: `openRunHistory`,
`loadRunHistory`, `resolveRunHistory`, `compactRunHistory` and the rest, with
their `history/messages.<g>.jsonl` files). Its idea, that each message is
stored once, is the session log's `message` record: a message is appended
once, when it ends, and a resume or a compaction refers to it by its
`messageId` instead of copying it.

**Hooks.** Hook events `run_start`, `run_end` and `run_interrupt` are
`turn_start`, `turn_end` and `turn_interrupt`; a config naming an old event is
refused with a message naming the new one (`RENAMED_PLUGIN_HOOK_EVENTS`).
Shell-hook stdin `run_id` becomes `turn_id` and `parent_run_id` becomes
`parent_session_id` plus `parent_turn_id`; env `NAMZU_RUN_ID` becomes
`NAMZU_TURN_ID`. `session_id` and `NAMZU_SESSION_ID` are always present;
`turn_id` and `NAMZU_TURN_ID` are absent on `session_start` and `session_end`.
`PluginHookContext.runId` is `turnId?`.

**Memory.** Consolidation tags are `session:<id>` and `turn:<id>` (not
`run:<id>`), with `metadata.sessionId` and `metadata.turnId`. The source value
the session promoter stamps is `'session-memory'` (was `'run-memory'`), and
`MarkdownMemoryStore` leaves records with that source out of its index.

**Protocols and wire contracts.**

- `WireRun`, `WireRunStatus`, `toWireRunStatus`, `RunConfig`,
  `RunConfigSchema`, `RunIdSchema`, `CreateRunRequest`, `CreateRunSchema`,
  `CreateStatelessRunRequest`, `CreateStatelessRunSchema`, `RunUsage`,
  `RunStopReason`, `StreamEvent` and `StreamEventType` are `WireTurn`,
  `WireTurnStatus`, `toWireTurnStatus`, `WireTurnConfig`, `TurnConfigSchema`,
  `TurnIdSchema`, `CreateTurnRequest`, `CreateTurnSchema`,
  `CreateEphemeralSessionRequest`, `CreateEphemeralSessionSchema`,
  `WireUsage`, `WireStopReason`, `SessionStreamEvent` and
  `SessionStreamEventType`.
- `WireTurnStatus` gains `awaiting_input`: `awaiting_hitl` and
  `awaiting_hitl_resolution` map to it (they mapped to `running`), and A2A
  maps it to `input-required`.
- SSE event names `run.*` are `turn.*`, with `session_id` and `turn_id`.
  `mapRunToStreamEvent` is `mapSessionEventToStreamEvent`.
- A2A: `contextId` now names a **session**; it used to carry the project id.
  Any string is accepted and mapped to one session. A client that sent its
  project UUID as `contextId` gets one session for it, and its tasks queue
  there one at a time. `Task.id` is the turn id. `runToA2ATask`,
  `mapRunToA2AEvent`, `runStatusToA2AState`, `RUN_STATUS_TO_A2A`,
  `CreateRunFromA2A` and `a2aMessageToCreateRun` are `mapTurnToA2ATask`,
  `mapTurnToA2AEvent`, `turnStatusToA2AState`, `TURN_STATUS_TO_A2A`,
  `CreateTurnFromA2A` and `a2aMessageToCreateTurn`. `TURN_STATUS_TO_A2A` is
  keyed by `WireTurnStatus`, so it has the new `awaiting_input` key.
- ACP: the default session id is a UUIDv7 instead of `acp_<n>`, and a prompt
  while a turn is active is refused with `INVALID_REQUEST`.
- Telemetry: `NAMZU.RUN_ID`, `NAMZU.RUN_STATUS` and `NAMZU.RUN_PARENT_ID` are
  removed; spans carry `NAMZU.TURN_ID` (`namzu.turn.id`), `NAMZU.TURN_STATUS`
  and `NAMZU.SESSION_PARENT_ID`, plus `gen_ai.conversation.id` set to the
  session id. The span `namzu.agent.run <name>` is `namzu.agent.turn <name>`
  and the histogram `namzu.run.duration` is `namzu.turn.duration`.

## New

- The session-log schema: `SessionRecord`, `SessionRecordSchema`,
  `parseSessionRecord`, one `*RecordSchema` per record type,
  `TurnBoundSessionEventType`, `Checkpoint` with `parseCheckpoint`, and
  `recordSha256`, `parseSessionLogLine` and `formatSessionLogLine` for one log
  line.
- `resolveA2AContext` (with `A2AContextResolution`) and
  `resolveExternalSession` (with `ExternalSessionLookup`,
  `ExternalSessionResolution` and `ResolveExternalSessionOptions`): how a host
  server resolves an A2A `contextId`, or any protocol's own session id, to a
  session through the index.
- `PrepareStepContext.turnStartedAt`: when the turn began. A resumed turn
  keeps the time of its `turn_started` record, whichever process wrote it.
- `ChildSessionStorage` gains a `disk` kind (`{ kind: 'disk', paths }`). A
  parent on disk hands its layout to the children it delegates to, so their
  logs nest under it whether or not a layout was named. Code that switched on
  `kind` must handle the new member.
- `resolveNamzuHome` and `NamzuHomeError` (moved from the CLI, same
  behaviour), `SessionPaths`, `ensureProject`, `slugForCwd`,
  `hashedSlugForCwd` and `tempRoot`.
- `fixtureId.turn` and `fixtureId.record` in `@namzu/sdk/testing`.
- `releaseHeldSessionLeases({ timeoutMs? })` (with
  `ReleaseHeldSessionLeasesOptions` and `ReleaseHeldSessionLeasesResult`), for
  a process about to exit: it releases every session lease the process holds,
  leaving a running turn `interrupted` so the next writer can abandon or
  resume it at once instead of waiting out the lease. After the first call
  every claim in the process is refused with `SessionLeasesReleasedError`. A
  host that stops on SIGTERM calls it from its signal handler; the CLI does.
  `SessionLog.release` now waits for the log's append in flight, so a release
  never lands under a half-written record.

## What to do

1. On 43.x, drain or abandon every parked run.
2. Rename imports per the table above; the compiler finds every one.
3. Replace `runStore`/`pathBuilder` with `sessionLog` (or `paths`), and read
   results from `Turn` and the session log instead of `run.json` or
   `messages.json`.
4. Re-implement a custom store against the session-log conformance suite, and
   a custom checkpoint store with the required `prune`.
5. Update hook configs, dashboards and any A2A client that put a project id
   in `contextId`.
