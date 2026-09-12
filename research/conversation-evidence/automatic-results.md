# Automatic historical recall in a real CLI conversation

Measured 2026-09-12 on Linux/WSL. One new natural-language CLI trial passed both
historical and current-state checks with `codex/gpt-5.6-luna`, effort `low`.
The [raw result](automatic-results.json) contains exact synthetic identifiers,
calls, stop reasons, request usage and source fingerprints. This is one
controlled observation, not an estimated success rate or proof of general
semantic recall.

## Same question, a changed file, separate CLI processes

The [unchanged natural prompts](natural-results.md#protocol) first ask the CLI
to inspect a shipping file and describe its records in one sentence. Two
unpredictable identifiers lie beyond the visible retained preview. Between
turns, the harness replaces the file with new identifiers. A new CLI process
resumes the conversation and asks for the values from the earlier inspection.
A third process asks for the current values.

The only configuration treatment is `compaction.recallEvidence: true`. Live
provider decisions are neither scripted nor wrapped. The harness does not
mention search tools, archive locations or continuation cursors in the prompts.
It retains the six-iteration and 25,000 / 50,000 / 25,000-token admission limits,
and 180-second process timeouts. These are admission limits, not exact billing
ceilings. It uses an isolated workspace and disables web and project-memory
recall. No user file or credential is recorded in these results.

Reproduce from built packages:

```sh
node research/conversation-evidence/natural-cli.mjs --live --check-current --recall-evidence
```

This command uses the locally available Codex credentials and incurs model
usage. Omitting `--live` runs the separate scripted control, which verifies
archive plumbing and is not evidence of natural model behavior.

## Observed behavior

| Turn | Actual tool calls | Result | Reported tokens |
| --- | --- | --- | ---: |
| Initial inspection | One `read` | Completed; both originals retained, neither visible in initial text | 14,637 |
| Earlier values | None | Both exact original identifiers; no replacement substituted | 8,644 |
| Current values | One `grep` of the changed file | Both exact replacement identifiers; no original substituted | 17,694 |

All three turns ended with `end_turn`, no failed tools or process errors, and
the changed source remained unchanged. The first two turns consumed 23,281
reported tokens; all three consumed 40,975. The earlier live samples without
automatic attachment [remain failures](natural-results.md). Different model
choices and one sample per condition do not establish a general cost reduction.

The missing original values were supplied through automatic historical request
context. The historical answer required no additional model-directed search or
file read. The current question caused a fresh workspace observation, providing
a countercheck against treating recalled historical text as current truth.

## Implementation and engineering evidence

The SDK builds literal terms from current operator input, asks a host-bound
retriever for a bounded pool, ranks that pool with BM25 and emits at most four
passages in 6,000 characters of trailing runtime context. The host scans at
most four pages and accounts at most 8 MiB of source/metadata reads. This is not
OS disk I/O measurement. Source ownership, original retained-byte integrity,
preview/error labels and exact run/event/part/byte references are preserved.
No action is replayed to recover its output.

The mathematical reference is the pinned Pydantic AI Harness's
[conversation search code](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
Namzu uses statistics from its bounded candidate pool rather than claiming to
have scored the whole archive. It does not add an embedding service, model
judge, synonym expansion or a semantic intent classifier.

Tests exercise exact provenance and ranking, scope snapshots and foreign
candidates, query precedence, Unicode spelling, escaped-output bounds, visible
duplicates, timed-out overlapping reads, cancellation, changed archives and
changed invocation ownership. The real CLI Session test verifies opt-in/off
behavior, historical request context, isolation from another conversation and
current workspace text, and absence of the recalled text in the next generic
continuation. The live trial additionally crosses actual process restarts.

Workspace typecheck, build, lint and tests passed: 6,317 SDK tests and 2,836
CLI tests, with five existing CLI skips. All 256 SDK process tests passed.
The docs gate checked 69 pages, and 47 TypeScript fences plus 20 package
READMEs compiled. Exported-signature and SDK test-presence gates passed.
Existing lint warnings remain (35 SDK, 14 CLI). Release coverage,
consumer-install, publish and a new TUI visual validation are not claimed.

## Remaining limits

Automatic recall is off by default pending broader evaluation. It excludes
the requesting invocation; explicit conversation tools still handle its live
writer and missing details after in-run compaction. The archive scan visits
bounded directory entries and pages, not a globally ranked or chronological
corpus. Relevant evidence beyond that frontier may be missed. Lexical matching
does not resolve paraphrases in every language. An empty recall is not proof
of absence, and source labels do not guarantee the model will always choose
correctly. This step advances the dynamic-context goal; it does not complete
Namzu's broader autonomous-kernel vision.
