# Evidence capture cancellation

The tool executor replaced `abortSignal` with its deadline-bound signal but
passed `captureRunEvidence` through unchanged. That closure observed the run's
lifetime. A timed-out tool could therefore receive a late snapshot or reuse its
capture function while a later tool was running.

A regression test reproduced this before the fix: a store released after the
tool's deadline still returned successfully (`lateReturn` was `true`, expected
`false`). The same test now rejects the late capture and the retained old closure,
while a following tool reads successfully. Separate tests cover nested-only and
per-read cancellation, queued reads, late backend failures, writer ordering and
abort-listener disposal.

The fix composes tool, nested and optional read cancellation; forwards the signal
into the store; and races the caller's wait without releasing the actual storage
operation's lock. CLI retrieval forwards its own signal when asking for a live
snapshot. No global cancellation is used to stop a single read.

## Actual CLI process

`node research/conversation-evidence/capture-cancellation-cli.mjs` starts the
built CLI binary with `run-stream --session` in isolated home/workspace
directories. Only model choices and injected storage delays are scripted; the
CLI composition, conversation tools, tool deadlines, disk transcripts and
retrieval are production code. No external provider request or credit is used.
This is a process-level CLI check, not a visual TUI or live-model evaluation.

The CLI reads a synthetic receipt once. Its first conversation search gets a
100 ms deadline against a 350 ms storage delay. The second search must recover
the original authenticated `read` observation, and the run must finish normally.
Assertions identify each tool result by its call ID and inspect the actual
search match, rather than accepting the scripted final answer as evidence.

| Storage adapter | First search | Following search | Original file reads |
|---|---|---|---:|
| Observes cancellation | Store receives abort; tool reports timeout | Recovers original receipt | 1 |
| Ignores cancellation until settlement | Caller leaves before storage settles; writes retain their order | Recovers original receipt | 1 |

The [machine-readable results](capture-cancellation-results.json) record the
events, verified run/record addresses and production module hashes. Saved
results can be rechecked without another run using the script's
`--verify <report-path>` option while its artifact directories remain available.

Cancellation cannot forcibly stop arbitrary custom storage. An uncooperative
operation still blocks later writes until it settles; letting those writes
bypass its lock would break transcript consistency. The built-in disk capture
checks cancellation before entering storage and after its bounded metadata read.
The returned source's `search` and `read` calls still need their operation signal.

## Local validation

Workspace unit tests passed; the final affected-package counts are 6,499 SDK
tests and 2,909 CLI tests (5 declared CLI skips). All 264 SDK process tests passed.
Typecheck, lint, build, documentation conformance/fences, project references,
workflow gate parity, exported signature types, SDK test presence, external-name
audit and logging gates passed. Lint retains existing warnings.
The two CLI scenarios were repeated against the final built modules after the
CLI signal-forwarding change. No publication or release-only validation is
claimed; this is a local cancellation milestone within the still-active goal.
