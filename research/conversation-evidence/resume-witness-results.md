# Resume witness: cross-process proof, no live model

Goal: an end-to-end proof that the WS4 resume seed (`feat(sdk): reconstruct
file witnesses at resume from persisted history`) reconstructs file
witnesses through the **real CLI**, across **two separate OS processes**,
using **no live model**. Terra/Codex is rate-limited today and this question
needs no model judgment — only the kernel's plumbing: does a brand-new
process, with an empty in-memory `FileReadTracker`, still produce the
"Visible file evidence" step-context block naming the original write call,
purely by replaying persisted conversation history?

Commit under test: `fbf0723f93945d96cca41f18fc84cf3905c1b306`
(branch `integration/phase-a`). `packages/*/dist` was not rebuilt — every
hash in `buildBefore`/`buildAfter` in the results JSON is identical.

## Method

### Entry point, verified against the code before relying on it

The task background named `namzu run-stream --session <key>` as the only
non-interactive entry point that both **loads** and **persists** a
conversation, with `run` ephemeral and `run --resume` read-only. Confirmed
directly:

- `packages/cli/src/commands/run.ts:8-10` — doc comment: *"Non-interactive,
  so there's no approval prompt — tools auto-run... One-shots use an
  ephemeral session and are not added to `/resume` history."* Reading
  `run.ts`'s handler end-to-end confirms it: it calls `resolveResume` to
  *read* a store when `--resume`/`--continue` is given, but no code path
  calls `appendMessages`/`replaceConversation` afterward — a `run` turn is
  never written back.
- `packages/cli/src/commands/run-stream.ts:253-256` — loads history:
  ```
  cli = await openSessions(cwd)
  if (sessionKey) {
    conversationId = await resolveConversation(cli, sessionKey)
    prior = await loadConversation(cli, conversationId)
  }
  ```
- `packages/cli/src/commands/run-stream.ts:465-482` — persists the turn via
  `replaceConversation`/`appendMessages` after the stream settles (best-effort,
  reported in-band on failure).
- `packages/cli/src/commands/run-stream.ts:302,341` — imports and calls
  `createAgentSession` from `../tui/agent.js`, the **same** factory `run.ts`
  and the TUI use (not a separate headless code path).
- `packages/cli/src/commands/run-stream.ts:422` — calls `session.send(messages, …)`,
  the same `send` closure produced by `createAgentSession`.

So the background's claim holds exactly: `run-stream --session <key>` is the
one entry point that both loads and persists, and it goes through the
identical `createAgentSession`/`send` machinery as the TUI and `run`. No
finding of divergence here — the harness uses `run-stream --session <key>`
for **both** processes.

### The seeding/projection mechanism, read before scripting against it

- `packages/cli/src/tui/agent.ts:1430` — `observationsFor(id, prior)`: a
  `Map<SessionId, Promise<FileReadTracker>>` **local to this process's**
  `createAgentSession` call, keyed on first use of a session id. A brand-new
  CLI process always starts this map empty.
- `packages/cli/src/tui/agent.ts:1441` — logs `'file observation ledger
  rebuilt'` (debug) with `namzu.files.witnessed/seen/replayed_units` once
  seeding finishes.
- `packages/cli/src/tui/agent.ts:3072` — `fileReadTracker: await
  observationsFor(turnScope.sessionId, messages)` passed into `runTurn`,
  i.e. seeding is awaited before the first provider request of the run.
- `packages/sdk/src/runtime/query/file-evidence-seed.ts:80` —
  `seedObservationLedger(messages, tracker, context)`: canonicalizes every
  path a `write`/`edit`/`read` call named (via `resolveWithinAnyReal`, the
  same resolver the tools use) and replays the history into the tracker.
  Reads no file content — only reconstructs from the transcript already in
  hand.
- `packages/sdk/src/runtime/query/file-evidence-context.ts:42` —
  `describeVisibleFileEvidence`: for each visible `write`/`edit`/`read` call,
  checks the *tracker's* `writeCallId`/`fingerprint` against the *visible
  call's own body* (not the disk) and, on a match, emits the
  `Visible file evidence` block naming the write call id
  (`{"path":...,"bodyInCall":"w1",...}`).
