# An interrupted effect is not an unstarted tool

Measured on 2026-09-13. This extends recorded-output recovery to a different
failure boundary: a tool changed external state, but its completion was never
recorded. There is no original output to retrieve in this case.

The earlier implementation recovered only `tool_completed` records. When a
checkpoint batch had one completed sibling, every missing sibling could run
again, including an action that had already taken effect. A local SDK process
probe reproduced a counter increasing from **1 to 2** after SIGKILL and resume.
The baseline artifacts are `/tmp/namzu-unsettled-proof-2tgzaW`; the fixed SDK
probe is `/tmp/namzu-unsettled-proof-3h8LAk` (**1 to 1**). These preliminary
probes did not capture module fingerprints and are not controlled performance
benchmarks. The committed process regression reproduces the interruption with
single, partially completed, and partially checkpointed batches.

The relevant primary-source precedent is Pydantic AI Harness's
[step-persistence capability at c897c4e](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/step_persistence/_capability.py):
it records tool-effect boundaries and exposes unresolved starts after a crash
so an orchestrator can decide whether replay is safe. Namzu already recorded
starts; the missing part was consulting them before resuming execution. This
change uses that existing evidence without introducing a second effect journal.

## Actual CLI measurement

Reproducer: `node research/conversation-evidence/unknown-effect-cli.mjs`, then
the same command with `--live`. Build the workspace first. Do not build or
change production modules while the probe is running.

Both runs create an isolated Namzu home and workspace. A scripted provider
drives a real CLI `AgentSession` to read `record-once.cjs` and execute it with
the builtin shell tool. The script increments `counter.txt`. A test adapter
holds the tool after its real subprocess exits, before returning its result.
The parent waits for that boundary, sends SIGKILL and waits for process exit.
It verifies a persisted start, no completion, and counter value 1.

A fresh process invokes the actual CLI binary's `drain` command under the
owning Session/Project/tenant. Recovery uses the production registry,
checkpoint store, run log and claim path. The scripted control substitutes
only the provider; the live run uses Codex `gpt-5.6-luna` with effort explicitly
set to `low` by a request adapter. Limits are 6 iterations, 35,000 aggregate
tokens and a 150-second process timeout. Relevant production module hashes
are identical before and after each measurement.

| Observation | Scripted control | Live Luna / low |
|---|---:|---:|
| Counter before / after recovery | 1 / 1 | 1 / 1 |
| Shell starts over original + resumed run | 1 | 1 |
| Resumed run settled | yes | yes |
| Model checked current counter with a read | no | yes |

The live model received an explicit unknown result, read `counter.txt`, and
reported its current value without another shell invocation. Recorded usage
was **21,331 tokens**, including **6,656 cached input tokens**. The ledger had
**13,669 tokens remaining**, no unresolved requests and no outstanding
reservations. No dollar-cost estimate is inferred. Machine-readable hashes,
usage and local artifact locations are in
[unknown-effect-results.json](unknown-effect-results.json).

The first CLI attempt also exposed an independent host omission: `drain`
dropped configured limits and tried to resume a 35,000-token ledger with an
unlimited root, which the ledger correctly refused. Passing the configured
limits into the existing host fixes the mismatch without resetting spent usage.

## Scope and limits

- This is a real headless CLI checkpoint recovery test; it does not test TUI
  rendering or ordinary conversation-history `run --resume` selection.
- Unknown outcomes prevent automatic execution of the original checkpointed
  call. A model can still propose a new call, subject to ordinary permissions;
  this is not an exactly-once guarantee for external systems or power failures.
- A tool's explicitly answered durable question retains its existing re-entry
  contract. Its author must make work before the pause safe to repeat.
- Partial/unreadable/contradictory logs do not establish that absent calls are
  unstarted. Bounded disk scans fail conservatively and preserve source bytes.
- Three SDK process regressions cover SIGKILL before completion, completed
  siblings, unstarted siblings and results already present in the checkpoint.
  Store/recovery tests cover malformed scope/sequence/text, incomplete tails,
  bounds, cancellation, custom-store fallback and bound question answers.
- Validation passed: workspace unit tests (6,488 SDK tests; 2,902 CLI tests
  with 5 declared skips), all 264 SDK process tests, workspace typecheck/lint/
  build, docs conformance and 47 compiled fences, 52 audit-script tests,
  external-name/log checks, project references, signature exports and workflow
  gate parity. External service integrations retain their declared skips.
  Release-only gates and publication are outside this local milestone; the
  broader kernel goal remains active.
