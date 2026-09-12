# Finding a second passage in retained output

Measured 2026-09-12 on Linux/WSL, Node 24.19.0. This continues the
[active-invocation experiment](active-results.md); its unsuccessful runs remain
part of the evidence. Source fingerprints, commands' tool calls and token counts
for this follow-up are in [passage-results.json](passage-results.json).

## Diagnosis and implementation

Two earlier live runs recovered a tracking identifier but missed its destination.
The original source contained `Destination`, while the model searched for
`destination`. Search was case-sensitive. In addition, the two relevant passages
were in the same 64 KiB chunk: only its first matching passage was returned, and
the continuation advanced to another chunk. Explicit advice to open the exact
text did not fix the observed model behavior.

The pinned Pydantic AI Harness
[conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
lowercases word tokens and ranks messages with BM25; its multi-word queries
match words independently. The useful distinction is between searchable forms
and the original evidence. Namzu now offers Unicode case-insensitive literal
matching while retaining original text and positions. It does not implement
that reference's BM25 ranking or independent-word semantics.

SDK run-source search keeps `caseSensitive: true` as its default and adds the
optional false setting. CLI `search_conversation` selects false by default;
explicit true restores its former behavior. Active and closed run sources now
page separate passages within a chunk. Nearby hits fully shown by one excerpt
are grouped. A match beginning in overlap bytes belongs to the next chunk, so
the same start is not returned twice. Cursors bind the case setting and the
position within the chunk.

Existing filters encode exact case. Ignoring their negative decisions for
case-insensitive searches avoids false negatives, at the cost of reading more
candidate text. The I/O ceiling, source authentication, scope checks and exact
read bounds remain unchanged. This is a retrieval correction, not a measured
overall memory or reasoning improvement.

## CLI observations

The protocol and assertions in [active-cli.mjs](active-cli.mjs) are unchanged:
read a synthetic file once, replace it externally before the next model request,
recover two unpredictable identifiers absent from its preview, use conversation
search and exact read, and leave the replacement file alone. No live model
choice is scripted. Two live trials were declared before execution; both are
reported here. The harness additionally records user-outcome observations
before asserting the original requested workflow.

| Sample | Outcome | Tool calls | Reported tokens |
| --- | --- | --- | ---: |
| Offline CLI | Both IDs, exact read, no workspace replay | read → search → exact read | 0 (scripted provider) |
| Live 1, Luna/low | Both IDs, exact read, no workspace replay | read → two searches → exact read | 82,425 |
| Live 2, Luna/low | Both IDs, exact read, no workspace replay | read → search → exact read | 45,835 |

The first live trial initially searched for `DELTA receipt`, which is not a
contiguous phrase in `DELTA original receipt`. Its next search, `DELTA`, found
the relevant passages. The second trial used `DELTA` directly. Both opened the
original text with `read_conversation`; neither repeated the workspace read or
executed another external action. Both had zero failed tools.

These are subscription tokens without a price catalogue cost, not proof that
the calls were free. The eight-iteration/65,000-token admission budget remains
the same as before. An admitted request can settle above that token threshold;
the first trial did. The small sample does not establish a success rate or a
token-cost improvement. The first trial still exposes a literal-query mismatch;
large repeated previews and retrieval results also remain potential context
costs requiring separate measurement.

## Contract validation

New tests cover multiple passages in one chunk, boundary ownership, Unicode
case matching with exact UTF-8/UTF-16 offsets, escaped regex punctuation, dense
astral matches without a stalled cursor, and changed case settings on a cursor.
Both active and closed sources run these cases. CLI checks cover its default,
legacy transcripts, exact-case opt-in and cursor binding.

The production CLI Session test also uses a lowercase query after actual
structured compaction and intervening appends, verifies both separated passages,
and reads the original text after external file replacement. Its model decisions
are scripted; the live command trials above are the separate model test.

Workspace typecheck, lint, build and tests passed (SDK 6,280; CLI 2,826 with five
skips), along with 254 process regressions, the final 25-test retained-evidence
check (including an additional locale-casing regression), the scoped final
Session check, documentation gates and exported-signature checks. Release coverage, evals, consumer install and publish
gates are not claimed by these results.