- `packages/sdk/src/runtime/query/executor.ts:579,598` —
  `seedFileObservations`/`describeFileEvidence`, the executor-level wiring
  the CLI's `observationsFor` and iteration loop call into.
- `packages/sdk/src/runtime/query/iteration/index.ts:2095-2110` —
  `stepContextMessage`/`appendWorkContext`: wraps the evidence string as
  `Current step context (runtime-generated; not a new user request):\n…`
  and pushes it with `source: {type:'runtime-context', kind:'step-context'}`,
  once per non-empty contribution, every iteration.
- Drift withdrawal: `packages/sdk/src/tools/builtins/edit.ts:277`
  (`recordDrift`) and `:387,409` (fingerprint comparison against the
  **live** disk read at mutation time) →
  `packages/sdk/src/tools/builtins/content-fingerprint.ts:28`
  (`staleFileError`, the exact `"…changed on disk after you read it…"` text)
  → `packages/sdk/src/runtime/query/file-evidence-replay.ts:396`
  (`knownStale`), which `describeVisibleFileEvidence` checks before ever
  admitting a write/edit entry.

Everything the background asserted checked out; no course change was needed.

### Harness

`research/conversation-evidence/resume-witness-cli.mjs`, modeled on
`continuation-cli.mjs`/`active-cli.mjs`/`reference-context-cli.mjs`: mkdtemp
`NAMZU_HOME` + workspace, `preferences.json`/`config.yaml` written the same
way those scripts do, a `--import` preload, `execFile` of
`packages/cli/dist/bin.js`. Dist is sha256'd before and after (15 files
spanning the CLI's agent/run-stream/session-store layer and the SDK's
provider/executor/file-evidence/edit/write layer) — `buildStable: true` in
both saved runs, so nothing rebuilt mid-measurement.

The preload supports two modes:

- **`scripted`** (default, and the only one this task runs): fully replaces
  `ProviderRegistry.create` with an object wrapping the SDK's own
  `MockLLMProvider` (`packages/sdk/src/provider/mock.ts`, the same one
  `reference-context-cli.mjs`/`continuation-cli.mjs` use — it emits the real
  per-tool `index`/id/name/argument-fragment/`toolCallEnd` frame sequence a
  real driver produces, so the consumer path is exercised for real). Every
  `chatStream` call logs a record (message roles, tool names offered,
  runtime-context step-context contents, whether any prior `read` call/result
  for `notes.md` exists) to `requests-p{1,2}.jsonl` before delegating to the
  mock.
- **`live`**: wraps the *real* `ProviderRegistry.create` (returned untouched)
  and only observes/logs — written for a later, deliberate run with
  `--provider codex --model gpt-5.6-terra --effort low`, gated behind
  `mode==='live'` in `preloadSource()`. **Not invoked by this task's run** —
  see `liveMode` in the results JSON (`executed: false`).

One correction made while building this: `compaction.recallEvidence` /
`resolveEvidenceQueries` (a *different* feature — bounded conversation-search
recall) default to on and inject an extra "resolve a conversation-history
search query" planner request **ahead of** the real turn request, which would
otherwise consume the first entry off the scripted turn queue and make
`requests-p2.jsonl[0]` a planner call instead of the real turn. Both are set
`false` in `config.yaml`, exactly as `reference-context-cli.mjs` already
does for the same reason — this is a harness-fidelity fix, not a kernel
finding.

### Scenario (scripted, run twice — normal and drift, each in its own
temp workspace + `NAMZU_HOME`)

**Process 1** — `run-stream --session <key> "create notes.md"`. Turn 1:
scripted `write` tool call, id `w1`, path `notes.md`, a 40-line body with a
sentinel line (`Sentinel line: SENTINEL-<uuid> marks this exact revision.`
on line 20). Turn 2: short text, `stopReason: end_turn`.

**Snapshot between processes** — the store is read directly (`openSessions(cwd,
{stateRoot: home})` + `findMappedConversation` + `loadConversation`, the same
pattern `natural-cli.mjs`/`compact-natural.mjs` already use to read back after
a CLI child process exits), confirming the turn was persisted before process 2
starts.

