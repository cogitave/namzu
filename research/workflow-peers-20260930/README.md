# Workflow source comparison — 2026-09-30

## Scope and verified baseline

This review asks which changes improve how Namzu works through a task: observation,
repair, retry, retrieval, interruption, recovery and operator control. It is a source
comparison, not a model-quality ranking or a list of every competing feature.

Namzu was inspected at `57c99b22c5e91fe1552f1f4bf7badc91fd5afff9`, using the
installed and built schedule-ownership checkout. Its SDK is 49.0.0 and CLI 35.0.0.
The checkout was clean before this research. Main's local checkout was older and
was not used as the implementation baseline.

Five upstream repositories were freshly cloned without installing or executing
their dependencies. These are the revisions inspected, not moving branch links:

| Repository | Revision | Source surfaces |
| --- | --- | --- |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | `348b6952531d035a681fcf6c14c861284f46adbc` | Deferred capabilities, loading evidence, workspace process cleanup |
| [Codex](https://github.com/openai/codex) | `d42056091aded7feb1d88ac7e83972108b2aa478` | Turn steering, bounded recaps, MCP status, process ownership |
| [Pi](https://github.com/badlogic/pi-mono) | `ee602414c703be8da722ec56de7f2399e62581ac` | Extension reload, session trees, queued input, request provenance |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `f42f579cf8bac4918ac9599bece71618afadd846` | Progress-aware retry guards, historical search, detached-process recovery |
| [Google AX](https://github.com/google/ax) | `ac2332829f22360ff97b0ba34d94dd0dd782f17e` | Task/workspace separation, suspend/resume, status watches, resource locks |

The three synthetic probes in [probe.mts](probe.mts) run Namzu's built SDK and
the actual CLI task projection. They use a scripted provider and private temporary
fixtures. They make no external model requests, do not run user shell commands,
and do not read or change the operator's real sessions, memories or scheduled jobs.
Raw observations are in [results.jsonl](results.jsonl). No elapsed-time threshold
decides their outcomes. Upstream tests were read where cited, not run.
The measurements ran on Linux with Node 24.19.0. [snapshots.json](snapshots.json)
records source revisions and the source/build file digests used by the probes.

## Findings that should precede new features

### 1. Repair can fail to reopen a refused check

**Verified behavior.** A synthetic `check` failed four times. A separate successful
`repair`, declared as a mutating tool, changed its state so the next check would
succeed. The real query loop refused that next check before invoking its handler.
Executed calls were `check, check, check, check, repair`, rather than including
the final check.

The four failure messages deliberately differed. The refusal nevertheless said
the call failed “with the same result each time.” The tracker records only the
tool name, arguments and failure boolean; it neither compares results nor accounts
for intervening mutations.

Implementation: [RepeatCallTracker](../../packages/sdk/src/runtime/query/repeat-call.ts)
and [batch settlement](../../packages/sdk/src/runtime/query/iteration/phases/tool-review.ts).
This is a correctness gap in the repair/retry loop, not merely missing UI.

**Useful peer pattern.** Hermes's [tool guardrails](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/agent/tool_guardrails.py#L375)
mark successful mutations as progress for previously failing signatures and compare
result hashes for unchanged observations. Its [cycle guard](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/agent/tool_guardrails.py#L438)
also considers alternating batches. Names alone are not an adequate generic SDK
contract; Namzu should derive effects from its admitted call metadata and execution
receipts.

**Proposed root correction.**

- Count identical failures using a bounded fingerprint of the actual failure.
  Do not describe distinct failures as identical.
- Allow a fresh experiment after an operation that can change the checked state.
  Reading an unrelated file is not evidence of repair.
- Preserve hard ceilings on iterations, tokens and tool calls independently.
  A mutation is permission to retry, not proof that the task advanced.
- Keep polling semantics explicit. A successful wait timeout is an observation.
- Add multi-call cycle advice only after this basic refusal rule is correct.

Acceptance: unchanged failure refuses the fifth replay; changing error evidence
does not meet the “identical result” condition; `fail → edit/repair → retry` executes;
a failed edit and unrelated successful reads do not erase an unchanged-failure
streak; parallel batches and checkpoint resume preserve the intended turn boundary.

### 2. Stored task text still acquires system authority

**Verified provider boundary.** A stored task subject marker reached a real SDK
provider request as `role: system`, with no runtime-context source. The CLI's
`createTaskContextStep` appends the task JSON to `prepared.system`. This helper is
mounted on both interactive sends and paused-turn resumes.

Implementation: [task projection](../../packages/cli/src/integrations/sessions/task-context.ts),
and its host mounts in [agent.ts](../../packages/cli/src/tui/agent.ts).
The header says the snapshot is agent-maintained planning data. That disclaimer
does not change the authority of the message role. The probe establishes role
placement, not a demonstrated successful prompt-injection attack.

Namzu already separates curated memory, retrieved observations, plugin text and
hook observations using [request-only context](../../docs/sdk/step-context.md).
Tasks should follow the same boundary. Pi's [custom message contract](https://github.com/badlogic/pi-mono/blob/ee602414c703be8da722ec56de7f2399e62581ac/packages/coding-agent/src/core/session-manager.ts#L146)
also projects extension messages into user-role context rather than system policy.

**Proposed root correction.** Return `PrepareStepResult.context`, preserving any
earlier step context. Keep static host guidance in `system`. The task snapshot
remains scoped, bounded, refreshed and request-only; no additional model call or
new plan store is needed.

Acceptance: task field markers appear only in labelled runtime context on the
actual provider request, never in system instructions; host guidance survives;
ordinary send, resume and post-compaction projection agree; unrelated session and
tenant tasks remain absent; projection does not append synthetic durable reminder
records. Document the changed role and declare major bump intent for the affected
published surface under the repository's release rules.

### 3. A bounded search result is not bounded storage work

**Measured I/O.** `MarkdownMemoryStore.list({ query, limit: 1 })` returned one hit:

| Markdown files | Body reads | Bytes read |
| ---: | ---: | ---: |
| 10 | 10 | 165,157 |
| 100 | 100 | 1,651,507 |
| 500 | 500 | 8,257,507 |

This is a byte/read-count measurement, not a latency benchmark. Every file body
is reloaded under the operation lock before candidate selection. The recently
added search candidate limit is useful but does not bound that prior integrity
scan. `readIndex` also uses the same loader.

Implementation: [Markdown loader and list](../../packages/sdk/src/store/memory/markdown.ts).
Its integrity contract is valuable: invalid, unreadable, duplicated, oversized
or newer-version files are refused visibly. Optimizing by silently skipping those
files would regress correctness.

**Proposed root correction.** Keep editable Markdown as canonical storage and
build a versioned, rebuildable retrieval index. Separate directory/integrity
validation, changed-file ingestion, metadata selection and selected body reads.
Budget rebuild and catch-up work and report incomplete coverage. A cold rebuild
may be proportional to the corpus; repeated unchanged queries should not reread
every body. External edits require explicit freshness tracking. A metadata stat
cache alone cannot prove arbitrary same-size, same-timestamp edits absent.

Hermes's [bounded historical discovery](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/tools/session_search_tool.py#L354)
shows the value of selecting hits before hydration. Its curated memory is a small,
always-loaded [file-backed store](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/tools/memory_tool_store.py);
it is not evidence of a scalable Markdown memory index.

Acceptance: measure cold/warm I/O separately at 500 and 5,000 records; updates,
deletion, rename crash, corrupt file, index loss, concurrent writers and manual
edits remain honest; distinguish partial catch-up from exhaustive results; preserve
conditional revision writes.

## Useful additions after the root corrections

| Priority | Change | Peer evidence and current Namzu boundary | Completion criterion |
| --- | --- | --- | --- |
| P1 | Operator-managed plugin add/remove/reload | Pi shuts down and invalidates the old extension runtime during [reload](https://github.com/badlogic/pi-mono/blob/ee602414c703be8da722ec56de7f2399e62581ac/packages/coding-agent/src/core/agent-session.ts#L3575). Namzu already has live enable/disable, persisted settings, idle gating and cleanup. Changed plugin files still require session restart. | Local-path admission; reviewed manifest/content revision; fresh module generation; stale callbacks cannot act; failed reload has an explicit recoverable state; tools, skills, hooks and MCP contributions agree. Do not assume arbitrary startup side effects can be rolled back. |
| P1 | MCP repair and diagnosis in the TUI | Codex's [status projection](https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/codex-mcp/src/connection_manager/status.rs) observes disabled/dormant/live servers without starting them. Namzu has OAuth, add/remove/test, reconnect and progress, but lacks per-server interactive restart/status/log access. | Opening status starts nothing; errors distinguish auth, startup, discovery and tool failure; logs redact credentials; explicit restart invalidates stale results and does not strand old transports. |
| P1 | Project-scoped historical discovery | Hermes retrieves FTS hits with lineage and source, then hydrates selected evidence. Namzu already has a rebuildable SQLite evidence index and bounded exact reads/search of the active conversation. A public project-wide retrieval surface is the missing composition. | Default to the canonical current project and tenant; return conversation/turn/evidence addresses and observation time; exclude unrelated projects and private children; read exact selected evidence without replaying its action. |
| P1 | Long-task recovery fault suite across platforms | Hermes checkpoints process metadata and validates PID birth identity [before adopting a detached process](https://github.com/NousResearch/hermes-agent/blob/f42f579cf8bac4918ac9599bece71618afadd846/tools/process_registry_checkpoint.py). Pydantic's [local workspace](https://github.com/pydantic/pydantic-ai/blob/348b6952531d035a681fcf6c14c861284f46adbc/pydantic_ai_slim/pydantic_ai/workspaces/local.py) explicitly requires POSIX for process-group timeout guarantees. Namzu's job registry already owns live groups and reports output loss. | Native Windows, POSIX and remote/sandbox probes: cancel at startup, parent exit with grandchildren, held pipes, kill escalation, worker crash, result delivery interruption, saturated output. Establish actual behavior before offering crash-surviving shells. WSL is not native Windows verification. |
| P2 | Deferred capability bundles | Pydantic hides instructions/tools, gates model settings/hooks after loading, and reconstructs activation from [typed load evidence after compaction](https://github.com/pydantic/pydantic-ai/blob/348b6952531d035a681fcf6c14c861284f46adbc/pydantic_ai_slim/pydantic_ai/_deferred_capabilities.py#L142). Namzu already has dynamic per-run capabilities and deferred toolsets, but not the complete bundle activation lifecycle. | Stable IDs, one load receipt, idempotence, compaction/resume/reload behavior, cache-stable catalog and exact schema visibility. Permissions, budget, cancellation and host audit enforcement remain eager. Measure total tokens, discovery round trips and task success, not schema characters alone. |
| P2 | A bounded operator recap | Codex uses a [separate temporary structured request](https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/tui/src/app/recap.rs), with bounded output, revision identity and cancellation. Namzu compaction changes model context; that is a different operator need. | Start with explicit manual recap, show cost/provider choice, leave live transcript and tool availability unchanged, reject stale summaries and include outstanding work and current blockers. |

## Existing strengths to retain

- Toolsets preserve source identity through composition and wrappers. Tool
  discovery, declared approval and permission checks already exist. No replacement
  registry is justified by these comparisons.
- The kernel already provides dynamic capabilities, structured output, cumulative
  budgets, checkpoints, exact artifact retrieval and child-result delivery. A
  dependency on a complete external agent framework would duplicate foundations.
- Hash-chained session logs remain canonical; SQLite is a rebuildable index.
  New retrieval should compose these layers rather than introduce another history.
- CLI Enter steering and Tab follow-ups already distinguish interruption from
  queued next work. Pi also separates [steering from follow-ups](https://github.com/badlogic/pi-mono/blob/ee602414c703be8da722ec56de7f2399e62581ac/packages/agent/src/agent-loop.ts#L175).
  Codex's [expected-turn check](https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/app-server/src/request_processors/turn_processor.rs#L1023)
  is useful if an external client is later added. A cross-process steering endpoint
  would need authenticated ownership, stable message IDs and honest offline/error
  receipts; the present local queue is not missing.
- The new scheduler source ownership and private script-workspace design exists
  on the inspected branch. Its [PR #579](https://github.com/cogitave/namzu/pull/579)
  had green remote checks and remained open on this review date. Existing live
  jobs were not changed. This is implementation evidence, not a published-version claim.

## Patterns to avoid copying wholesale

- Google AX separates task state, workspace bindings and substrate orchestration.
  Its [server](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/internal/server/server.go#L257)
  and [design](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/DESIGN.md)
  are relevant for a future hosted worker service, not a reason to require Redis,
  Kubernetes or tenants for a local agent run. The inspected
  [Redis lock](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/internal/lock/lock.go#L168)
  has a TTL and token-checked release, without renewal in that acquisition
  implementation. Those facts alone do not prove exclusivity for operations that
  outlast the TTL; Namzu should retain its own lease/claim correctness requirements.
- Hermes injects curated memory into a system prompt with pattern filtering.
  Namzu's observation/policy role separation is the stronger foundation here;
  a threat-pattern list does not grant learned text host authority.
- Deferred behavior must not hide mandatory enforcement. Pydantic permits deferred
  hooks, which is useful for optional capabilities but dangerous for budget or
  authorization enforcement without a separate always-active layer.
- Pi's tree sessions are a useful navigation design. Namzu already forks retained
  histories. Rewriting its log storage as a tree before establishing an unmet
  operator requirement would add migration cost without fixing the verified bugs.
- Surviving a CLI crash and surviving a tool call are different process lifecycles.
  Do not adopt arbitrary PIDs, claim old output is available when only status was
  recovered, or reuse scheduler daemon ownership for unrelated interactive shells.

## Tracked work and recommended order

- [x] Verify Namzu worktree/revision and current schedule PR state.
- [x] Clone and pin five source repositories.
- [x] Compare runtime, retrieval, extensions and long-job ownership.
- [x] Reproduce retry-after-repair, task role and Markdown search I/O.
- [x] Save raw observations and reproducible script.
- [ ] Correct progress/failure-aware retry refusal, with query-loop regressions.
- [ ] Move task snapshots to request-only context, with actual provider captures.
- [ ] Design and implement bounded incremental memory retrieval without weakening integrity.
- [ ] Add safe local plugin reload and per-server MCP repair UX.
- [ ] Expose project history retrieval through existing scoped evidence storage.
- [ ] Run native platform/remote long-task fault probes.
- [ ] Evaluate deferred bundles and recap only after the preceding correctness work.

The first implementation slice should contain the retry and task-context
corrections. They are confirmed current behavior and small enough to verify
independently. Indexing and lifecycle UX need their own designs and failure tests.
This research does not claim those corrections or additions have been implemented.

Documentation verification passed: OKF, compiled documentation fences, the
external-name audit, the log-standard gate and local/pinned source-link checks.
There is no production-code change in this research commit.

## Reproduce

From an installed and built Namzu checkout at the inspected revision:

```bash
node --import ./node_modules/tsx/dist/loader.mjs research/workflow-peers-20260930/probe.mts "$PWD"
```

The script accepts an absolute checkout path if run from elsewhere. It leaves a
temporary synthetic fixture path in its final JSON record for inspection. Results
after a future correction may differ intentionally; the archived results above
describe the inspected revision. This is not a release gate or a real-model trial.
