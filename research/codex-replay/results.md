# Codex native continuity: finalized stream items

Measured against the local work following `fd0d2709`, on 2026-09-12. This is a
transport and persistence check, not a memory benchmark or a claim of improved
reasoning scores. [Machine-readable observations](results.json) include failed
experiment setups as well as the final passing check.

## Finding and correction

The previous visible-evidence experiment persisted assistant answers whose
native replay state had `content: null` and `items: []`. Inspecting the live
Responses stream established the cause: completed reasoning/function/message
items arrived in `response.output_item.done`, but `response.completed.output`
was empty. The adapter built its replay state and finish reason solely from the
latter. The native state was already empty when emitted by the provider, before
SDK persistence. Tool execution still occurred through streamed tool deltas,
but the adapter incorrectly labelled that response `stop`.

The corrected adapter retains finalized items by output index, uses them when
the terminal snapshot is empty or absent, and uses a populated terminal snapshot
unchanged. It does not concatenate both copies. The selected output determines
replay state, function-call finish reason and hosted citation links. Added items
and interrupted responses do not become completed replay records. Existing
route, message-content and tool-call equality checks remain unchanged.

The [official Responses event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)
describes finalized output-item events separately from response completion.
The empty final snapshot is direct subscription-endpoint evidence, not a claim
that every Responses implementation omits the output array. A local Codex source
snapshot also accumulates `OutputItemDone`, but its checkout had no Git metadata;
it was not used as a revision-pinned authority for the change.

## Live checks and their limits

Every request used `gpt-5.6-luna` at `low`. Each process had a 30,000-token
admission budget, three-iteration cap and 90-second timeout. Web and memory recall
were disabled, the workspace contained only a synthetic note, and its contents
were checked for modifications. No additional model calls are introduced by the
fix. Native item equality is checked with SHA-256 over the complete JSON item;
the diagnostic output contains item types/digests and public answers, not
credentials, reasoning text or encrypted reasoning payloads.

| Case | Observed result | Interpretation |
| --- | --- | --- |
| `jR4qG8`, old adapter | Finalized items present; emitted replay empty; tool response marked `stop` | Valid stream diagnosis. The script wrongly expected `run` to return a session ID, so restart assertions did not run. |
| `x4aoeA` | Zero model requests; empty transcript rejected | Fixture setup error. Excluded from comparisons. |
| `qigKpo`, old adapter | First tool response's reasoning/function items were not replayed into the next request; native records on disk empty | Confirms loss within a tool continuation. Final script audit hit `runs/index.json` as if it were a directory. The retained stream/disk observations were inspected separately. |
| `du6b34`, corrected adapter | Native reasoning/function items replayed exactly within the tool continuation; persisted state populated | Restart answer failed because `run --resume` reads prior history but does not publish its new turn. This experiment incorrectly assumed publication; it is not evidence of a model memory failure or a TUI resume defect. |
| `Xhth0P`, corrected adapter, `run-stream --session` | Two processes, three model requests, one read, both answers correct; all three prior native items replayed exactly after restart | The supported persistent CLI path passed. Five stored assistant-message occurrences all retained eligible native state; repeated occurrences come from the later run's retained history. |

The final case reported 20,359 tokens. Total usage, including unsuccessful setup
attempts that reached a model, is in the JSON report. These are unpriced tokens;
a reported zero cost does not establish free usage. Build fingerprints were
stable during every measurement. The earlier one-shot cases cannot serve as a
before/after restart score comparison because they used a different persistence
contract.

## Repeat and regression coverage

After building the workspace, run:

```bash
node research/codex-replay/cli.mjs --live
```

The script creates an isolated `NAMZU_HOME` and workspace, invokes the actual
CLI twice under the same `run-stream --session` key, and checks exact native
replay both within the first tool turn and after process restart. `--baseline`
is only for running against an older adapter; it does not alter the stream.

Nine provider tests cover empty/missing and populated terminal snapshots,
indexed ordering and deduplication, tool-only/null-content turns, hosted sources,
serialization, replay rejection after edits or route changes, cancellation,
incomplete streams and concurrent invocations. A permanent CLI Session test
uses the real kernel/provider/store with fixture transport events to check a tool
continuation, JSONL publication/reload, reconstructed Session and model switch.
The live check is headless CLI execution; it does not inspect terminal rendering.

Workspace typecheck, build, lint, all package tests and the documentation check
passed. The workspace suite includes 6,407 SDK tests, 2,871 CLI tests (five
skipped) and 122 OpenAI provider tests. The strengthened concurrent-stream
regression also passed independently. Release-only coverage, consumer-install
and publication gates were not run; no push or publish was performed.

The previously recorded long-code copying error remains unresolved. Restoring
native continuity does not prove that the model always reads temporal evidence
correctly or copies arbitrary identifiers exactly. Old discarded native state
also cannot be recreated from plain conversation text.