**Process 2 (normal)** — a **new** `execFile` of the CLI (new process, new
empty `fileObservations` map), same `NAMZU_HOME`, same workspace, same
`--session <key>`, prompt `"what does notes.md say?"`. Scripted first turn:
text only, no tools.

**Process 2 (drift variant)** — same two-process shape in a **fresh**
workspace, but `notes.md` is overwritten on disk between the processes
(line 1 changed; the sentinel line is left alone). Process 2's scripted first
turn issues an `edit` (id `e1`) with `old_string` = the original sentinel
line.

**Control** — searched `packages/sdk/src` and `packages/cli/src` for an env
var or config key that disables `seedFileObservations`/`observationsFor`/the
file-evidence projection: none exists. Per task instructions, the control is
**skipped** rather than adding a product switch to support it
(`control` in the results JSON records this).

## Results — pass/fail per assertion

All 23 checks passed (`resume-witness-results.json`, `flows.normal.checks` /
`flows.drift.checks`, `passed: true` throughout). Full raw detail — every
request's messages/roles/tools, the debug log lines, the persisted-history
snapshot, dist hashes, and per-process timings (each process ran in
0.6–0.75s) — is in the JSON. Summary:

### Normal flow

| # | Assertion | Result |
|---|---|---|
| 1 | Process 1 finished `end_turn`, no errors | PASS |
| 2 | `notes.md` written with the exact 40-line sentinel body | PASS |
| 3 | Turn persisted — `findMappedConversation` resolves a conversation id for the session key | PASS |
| 4 | Persisted history contains the `write` call, id `w1`, `path: notes.md` | PASS |
| 5 | **Process 2's first provider request contains exactly one runtime-context `step-context` message whose content includes `"Visible file evidence"`** | PASS (count: 1) |
| 6 | **That entry names `notes.md` and `"bodyInCall":"w1"`** | PASS |
| 7 | **Seed fired** — process 2's stderr (NDJSON, `NAMZU_LOG_LEVEL=debug`) contains `body: "file observation ledger rebuilt"` with `namzu.files.witnessed: 1` | PASS |
| 8 | **No `read` tool call or tool result for `notes.md` anywhere in process 2's history before that request** | PASS |
| 9 | Process 2 finished `end_turn`; workspace file unchanged | PASS |

Process 2's first request (`requests-p2.jsonl[0]`, 8 messages: 2 system, 1
user, 1 assistant/`write w1`, 1 tool result, 1 assistant/text, 2 user) carries
exactly one step-context evidence entry:

```
Current step context (runtime-generated; not a new user request):
Visible file evidence (this request only): each entry's current body is the
complete body in the named successful write call, ...
[{"path":"notes.md","bodyInCall":"w1","observedFingerprint":"7428926934e793c3"}]
```

— produced entirely from replaying the persisted transcript in a process
that never itself called `write`. That fingerprint is over the *body in the
persisted write call's arguments*, not a fresh disk read; nothing in this
flow required the file to still be on disk in any particular state (though
it happens to be, since nothing touched it).

### Drift flow

| # | Assertion | Result |
|---|---|---|
| 1 | Process 1 finished `end_turn`; `notes.md` written | PASS |
| 2 | Disk drifted between processes (content differs from what process 1 wrote; sentinel line untouched) | PASS |
| 3 | **Process 2's first request STILL shows the evidence entry** (`bodyInCall":"w1"`) — the seed predates the drift observation, since seeding only replays history, never touches disk | PASS |
| 4 | Seed fired (ledger-rebuilt log line present) | PASS |
| 5 | **The scripted `edit` call `e1` executes and is refused** (`isError: true`) | PASS |
| 6 | **Refusal names the drift**: `"...notes.md changed on disk after you read it, so this edit was based on a stale copy and was not applied..."` | PASS |
| 7 | **Process 2's SECOND provider request carries NO Visible-file-evidence entry at all** (`stepContextKinds: []`) — the drift flag withdrew it | PASS |
| 8 | The on-disk modification survived **untouched** — `process2.diskAfter === driftedBody` | PASS |

