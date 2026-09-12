# Recovering observations after process interruption

Verified 2026-09-13 on Linux/WSL. Reproducer:
[interrupted-cli.mjs](interrupted-cli.mjs). Source fingerprints, commands and
observed outcomes: [interrupted-results.json](interrupted-results.json).

## Confirmed gap

The previous restart tests used terminal runs. A new probe created a real CLI
Session, persisted one large file-read result, and killed its process with
`SIGKILL` after the next provider request began. The parent observed the actual
exit signal. The run metadata stayed `idle`; the original output existed beyond
its transcript preview. A fresh-process call to the CLI conversation search
returned zero matches and `incomplete: true`. The old code selected the legacy
preview scanner solely because the run had no terminal status.

That initial failure probe was run before implementation in the checkout at
`738d0127`. It did not fingerprint built modules and used the conversation API
for recovery, so it is failure evidence, not a controlled before/after CLI
performance benchmark. The committed reproducer uses the production command
for recovery and checks module fingerprints before and after every run.

## Source comparison and implementation

The pinned [Pydantic AI Harness step-persistence implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/step_persistence/_capability.py)
records tool effects separately from run completion. Its settled tool-node
boundary saves a provider-valid snapshot before a hard kill can bypass error
hooks; interrupted tool work remains distinguishable from a completed cycle.
The relevant distinction here is between a recorded observation and permission
to continue execution. This is a source-informed design comparison, not a
performance comparison or a claim that that project uses Namzu's disk index.

SDK disk evidence now accepts `consistency: 'snapshot'`. It validates the
host-supplied invocation scope and permits known nonterminal statuses while
retaining all source-stamp, record-hash and output-manifest checks. The default
remains `closed`. An incomplete final JSONL fragment can be excluded by a
backward scan bounded to 4 MiB and charged to the operation's I/O allowance.
The transcript is never healed by retrieval. Malformed complete records, an
absent or oversized complete-prefix boundary, changed originals and unknown
statuses are refused.

The CLI selects snapshot mode for explicitly scoped nonterminal runs outside
the requesting live writer. It does not infer liveness from status, change a
run to completed, acquire an execution lease or replay tools. Search of a
nonterminal snapshot remains incomplete even when its current prefix ends.
Exact read completion and full retention describe the selected text only.
Changes between operations invalidate the old address and require a fresh
search; the active writer's existing append-stable capability remains separate.

## Actual CLI execution

The seed uses a scripted provider through the real CLI Session, read tool and
SDK writer. A random receipt lies beyond the preview of a 400-line synthetic
manifest. The stored conversation projection contains no receipt identifier;
this fixture does not claim automatic compaction. The file is externally
replaced before the parent kills the still-running process.

Recovery starts a fresh `run --resume` process. In `--torn` mode, the parent also
injects an incomplete final JSONL fragment **after the confirmed kill**. This
models a partial append separately; it does not claim the kill itself happened
in the middle of a write. The verifier compares the old metadata and transcript
hashes before and after recovery, and requires the random receipt in an exact
read of the original run's `tool_completed` event. A correct answer copied only
from a search excerpt does not pass.

| Trial | Recovery calls | Original exact read | Old metadata/transcript | Tokens |
| --- | --- | --- | --- | ---: |
| Scripted command after kill | search → read | Passed | Unchanged | 0 |
| Scripted command after kill + partial tail | search → read | Passed | Unchanged | 0 |
| Luna/low after kill + partial tail | search → read | Passed | Unchanged | 22,087 |

All new trials passed fingerprint stability. Only the initial observation used
the workspace read tool; the recovery commands used conversation tools, left
the replacement file intact and did not resume the interrupted execution.
The live run used Codex `gpt-5.6-luna`, low effort, at most six iterations, a
35,000-token admission budget and a 150-second process timeout. Admission is not
a hard billing ceiling. Its 22,087 reported tokens were unpriced by the local
catalogue; the ledger's zero priced cost does not imply free usage.

```sh
node research/conversation-evidence/interrupted-cli.mjs
node research/conversation-evidence/interrupted-cli.mjs --torn
node research/conversation-evidence/interrupted-cli.mjs --torn --live
```

## Validation and remaining boundaries

Workspace typecheck, lint, build and tests passed: 6,455 SDK tests and 2,900 CLI
tests, with five existing CLI skips. The SDK process suite passed 261 tests,
including independent-process snapshot search/read for both complete and
partial tails with retained compaction text. The new SDK cases cover all three
nonterminal statuses, unchanged source files, default closed-mode refusal,
consistency-mode separation, ownership changes, altered output, cancellation,
unknown statuses and bounded tail refusal. CLI cases exercise location caching,
scope, unchanged nonterminal source state and status-change invalidation.

After the final tool-description update, the affected CLI tests and CLI lint
passed again. Docs conformance/fences, project references, exported signature
types, log and external-name gates/tests passed. Lint retains 37 SDK and 14 CLI
warnings. Release-only coverage, eval, packaging and registry checks were not
run; no push or publication is claimed.

The hard-kill experiment was not run on Windows. This is retrieval from a
trusted private state directory, not protection against hostile concurrent
ancestor-directory replacement. Large partial tails can exhaust the bounded
scan allowance; changing live sources can require retrying the search. These
tests establish recovery of completed recorded observations, not the outcome
of an interrupted unrecorded action or automatic recovery of every unfinished
task. The broader autonomous-kernel goal remains active.
