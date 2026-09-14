# Observing background jobs without approving the same work again

2026-09-14. Base commit `61d47e1a`; implementation and evidence accompany this
report. This completes the approval-friction follow-up recorded in the
[resident learning study](../resident/learning-protection.md#actual-terminal-and-controls).

## Observed problem and source comparison

The earlier real TUI experiment required one approval to start a resident
learning command and three additional approvals to read that job's output.
The built-in `job` tool declared every action non-read-only. The query loop
therefore treated output observation like a new shell mutation.

Codex's
[`write_stdin` handler](https://github.com/openai/codex/blob/205f3671e14e8306919501cdef36ca2e5d360f5a/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs)
returns no `PreToolUse` payload for existing execution-session transport. Its
comment distinguishes empty background polls from input sent to a command
whose initial execution already ran that hook. Source retrieved on 2026-09-14,
SHA-256 `1d4b701dc1b133bd99c6bcbce01f28ddc6bbfbc9f35644f25e8bcbf72819947e`.
This is a source comparison, not a claim that Codex and Namzu implement identical
authorization or that this change reproduces Codex's terminal system.

Namzu now classifies prepared `job` inputs in the SDK: `read` and `list` observe
the caller's job registry; `kill` remains mutating and destructive. Static
`shell_execute` permission still describes the whole capability. Unknown
inputs do not acquire observation authority. Hosts can use the same typed
`defineTool({ readOnly: input => ... })` contract for mixed-operation tools.

The change also exposed a configuration defect: the CLI discarded explicit
`ask` entries, allowing a broader rule or read-only exemption to approve the
call. Those entries now compile to SDK custom-pattern review rules. The query
retains explicit review in the request so the default read-only and accept-edits
shortcuts cannot swallow it. Auto mode, intentional prior grants, rejection and
deny precedence retain their existing meaning. The changed defaults and
configuration semantics are declared as major Changesets with migration advice.

## Actual TUI evidence

The [sanitized artifact](results/2026-09-14-job-review-tui.json) records the built
CLI in a 120×34 Linux pseudo-terminal, inspected with `@xterm/headless`. It used
an isolated application home and working directory, Zen's
`muse-spark-1.3-contributor-free`, and `/effort low`. The fixture prints a ready
line, emits a tick each second, and otherwise expires after five minutes.

The natural-language request asked Namzu to start `node ticker.mjs` in the
background, read its output/status, stop the same job, and report the result.
Only the displayed start and stop requests were approved, once each. No
allow-all selection or read exemption was added to the fixture configuration.

| Run | Start approvals | Read approvals | Stop approvals | Completion | Recorded tokens |
| --- | --- | --- | --- | --- | --- |
| Initial | 1 | 0 | 1 | Fixture timeout after delayed manual approval | 33,380 |
| Repeat in the same conversation | 1 | 0 | 1 | `end_turn` | 49,330 |

Both runs successfully executed exactly `bash(start) → job(read) → job(kill)`.
The repeat received `NAMZU_JOB_READY`, observed a running job, received the
stopped notification and reported completion. The first run is retained as an
incomplete conversational outcome: the approval wait exceeded the fixture's
180-second limit. It must not be counted as a successful final response.
The repeat took 61.682 seconds including manual approval delays; this is not a
latency benchmark or an independent paired trial.

The CLI exited normally with code 0, and no process remained in the fixture
working directory. Total recorded usage was 82,710 tokens. All were unpriced;
numeric zero cost fields do not establish billing cost or a free service.

Fixture-only limits were 12 iterations, 200,000 tokens and 180 seconds per turn.
Default application limits were not changed. Web search and sandboxing were
disabled in this isolated process test. The recorded low-level SDK
`permissionMode: auto` is separate from the interactive review policy, which
was `prompt` and produced the two observed approval requests.

## Verification and reproduction

Targeted deterministic tests exercise real query/registry execution for list
without review, explicit ask in prompt/accept-edits modes, deny, rejected stop,
and plan-mode read/list without stop authority. CLI compiler tests cover
specific ask rules ahead of wildcard allows. Existing process tests cover job
ownership, incremental output, child processes and cleanup at run end.

The workspace suite passed 11,458 tests, including 6,908 SDK tests and 3,129 CLI
tests. The two targeted process suites passed another 14 tests. Typecheck,
workspace lint, build, documentation conformance/fences and exported signature
checks passed. Lint reported existing warnings outside this change. This does
not assert that every release/publish gate ran.

To reproduce interactively, build the workspace, use a disposable working
directory and `NAMZU_HOME`, add the fixture source retained in the artifact,
select Muse and `/effort low`, then send the retained prompt. Approve the exact
background command once. The output should appear without another approval;
stopping the same job must still ask. Quit the CLI after the final response.
For deterministic controls, run:

```sh
pnpm --filter @namzu/sdk test -- src/runtime/query/__tests__/job-review.test.ts
pnpm --filter @namzu/cli exec vitest run src/permissions/__tests__/rules.test.ts
pnpm --filter @namzu/sdk test:proc -- src/tools/builtins/__tests__/a-background-job-belongs-to-its-run.proc-test.ts src/runtime/query/__tests__/a-job-does-not-outlive-its-run.proc-test.ts
```

This closes a measured interaction defect. It does not establish improved
reasoning, learning transfer, or recursive self-improvement. The live test
exercised `read`; `list`, explicit ask, deny and plan-mode controls are backed
by deterministic tests rather than separate live model trials.
