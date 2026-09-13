# Original-record selection in explicit conversation search

Date: 2026-09-13. Base: `df143c8b`. Local unpublished change.

In the [preceding live trial](excerpt-coverage-results.md), the second archive
search retrieved the first search's output. Its match was a `tool_completed`
record from `search_conversation`, carrying a quoted earlier assistant claim.
Automatic recall already excluded successful archive-retrieval outputs, while
new explicit searches did not. This was a concrete path for duplicate results
to take source slots. It does not establish why the model ultimately believed
the unsupported claim.

## Change and compatibility

New CLI `search_conversation` calls now omit successful `search_conversation`
and `read_conversation` outputs, sharing the automatic path's host-owned source
list. It uses the existing SDK filtering implementation; the SDK source defaults
remain unfiltered. Failed retrievals, unknown source/success records and assistant
claims are retained. Quoted tool names inside a message do not control filtering.
No larger scan allowance, cache, embedding model or auxiliary inference is added.

`includeRetrievalResults: true` explicitly inspects those outputs on a new search.
It is a deliberate inspection capability, not another source of independent proof.
It also restores the previous unfiltered explicit-search behavior. This default
change is declared as a CLI **major** changeset, not disguised as a patch.
No package version was hand-edited and no release was published.

Continuations preserve the original source filter, including host-supplied
focused scans. Repeating the query cannot silently reset it. Changing a filter
through an incompatible cursor is rejected. Exact authorized reads remain
available. Counts and guidance report omissions without converting a filtered
scan into proof of historical absence.

## Real CLI follow-up

The same [script](record-origin-cli.mjs) ran the claim-only scenario again with
Luna low, three iterations, a 20,000-token admission allowance and a 120-second
process deadline. Original records are scripted seeds; follow-up inference and
tool execution use the real CLI. [Raw observations](explicit-search-results.json)
retain stable build hashes, public requests, actual tool results and usage.

1. An ordinary ORCHID search returned the original assistant record and a cursor.
2. Cursor continuation returned no additional matches, explicitly excluded one
   successful retrieval output, and completed that traversal.
3. The model then requested a new search with `includeRetrievalResults: true`.
   The run stopped at the token limit before producing an answer.

The filter behaved correctly, but the model did **not** provide the required
uncertainty answer. Usage was 23,938 tokens (6,656 cached) versus 23,319 in the
preceding failed factual-answer sample. The per-call admission mechanism can
cross its stated token allowance on an already-admitted request. No latency,
cost or accuracy improvement is claimed. The archive and current file remained
unchanged. Normal termination was not substituted for a semantic acceptance test.

The model's unnecessary inspection request is a remaining behavior issue. The
explicit override is necessary for legitimate questions about previous retrieval
operations; removing it would prevent those inspections without proving better
judgment. A bounded check of task interpretation and answer support remains open.

## Interactive tool execution

A 90-column, 30-row TUI reopened the previous failed conversation and actually
executed both search forms using a [scripted provider](retrieval-filter-tui-fixture.mjs).
The fixture inspected the tool results at the next request boundary. It verified
that default search excluded retrieval copies and explicit inspection recovered
them. Both calls succeeded; the TUI displayed results, returned to idle and exited
via `/exit`. This exercises the real tool schema, registry, Session, scoped
archive and terminal; model text was deterministic and used no vendor tokens.

Local captures: `/tmp/namzu-record-origin-GOCsaA/tui-filter.ansi` and
`tui-filter.jsonl`. An initial test launch had an incorrectly transcribed session
ID and was exited at the folder-trust prompt; the successful launch used the ID
read from the stored fixture report.

Focused checks passed: 96 CLI tests across archive search and actual Session
integration. New backend cases cover legacy, indexed and active sources,
original/assistant/error preservation, explicit inspection, exact reads,
source-filter continuation and rejected filter changes. Workspace validation
results are recorded in the observation JSON. The broader kernel goal remains
active; this source-selection fix does not implement a universal factual judge.
