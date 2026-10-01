# Watcher architecture comparison and implementation boundary

Date: 2026-10-01. Status: source research complete. The source comparison below
describes the baseline; its selected process-output slice has subsequently
been implemented locally and exercised in the native terminal.

## Implementation follow-through

The current implementation adds `BackgroundJobRegistry.waitForOutput` and
`wait_for_job`'s optional `output_contains`/`output_stream` mode. Default exit
waits remain unchanged. Matching preserves pipe identity, byte cursors and
split literals, reports retention gaps, bounds subscriptions and cancels
observation without killing the process. Readiness does not mark exit-wait
intent. Three focused suites have 24 deterministic passing regressions.

The real CLI/server experiment verified a live wait, split marker, a subsequent
HTTP check while the server remained alive, `/jobs` visibility after the turn,
and process cleanup on host exit. It also exposed a query stream defect that
buffered tool starts until execution finished; live event delivery and early
consumer cancellation now have actual-query regressions. Reproduction and
limits are recorded in [native implementation](NATIVE-IMPLEMENTATION.md).
Final full-workspace verification remains in the implementation tracker; this
report does not claim a release or a recurring automatic watcher.

## Verified sources and limits

- Namzu worktree: `namzu-wt-schedule-ownership`, branch `feat/runtime-desktop-foundation`, committed baseline `7f5f12845b8927d371f6137fe8ede99d4ce14f65`. Other agents are implementing child conversation changes in this worktree. The existing watcher-related files examined below are not part of those edits.
- Reference repository: `https://github.com/NousResearch/hermes-agent`, local clone `/var/tmp/n-R2j6E1/mission-reference/hermes-agent`, clean at `12e4d3e2dd5281adf289f70e5d6c7f33427d6982`, commit time `2026-09-30T22:42:13Z`. This is a pinned source comparison, not a claim to have checked the latest remote HEAD. A remote `git ls-remote` produced no answer and was stopped; no reference checkout was changed.
- The watermark helper was exercised directly with only the standard Python library and a private temporary state directory. No user's job, conversation, credentials, network endpoint or reference source file was changed. Results are recorded below.
- Gateway and terminal behavior is a source inspection, not a live integration run of the reference application. The distinction matters for both feature claims and defect claims.

All reference links below are pinned to that revision. Repository names belong in this research attribution, not new runtime classes, user-facing labels or prompts.

## What “watcher” means in the source

It does not identify one reusable agent class. The repository uses the word for independent mechanisms:

| Mechanism | Actual source behavior | Correct architectural owner |
|---|---|---|
| External-source polling skill | RSS/Atom, JSON endpoints and GitHub scripts compare item IDs with a local watermark; first poll records a baseline and prints nothing | Optional capability/skill plus scheduler execution and result delivery |
| Cron monitor | Run a script or bounded HTTP GET before model construction; hash exact source bytes; unchanged output suppresses inference; changed output supplies a bounded diff and snapshot | Scheduler source gate and run state |
| Background process watch | Literal output patterns or process exit produce routed events; per-process throttles and a global breaker prevent notification storms | Process registry and host session event admission |
| Session stall watchdog | Pending inbound plus stale progress can notify; immediately recheck before delivery; it explicitly does not kill the turn | Host operational supervision |
| Housekeeping/catalog watcher | Cache pressure, retention and catalog refresh loops | Application service lifecycle |

Evidence:

