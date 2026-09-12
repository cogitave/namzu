# Bounded live recall across operational records

Measured 2026-09-12 on Linux/WSL. The previous writer-linked search spent its
64-record page allowance on every operational event. CLI automatic recall reads
at most two live pages, so 512 nontext events between an observation and the
current request could hide an otherwise retained and relevant observation.

## Primary-source comparison and design

Pydantic AI Harness's [conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
uses one searchable document per persisted message. Its `_format_request_part`
returns no content for tool-availability bookkeeping, and `_user_prompt_text`
excludes binary image data from text ranking. This was inspected in the local
checkout at that exact revision. It motivates separating content from
bookkeeping; it does not provide the authenticated skip-link algorithm below.

Namzu's durable writer now records an optional `previousTextRecord` pointer
alongside the adjacent `previousRecord` pointer. It commits the pointer only
after the append succeeds. Both pointers are covered by the record hash.
Text search follows the previous text or integrity boundary; operational event
readers still see every event. The new path uses the existing byte, part, chunk,
scope, cancellation, address and continuation limits.

Malformed content remains a traversal stop that the reader rejects. Starts and
unlinked boundaries are retained as targets, so skipping nontext events cannot
turn an incomplete history into a complete one. After reopening, a bounded
tail read recovers a known text pointer. An older tail without that field stays
unknown and uses adjacent traversal until indexed content is reached.

This checks selected text and its authenticated links. It does not reread or
audit the contents of skipped operational records. No model decision or
state-changing tool action is replayed.

## Controlled comparison

The [measurement script](text-links.mjs) creates a real `RunDiskStore`, a retained
tool output with an exact synthetic receipt outside the visible preview, and
512 `iteration_started` records after the output. It searches for two literal
terms using the same two-page limit as automatic CLI recall. The changed build
uses the original trial's UUIDs and receipt to reconstruct identical logical
events and output bytes in a new isolated directory.

| Build | Pages used | Records visited | Receipt found | Accounted read bytes |
| --- | ---: | ---: | --- | ---: |
| Before text links | 2 | 128 | No; continuation remains | 34,744 |
| With text links | 1 | 3 | Yes; exact read verified | 714,259 |

The successful search reads more bytes because it actually reaches the retained
output, whose chunks and manifest must be authenticated. The result establishes
better coverage within the same page allowance, not lower total I/O or a model
score improvement. Text pointers also add storage per written event: this
small-record fixture's transcript grows from 134,963 to 203,868 bytes (68,905
additional bytes across 514 records). This is a tradeoff for bounded direct
access, not free indexing. The [raw records](text-links-results.json) preserve
the measurements and source fingerprints.

```sh
node research/conversation-evidence/text-links.mjs --expect-found
```

To reconstruct an earlier fixture, also pass `--seed=/absolute/path/to/result.json`.
These commands use synthetic local data and incur no model usage.

## Regression scope

SDK tests cover long nontext stretches, reopening, exact Unicode text, older
captured boundaries, pagination order, caller-injected links, legacy tails,
torn boundaries, malformed tool/message/compaction records, altered selected
text, cancellation and invalid predecessor pointers. A CLI binding test passes
the actual store capture through automatic recall after 512 operational events
and verifies one capture and one original tool completion.

The existing production CLI Session tests also run again: explicit and automatic
retrieval after actual compaction, one original file read, external replacement,
restart and foreign ownership rejection. Their provider is scripted to control
compaction; they are distinct from the separate small live-model CLI trial.

## Terminal execution and validation

The [actual CLI harness](active-cli.mjs) passed in both scripted control and live
`codex/gpt-5.6-luna` / `low` modes, with automatic recall enabled. The live trial
used `glob` and one `read`, returned both original synthetic identifiers, and
ended with `end_turn`. Reported token usage was 21,933; those tokens were
unpriced by the driver, so a zero reported cost is not a claim of free usage.

The third provider request carried both originals in 1,927 characters of runtime
context; ordinary messages contained neither. It used no explicit archive tool
and did not reread the externally replaced file. There were no tool failures,
and the replacement remained unchanged. Relevant built modules had the same
hashes before and after execution. This short live trial did not compact or
create 512 bookkeeping events; the controlled store/CLI tests establish those
separate properties. One passing trial is not a general model success rate.

Workspace typecheck, build, lint and tests passed: 6,333 SDK tests and 2,841 CLI
tests, with five existing CLI skips. All 256 SDK process tests also passed.
Existing lint warnings remain (35 SDK,
14 CLI). The documentation gates checked 69 pages, compiled 47 TypeScript
fences and 20 package READMEs, and skipped one declared sketch. Signature export
and SDK test-presence gates passed. Release coverage and consumer-install gates
were not rerun; no push or publication is claimed.

## Limits

The optimization does not skip text-bearing messages, tool results or compaction
content. More than the admitted text pages can still hide older relevant text.
Closed-run discovery and its forward index are unchanged. Automatic recall
remains opt-in; lexical matching does not guarantee paraphrase recall. This
change adds no TUI visual behavior and does not complete the broader autonomous
kernel goal.
