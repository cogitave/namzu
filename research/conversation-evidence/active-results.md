# Retained evidence inside a running invocation

Measured 2026-09-12 on Linux/WSL, Node 24.19.0. This is a bounded CLI integration
experiment, not a model or harness leaderboard. Machine-readable observations,
including unsuccessful runs and source fingerprints, are in
[active-results.json](active-results.json).

## What changed

The previous conversation integration searched authenticated retained output
only after its run closed. During a run it scanned the transcript preview, and
further appends invalidated the scanner's file snapshot. The kernel now captures
a completed writer boundary and follows authenticated preceding-record links.
New events preserve the old read boundary. Search/read share the existing spill
manifest verification and exact Unicode paging with closed-run retrieval.

Only the requesting invocation gets that live capability, under the CLI's
conversation authorization. Other active runs retain the bounded transcript
scanner. Read-only recovery never repeats the original action.

The comparison informed by the pinned
[step-persistence implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/step_persistence/_capability.py)
was the separation of completed tool boundaries from replay decisions: that
implementation records tool effects and continuable snapshots at settled tool
boundaries. Namzu reuses its serialized event writer for a bounded evidence
snapshot. This is an independently implemented storage/read mechanism, not a
claim that the reference uses this hash chain or has worse retrieval performance.

## Real CLI experiment

Run from a built checkout:

```sh
node research/conversation-evidence/active-cli.mjs
node research/conversation-evidence/active-cli.mjs --live
```

Each run creates an isolated application home and a synthetic 400-line file.
Two unpredictable UUIDs appear beyond the ordinary 40,000-character tool preview.
A preload wrapper replaces the workspace file after the real initial read,
before the next provider request. It does not alter the live provider's inputs,
outputs or decisions. The production CLI command, conversation ownership, file
tool, event writer, search and read implementations execute normally.

The live mode uses Codex `gpt-5.6-luna`, `low`, eight maximum iterations and a
65,000-token admission budget. Reported tokens can exceed that threshold when an
already admitted provider request settles; this is not a hard billing cap.
The offline mode scripts model choices but exercises the same command boundary.

| Sample | Outcome | Calls | Reported tokens |
| --- | --- | --- | ---: |
| First live run | Both original IDs recovered | read → search → read_conversation | 45,067 |
| Second live run | Tracking recovered; destination missing | read → three searches | 80,633 |
| Live run with source hints | Tracking recovered; destination missing | read → three searches | 80,949 |
| Final offline command | Both original IDs recovered | read → search → read_conversation | 0 |

The unsuccessful live runs had no failed tool execution. The model searched for
lowercase `destination` in a case-sensitive source containing `Destination` and
continued searching excerpts instead of opening the original passage. Its final
answer acknowledged the missing field. Adding the originating tool name and
explicit excerpt/read guidance improved provenance but did **not** establish a
behavioral improvement in the observed follow-up run. The three live samples
must not be presented as uniformly successful or as a reliable success-rate
estimate. Further work belongs in retrieval use and dynamic context cost, not
in silently treating partial answers as complete.

The command fixture does not claim automatic compaction. A separate real CLI
Session test drives the structured compactor with scripted provider usage,
checks that the original `read` result appears in `compaction_shed`, and recovers
its retained text within the same invocation after intervening tool calls.

## Contract checks

- Concurrent appends preserve original search boundaries and exact complete
  reads, including BOM, CRLF, astral characters and chunk boundaries.
- Modified record bytes, modified retained output, foreign ownership and
  cancelled/departed invocations are refused.
- A torn or unlinked boundary yields explicit incomplete evidence.
- A new process bootstraps the preceding record and recovers its text; old live
  writer addresses expire, while durable event identities remain usable.
- Search pages bound records, textual parts, chunk candidates and I/O. A record
  that cannot fit the requested page budget is refused rather than producing an
  unchanging continuation forever.
- CLI matches identify the original tool when its name fits the display budget;
  unusually large names are omitted instead of overflowing the result budget.

Workspace unit tests, typechecking, lint and build passed, along with process
regressions and documentation fences. These checks do not constitute a release
validation of coverage, evals, consumer installs or every publish gate.

## Write cost

`node research/conversation-evidence/append-cost.mjs` compares the former
append-file implementation with the linked writer over five alternating runs
of 500 events each. Median observed append time was 0.236 ms before and 0.338 ms
with links: about 0.103 ms additional time per event (43% in this microbenchmark).
The fixture gained approximately 133 bytes per event. This is a measured cost,
not a speedup. It buys a stable authenticated boundary without copying a growing
transcript or reading it in full on every tool call. Results from this local
filesystem should not be generalized to Windows or remote storage.
