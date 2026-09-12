# Resumable conversation run discovery

Measured 2026-09-12 on Linux/WSL. Conversation evidence search previously
enumerated at most 100 directory entries, then permanently searched only that
initial set. When those runs were exhausted, it reported incomplete evidence
without a continuation for undiscovered runs. Knowing an exact run ID bypassed
the limit, but a model asking about an earlier observation need not know that ID.

## Source comparison and implementation

The pinned Pydantic AI Harness [HistorySource implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py)
defines a separate history source that enumerates persisted runs in start-time
order and recovers their original messages. It has no equivalent initial
100-directory-entry cutoff. That local source was inspected at the linked
revision; this is a contract comparison, not a performance comparison against
that framework.

Namzu already has exact, scoped SDK evidence sources. The defect was in the
CLI's discovery of which conversation runs to visit, so the fix stays in that
host layer and reuses the existing SDK readers. The deprecated SDK run index
is not used as authorization: it lacks tenant/project/session ownership, while
checkpoint listings describe checkpointed runs rather than all recorded text.

`RunDiscovery` retains bounded directory continuations. Each call reads at most
100 entries; after the current batch's runs are consumed, an outer conversation
cursor can fetch the next batch. Empty batches still continue. Cached name pages
make concurrent use of a continuation consistent without rewinding a directory
or rereading all prior entries.

The cache holds at most 32 scans and 128 name pages. It expires after ten
minutes; its cleanup timer does not keep the process alive. Exhaustion closes
the descriptor. Cancellation during discovery, invalid directory snapshots,
eviction and owning CLI Session shutdown release abandoned resources. Cached
names confer no authority and contain no tool output: every visited run still
passes the existing conversation, metadata, transcript and retained-byte checks.

A run directory's identity and metadata must remain unchanged for further
discovery. A new run or replacement requires restarting discovery. This is not
a persistent directory snapshot or a hostile-filesystem sandbox. Names are
sorted within each batch; filesystem batch order is not chronological or ranked.

## Same-archive comparison

An isolated fixture contained 120 valid UUID run directories with small legacy
transcripts. Only the last directory in actual enumeration order contained
`DELTA ORIGINAL-471`. Both builds searched the same unchanged fixture.

| Build/page | Runs scanned | Read bytes | Match | Continuation |
| --- | ---: | ---: | --- | --- |
| Previous build | 100 | 19,600 | None | None, permanently incomplete |
| Updated, first page | 100 | 19,600 | None | Yes |
| Updated, second page | 20 | 3,917 | Correct original | None; complete |

The durable run/sequence/part address then returned the exact original text.
This fixes discoverability beyond the initial batch; it does not reduce the
necessary bytes read or prove relevance ranking over an entire archive.

## Actual CLI execution

The [CLI script](discovery-cli.mjs) creates an isolated conversation with 120
historical run directories. Most contain small legacy transcripts. The last
contains a full SDK-retained tool output whose tracking/depot UUIDs are absent
from its 1,000-character preview and from ordinary conversation history. Its
metadata explicitly binds it to the conversation. The current workspace file
contains only an external replacement. These are synthetic recorded runs, not
120 live model turns.

The production CLI resumes that conversation with automatic recall enabled:

> Önceki DELTA kaydının takip kodunu ve hedef deposunu aynen söyle.

It uses `codex/gpt-5.6-luna`, effort `low`, four maximum iterations, a
25,000-token admission limit and a 120-second process timeout. The live wrapper
observes requests and forwards model decisions unchanged. Omitting `--live`
uses a separate scripted provider control.

```sh
node research/conversation-evidence/discovery-cli.mjs --live
```

The final control and live trial passed. During the live invocation the target
remained at directory position 120, beyond the first batch. One provider request
carried both exact identifiers in 1,230 characters of runtime context; ordinary
messages contained neither. The model returned both identifiers, made zero tool
calls and ended with `end_turn`. The replaced workspace file stayed unchanged.
Reported usage was 6,951 unpriced subscription tokens; no billing cost is inferred.
Relevant built modules remained unchanged throughout the process.

The initial scripted control failed a harness assertion: it counted `index.json`
as a run alongside the new run directory. Its response already contained both
originals. The script was corrected to count directories, then the control was
rerun before spending live-model tokens. The failed control remains in the
[raw records](discovery-results.json), alongside the comparison, final control,
live trial and source hashes. One successful live trial is not a general success
rate or evidence of a long autonomous plan.

## Validation and limits

Focused tests cover complete discovery, empty batches, concurrent/repeated
continuations, mutation-resistant cached pages, scope and path rejection,
directory append/replacement/symlink invalidation, cancellation, TTL, descriptor
closure, 32-scan eviction and 128-page eviction. A production CLI Session test
verifies shutdown invalidates its pending search continuation. Existing exact
text, compaction, restart, altered-output and cross-conversation tests passed.

Workspace typecheck, build, lint and tests passed: 6,333 SDK tests and 2,851 CLI
tests, with five existing CLI skips. Existing lint warnings remain (35 SDK and
14 CLI). Documentation validation checked 69 pages and compiled 47 TypeScript
fences plus 20 package READMEs; one declared sketch was skipped. SDK process,
release coverage and consumer-install gates were not rerun for this CLI-only
implementation. No push, publication or new TUI visual behavior is claimed.

Automatic recall still admits only four pages and 8 MiB per preparation pass.
Many text-heavy or fully indexed runs can require more explicit continuations.
It remains opt-in and lexically ranked over a bounded pool; chronology,
global relevance and reliable paraphrase recall are not established here.
The broader autonomous-kernel goal remains active.
