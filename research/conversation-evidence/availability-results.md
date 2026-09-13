# Failed recall is unavailable evidence, not an empty search

Base: `6cd24e93`, 2026-09-13. [Raw observations](availability-results.json).

## Verified defect and implementation

The query loop logged failed optional preparation stages and omitted their
contribution. A malformed historical-query plan or failed retrieval therefore
left no model-visible distinction between unavailable recall and an ordinary
request without additional evidence. Two real query-loop tests reproduced that
missing status before implementation.

SDK recall failures now carry a fixed availability note through an internal
error wrapper. The loop keeps the error diagnostic and appends only the safe
note to temporary context, within estimated remaining request room. Earlier preparation
decisions survive. Generic exceptions do not gain this behavior, and exception
bodies, malformed plans and rejected passages are not copied into the note.
Parent cancellation propagates without reviving model work. While a timed-out
read remains unresolved, subsequent passes report pending availability without
starting overlapping retrieval; later successful reads use fresh evidence.

The note is absent from durable operator messages and system policy. Explicit
archive tools remain usable, and a failed plan stays cached for its operator
input instead of consuming a fresh inference every iteration. This corrects
missing runtime information; the live failures below show that information alone
does **not** ensure a correct source choice.

The current Pydantic AI harness
[conversation search toolset](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/conversation_search/_toolset.py)
was inspected as a primary reference. It describes explicit retrieval for
historical details missing from active context, and separates that use from
external or real-time information. Namzu's failure handling and model behavior
are evaluated locally below.

## Bounded live failure experiment

Run the [natural CLI driver](natural-cli.mjs) with:

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --fail-query-plan --live
```

The initial observation is scripted but uses the real CLI file tool and archive.
Two generated identifiers are retained beyond the visible preview of a 400-line
file. The driver confirms neither identifier is visible, then externally replaces
the file with different identifiers. Each follow-up opens a new real CLI process
and asks: `Az önce baktığın kaydın iki kimliğini aynen yazar mısın?`

The preparation response is deliberately replaced with invalid JSON, with zero
live preparation usage. Main requests use live Codex `gpt-5.6-luna`, low effort,
four iterations, a 30,000-token admission allowance and a 120-second process
deadline. This is fault injection, not a measurement of natural planner failure
frequency. No tool choices or main answers are scripted.

| Candidate | Status in main request | Model behavior | Live tokens |
| --- | --- | --- | ---: |
| Availability note (`sjRXdt`) | Present on both main requests; 556 context characters | **Wrong:** workspace grep, then current replacement values as the historical answer | 17,121 |
| Note with exact archive tool names (`l5xpAt`) | Present on both main requests; 819 context characters | **Wrong:** workspace grep, then current replacement values as the historical answer | 17,301 |

Both cases completed normally, preserved the replacement file and made no
`search_conversation` or `read_conversation` calls. The originals never entered
their ordinary history or automatic context. All measured build fingerprints
were stable during each run. The final production build matches all eleven
fingerprints from the availability-only case.

The combined live usage was **34,422 tokens**, with no price conversion for the
subscription provider. These are two independent generated fixtures, not an
accuracy benchmark or a controlled estimate of the note's effect. Neither run
establishes improved historical recovery. The optional tool-name API was removed
after its candidate did not change the observed wrong source selection. Its
[experimental patch, stored as JSON](experimental-recovery-hints.json) is retained for inspection;
it is not part of the SDK surface or CLI configuration.

## Real Session and terminal checks

A real CLI Session test reopens archived original evidence, injects one invalid
plan, then scripts model decisions to call the real archive search and exact
read tools. All three main requests contain unavailable-planning status, the
private invalid-plan marker never enters them, and the exact original is
returned. The plan is attempted once. Durable conversation history contains no
availability note. This proves recovery mechanics, not natural tool selection.

The [TUI fixture](default-recall-tui-fixture.mjs) also supports
`NAMZU_RECALL_FAIL_PLAN=1`. A real 100×28 terminal resumed an isolated generated
conversation and accepted the same historical follow-up. Controlled decisions
verified status, executed one actual archive search and one exact read, and
returned the original identifiers. The xterm-parsed capture shows one search
card, one read card, the answer and an idle composer. Archive and workspace
hashes remained unchanged; `/exit` returned zero. This used no live model tokens.

SDK tests additionally cover preservation of prior stage decisions, rejection
of forged ordinary-error context, a 12,000-character ceiling, remaining context
room, cancellation during retrieval, timeout overlap exclusion and fresh reads
after the old callback settles. Existing whole-batch scope/integrity validation
still rejects before exposing any candidate. Workspace typecheck, lint, build
and all package tests pass: 6,691 SDK tests and 2,977 CLI tests (five existing CLI
skips). SDK process tests pass as well. Docs conformance, 48 compiled SDK fences
and 20 package READMEs pass, as do the SDK test-presence, signature-export and log
standard gates. Extracting the experimental JSON patch and running `git apply --check` succeeds
against the final source without applying it.

The open problem is explicit: even when failed recall is visible, the small model
can substitute a current observation for a requested past observation. Further
work needs evidence about source selection and request construction, with these
failed trajectories retained as controls. The broader goal remains incomplete.