This is the sharpest evidence in the run: within *one* process, the *same*
in-memory tracker that had just reconstructed the write witness from history
(request 0) sees a live disk read disagree with that witness at the edit's
own mutation-admission check, refuses the mutation, marks the path
`driftObserved`, and the *very next* request (request 1, after the tool
result and a text-only follow-up turn) drops the evidence block for
`notes.md` entirely rather than repeating a claim it can no longer vouch for.

## What this proves

- The **seed fires across process boundaries**: a second, independently
  launched `namzu run-stream` process, with no memory of the first, produces
  the identical "Visible file evidence" block citing the original write call
  id — sourced only from `loadConversation`'s persisted history, never from
  disk, never from the same process's memory.
- `run-stream --session <key>` really is the loop-closing entry point named
  in the background: it is the one command that both persists (process 1)
  and, on a later invocation, loads-and-seeds (process 2) through the exact
  `createAgentSession`/`send` path the TUI uses.
- The drift guard and the evidence projection are wired together correctly:
  a real disk change is caught by the *tool's* own fingerprint check at
  mutation time (not by the seed, which never reads disk), and that
  observation is fed back into the same tracker the projection consults, so
  the very next request stops citing a body that may no longer be true.
- All of this ran with a scripted provider (`MockLLMProvider`, verified
  emitting real frame-sequence streaming events) exercising the production
  `ProviderRegistry`/agent-loop/tool-execution code path exactly as a real
  driver would drive it — nothing about the plumbing under test was
  mocked, only the model's answers were.

## What this does NOT prove

- **Nothing about a real model's behavior.** A live Codex/Terra turn might
  choose to re-`read` `notes.md` anyway despite the evidence being present
  (wasteful but not incorrect), might phrase its answer differently, or
  might behave differently under real latency/streaming/rate-limit
  conditions. This harness answers "does the kernel hand the model the
  right evidence and withdraw it correctly", not "does the model use it
  well" — the `live` preload mode exists in the harness for exactly that
  follow-up, deliberately not run here.
- **Not a proof that the CONTROL (seed disabled) changes model output** —
  there is no such switch to test against, so the counterfactual "would this
  matter for a real answer" is asserted only from reading the code
  (`describeVisibleFileEvidence` returns `undefined` and the projection
  contributes nothing when `tracker.writeCallId`/`fingerprint` are unset,
  which is exactly the case an un-seeded resume would produce) — not
  empirically demonstrated by running such a build.
- Only the `write`→(reconstruct)→`edit`-drift path was exercised; the
  `read`-witness entry kind (`kind:"read"` in the evidence array) and the
  edit-chain-replay path (`editsInCalls`) are not exercised by this harness.

## Anomalies encountered

- First run: `requests-p2.jsonl[0]` was an unrelated 2-message
  "conversation-evidence-recall" planner request (`compaction.recallEvidence`
  defaults on), which also stole turn 0 off the scripted MockLLMProvider
  queue for the drift flow, producing a spurious `edit call e1` "not
  executed" failure. Fixed by disabling `compaction.recallEvidence` /
  `resolveEvidenceQueries` in `config.yaml` (see Method above) — a harness
  bug, not a kernel finding.
- An initial version of the "no prior read result for notes.md" check used a
  loose substring match (`content.includes('notes.md')`) against every tool
  message, which false-positived on the **write** tool's own result text
  (`"Created .../notes.md (+40 -0) · 2614 bytes"`). Fixed to correlate by
  `toolCallId` against an actual `read` call. Also a harness bug.
- No anomalies in the kernel itself: every dist hash was stable across both
  saved runs, both flows passed on every recorded attempt after the two
  fixes above, and `namzu.files.witnessed` was `1` (not `0`) on every
  process-2 seed in both flows.

## Files

- `research/conversation-evidence/resume-witness-cli.mjs` — the harness.
- `research/conversation-evidence/resume-witness-results.json` — raw output
  of the saved run (dist hashes, both flows' process events/stderr logs,
  every provider request's shape, the persisted-history snapshot, timings).
- `research/conversation-evidence/resume-witness-results.md` — this file.
