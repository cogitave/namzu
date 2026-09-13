# Check returned evidence pages before using them

2026-09-13. Base: `7168bbf6`. [Measurements](source-boundary-results.json).

The CLI already checked a captured source's ownership. Automatic recall also
checked the returned page's ownership and read allowance, but explicit search
trusted that page. Exact reads checked the sequence and part while trusting
the returned scope, byte accounting and continuation positions. Cold address
lookup did not reject a different sequence/part before asking the source to
read. An awaited read could return successfully after a callback ignored abort.

This is a captured-source contract gap demonstrated with faulty host callbacks.
It is not evidence that a model bypassed the built-in SDK's scoped, authenticated
storage readers. Matching owner strings cannot authenticate arbitrary text
from a custom host source.

## Change

A CLI-private validator now checks returned search pages before any excerpt or
address enters the response/cache. Automatic live recall uses that same check;
closed-history recall already goes through the explicit search core. It checks
all four owner fields, remaining read allowance, match count, bounded metadata,
excerpt size and completeness consistency. An unavailable search stays partial
and conservatively consumes the remaining allowance when cost cannot be trusted.

Exact reads check cold lookup identity, returned scope and byte budget, requested
offset, UTF-8 text length and continuation positions. Abort is checked after
the awaited response. Known character counts must fit the returned text;
unknown character counts remain unknown. The SDK API, built-in authentication,
source permissions and existing retrieval ceilings are unchanged.

## Regression and process evidence

The first 26 focused cases produced **25 failures and one pass** on the base.
The positive Unicode control was the pass. With the fix and five additional
cases, all **31 new tests** pass. They include each foreign owner field, invalid
counters and output bounds, incorrect cold lookup identity, contradictory
completeness, a malformed second match after a valid first match, and an abort
ignored by the custom reader. Whole-batch validation prevents that first match
from binding an address before a later invalid match is noticed.

The [process driver](source-boundary-cli.mjs) launches the production CLI in a
fresh generated workspace, calls its actual file-read tool, then uses the actual
conversation tools. A synchronous controlled provider supplies decisions. A
preload wraps the real SDK capture result and deliberately substitutes a foreign
page scope plus a random sentinel. There is no paid inference in these controls.

| Mode | Result |
| --- | --- |
| Search page fault | Empty matches, incomplete coverage, unavailable run; no rejected sentinel in model input, transcript or CLI output |
| Exact read fault | Real search finds the record; the subsequent foreign read fails; no rejected sentinel in model input, transcript or CLI output |
| TUI exact read fault | Same tools in a 100×28 PTY; error displayed, one final response, idle composer, `/exit` returns zero |

Both headless cases reached `end_turn`, preserved the generated note and kept
the four measured production files unchanged. The TUI terminal was replayed
through `@xterm/headless`; recorded tools were exactly `read`,
`search_conversation`, `read_conversation`. The generic failed-read card still
shows the existing address/offset guidance and raw argument preview. This check
establishes rejection and an operational composer, not an error-card UX redesign.

Reproduce the headless controls after building:

```sh
node research/conversation-evidence/source-boundary-cli.mjs search
node research/conversation-evidence/source-boundary-cli.mjs read
```

For the TUI, prepare a fresh fixture with `read --tui`, then set `NAMZU_HOME`
to its `home`, `NAMZU_BOUNDARY_ROOT` to the reported root and
`NAMZU_BOUNDARY_PRELOAD=1`. From its generated workspace, launch the built CLI
with `node --import <absolute-path-to-source-boundary-cli.mjs>` and
`--yolo resume <reported-sessionId>`. Trust only that generated folder and enter:
“Read note.txt once, then recover its recorded text through the conversation
tools.” Exit after the failed archive read and controlled response.

## Valid live recovery

One bounded production CLI trial used Codex **gpt-5.6-luna, low effort** through
the existing [index-page fixture](index-pages-cli.mjs). That fixture retains an
actual oversized read and constructs a separate compaction archive before it.
It is not a new live compaction experiment. Automatic recall is disabled to
isolate explicit retrieval. Limits: four iterations, 30,000-token admission
allowance, 120-second process deadline. No production edit/build occurred during
the run; five built-file fingerprints and all seven source hashes stayed stable.

The model answered “DELTA kaydını ilk okuduğumuzdaki takip kodu ve hedef deposu
neydi?” with both exact generated identifiers, using one `search_conversation`
call (`limit: 10`) and no workspace tool. Cold and warm direct controls each
reached the original in one public page and recovered both IDs through exact
reads. Usage: **15,010 unpriced subscription tokens**. Reported zero cost does
not mean free usage. This is one positive trial, not a general accuracy rate.

## Checks and remaining limits

All four focused files pass **143 tests**. Workspace typecheck, lint, build and
package tests pass, including **6,696 SDK** and **3,017 CLI** tests; five existing
CLI tests remain skipped. Lint reports existing warnings without errors. Docs
conformance and compiled fences pass. Release-only gates and publishing are not
claimed.

The contract check detects inconsistent host responses. It cannot stop a custom
host callback from doing excessive I/O before returning, prove the truth of
correctly shaped arbitrary text, recover unrecorded evidence, or force a model
to use a suitable historical source. Those limits remain distinct from storage
integrity and from model source selection. The broader goal remains active.