- [Optional watcher skill, its baseline and watermark contract](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/optional-skills/devops/watchers/SKILL.md#L21).
- [Cron monitor source and hash gate](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/cron/monitor.py#L126), [pre-model gate and separate runtime-data input](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/cron/scheduler.py#L1540).
- [Process pattern routing and suppression](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/tools/process_registry.py#L747), [global breaker constants](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/tools/process_registry.py#L72).
- [Stall check immediately before notification](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/gateway/run_watchers.py#L164), [notify-only supervision contract](https://github.com/NousResearch/hermes-agent/blob/12e4d3e2dd5281adf289f70e5d6c7f33427d6982/gateway/run_watchers.py#L232).

## What Namzu already provides

The user correctly remembered related functionality. Adding a new “WatcherAgent” would duplicate the existing separation of source observation, inference, durable state and delivery.

### Scheduled external-source checks

- `packages/cli/src/schedule/fire/wake-gate.ts`: strict bounded `{"wake": boolean, "context": string}` parsing, ambiguous JSON refusal and sanitized error evidence.
- `packages/cli/src/schedule/fire/fire.ts:424`: a `script+agent` gate runs before provider/session construction. `wake: false` completes with zero model calls. Gate context is untrusted runtime evidence, not operator authority.
- `packages/cli/src/schedule/fire/script-report.ts`: pure-script opt-in `json-v1` quiet/changed reports with bounded summary/state.
- `packages/cli/src/schedule/store/script-state.ts`: scheduler-owned state with separate revision, idempotent run application and refusal of stale state proposals.
- `packages/cli/src/schedule/daemon/daemon.ts:1185`: a source result and proposed next state enter pending settlement. Source-conversation delivery must be handled before the state advances; later occurrences wait rather than overtake pending results.
- `docs/cli/scheduled-tasks.md:103`: quiet polls suppress successful-run noise; noteworthy findings are durable host notices in the originating conversation. Busy/deleted sources remain visible delivery problems, not silent success.

For example, “watch this repository for new issues and tell me here” already maps to a scheduled pure script plus a structured changed report. “Analyze only when this source changes” maps to `script+agent`. Native RSS/JSON/GitHub poller templates would improve setup, but they are convenience capabilities, not evidence that the kernel requires another agent hierarchy.

Important distinction: the strong scheduler-owned `nextState` settlement contract currently belongs to pure-script structured reports. The `script+agent` wake gate has only `wake/context`; arbitrary gate scripts can still maintain their own state. Do not claim that every gate already has durable change acknowledgement.

### Long-running commands and foreground waits

- `packages/sdk/src/runtime/jobs/registry.ts`: registry owns the actual process/group, output bounds and lifetime; `bindOwner` makes another owner's IDs unavailable. Sandbox execution retains its boundary.
- The registry exposes `onExit` and `waitForExit`; it does **not** expose process-output condition subscriptions.
- `packages/sdk/src/tools/builtins/wait-for-job.ts`: an explicit bounded, cancellable exit wait consumes one tool call; the timeout never kills the process.
- `packages/sdk/src/runtime/jobs/awaited-jobs.ts`: only an explicitly awaited job keeps a turn open. A persistent server or watcher does not keep unrelated turns waiting.
- `packages/cli/src/tui/agent.ts:3929`: CLI exit events are filtered to the live CLI session's job owner. `/jobs` provides read/stop and status surfaces.
- `docs/cli/background-jobs.md`: jobs survive normal turns and conversation switches inside one live CLI agent session, then stop when that host session closes. Another Namzu process cannot address them. This is not a durable daemon/process adoption promise.

### Resident and communication primitives

- `packages/sdk/src/manager/resident/host.ts` and `docs/sdk/resident-agents.md`: hosts can persist wake evidence, notify an idle driver, enforce step/resource bounds and pause/settle exact claims.
- `docs/sdk/resident-agents.md:211`: wake evidence is an immutable bounded batch; exact successful settlement consumes the captured batch. Failure or ambiguous crash preserves evidence.
- `packages/sdk/src/manager/resident/outbox.ts` and `docs/sdk/resident-communication.md`: outgoing intent, recipient acknowledgement and explicit delivery windows are already separate contracts.

These are suitable lower layers for a future durable watcher target. They do not prove the CLI already has a registered external source adapter or background process pattern watcher.

## Useful reference decisions and boundaries to improve

### Preserve

1. Perform cheap source checks before inference, provider creation and conversation allocation.
2. Treat no-change as a successful quiet observation. Fetch/parse/persistence errors are errors with evidence, never “nothing changed.”
3. Attribute each notification to its process/source and owning session; output is untrusted data.
4. Bound notification count, payload and matching work. A noisy log must not become an unlimited stream of full-context model calls.
5. Separate a stall warning from cancellation or a claim of failure. Queue length alone is not a progress clock.

### Do not copy these source limitations

The optional watermark helper is not an acknowledged delivery ledger:

- `watch_github.py:154` and `watch_http_json.py:111` save all observed IDs **before** limiting or printing the new items. With `--max 1` and three new entries, all three become seen although only one is emitted. The next poll cannot deliver the other two. A save followed by output/delivery failure likewise has no replay.
- `_watermark.py:83` does not add an ID to `existing` during the same batch; duplicate IDs in one new batch are emitted twice. `list(existing)` also discards stable age ordering before bounded eviction.
- The atomic rename uses one shared `<name>.tmp`; it provides atomic file replacement, not multi-process compare-and-swap or per-run acknowledgement.
- `cron/monitor.py:129` deliberately commits the observed hash before inference. That prevents repeated inference on unchanged content after an agent failure, but is a different policy from guaranteed handling of every accepted change. The snapshot/hash are separate writes and persistence failures are logged rather than preventing a `changed` result.
- `tools/process_registry.py:759` matches each incoming chunk's split lines. From this code alone, a literal split across two chunks can be missed. This is a source-derived limitation, not a live-reproduced terminal defect.

Deterministic helper probe (executed against the real pinned helper):

```json
{
  "baseline_emitted": [],
  "same_batch_duplicate_ids": ["new", "new"],
  "after_save_retry_emitted": [],
  "max_one_candidate_ids": ["a", "b", "c"],
  "max_one_printed_ids": ["a"],
  "max_one_next_tick_ids": []
}
```

The cap probe exercises the helper followed by the exact save-then-slice order in the scripts; it does not claim to execute an authenticated GitHub request.

## Selected next implementation slice

**An explicit one-shot output condition for an owned background job.** The immediate use case is “start the server, then continue when it says it is ready,” without polling, without waiting for a process that should never exit, and without allocating another agent.

Place matching and observation in the SDK job registry. Expose a bounded read-only condition wait through the existing job wait surface. Keep owner filtering and sandbox execution unchanged. CLI status can show “waiting for output” and the literal match/timeout/exit result. An initial wait is useful independently of a later automatic session wake adapter.

Required contract:

1. Match a bounded literal; no user-supplied regex execution. A match is only observed output, not proof of HTTP health, authorization, successful tests or completion.
2. Preserve split UTF-8 characters and match across chunks **within each stream**. Do not fabricate a match by joining stdout with stderr. Retain only the required bounded matching suffix.
3. Define where observation begins (explicit offset/registration point). State dropped output rather than treating a truncated tail as complete evidence.
4. Register and check retained output without a read/subscribe race. A literal already available inside the selected retained range can satisfy the wait.
5. Resolve exactly once with distinct outcomes: matched while process remains running, process exited before matching, wall timeout, idle timeout or cancellation. None of these stops the job.
6. Owner checks apply to every lookup and observation. An unknown/foreign job is unavailable; no cross-session routing or child-to-parent process ownership transfer.
7. **Do not mark a readiness wait as an exit wait in `AwaitedJobs`.** Otherwise a successful readiness check would keep later settle points waiting for a server's exit. Existing exit-wait behavior remains unchanged.
8. Bound active subscriptions and dispose them on every result, abort and session close. Tests use deferred I/O/fake timers, not speed races.
9. Keep the old default of `wait_for_job` waiting for exit. An additive optional condition is suitable for a minor version; any default change requires an explicit major claim.
10. Verify in a real Namzu TUI with a private test server: a split readiness marker yields one result, the next command proceeds while the server is still alive, unrelated output does not wake repeatedly, and closing the owned host session stops its process group.

Follow-up automatic watching is a separate bounded subscription adapter: accepted observation ID, origin and target generation, visible queue status, single delivery claim and a host-owned provider-valid model wake. It must not use `send_message` as if process text were an operator message, nor use peer transport as a durable event broker. A recurring match policy needs cooldown/coalescing and per-owner/global admission bounds; implement those deliberately rather than making every log line a model turn.

## Priorities and acceptance

| Priority | Work | Acceptance |
|---|---|---|
| Current | Finish child direct composer, fresh invocation continuation and trusted parent admission journal | Owned child can receive a busy correction or idle continuation; parent sees provenance; terminal tasks remain immutable |
| Next, recommended | Owned background job one-shot literal readiness condition | Conditions 1–10 above, docs/changeset, scoped/process tests and full required gates |
| Subsequent | Optional source templates using existing structured reports | First-run baseline configurable, stable IDs, bounded backlog, no save-before-delivery loss; malformed source output fails honestly |
| Subsequent | Scheduler-owned state/delivery contract for agent wake gates | Accepted source event cannot be consumed before durable inference/delivery admission; explicit retry/detection policy and crash reconciliation |
| Later | Durable source subscriptions targeting saved Pal deployments | Definition/grant revisions, revocation, resource leases, bounded durable inbox/outbox, event idempotency and explicit restart recovery |
| Separate operational work | Host stall warnings | Stale progress plus pending input, fresh recheck, bounded warning and operator visibility; no automatic cancellation based only on quiet output |

## Pal alignment

Watcher is a **source subscription or process observation**, Pal is an **operator-owned reusable identity**, and a task invocation is an **attempt to do work under current grants**. Keep those distinct. A lead role may decide what to do with an observation; observation does not widen its authority or merge private histories. Groups describe membership and roles. A deterministic workflow controller enforces dependencies. A2A remains an external interoperability adapter and is not required to pass an internal watcher event.

The existing Pal architecture document is a selected design, not a shipped deployment registry or a standards conformance certificate. The choices above align with common event-driven engineering contracts (source, subscription, observation, acknowledgement, idempotency, bounded queue, supervision). Exact A2A wire conformance remains a separate known gap and must be verified against a chosen official version before any external Pal endpoint is promised.
