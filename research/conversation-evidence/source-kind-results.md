# Consistent source identity in recalled conversation text

2026-09-13. This change closes a metadata gap; the live negative result below
does **not** establish improved factual accuracy. Raw requests, usage, build
fingerprints and interactive traces are in `source-kind-results.json`.

## Finding and change

Automatic SDK recall already distinguished an assistant claim from a tool
result using a `recordKind` label. Explicit CLI search returned only the raw
event `source`, and exact reads omitted recorded `toolName` and `isError`.
The same original record therefore lost useful metadata depending on how the
model accessed it.

The SDK now exposes its existing tag classification as
`classifyEvidenceSource`, with `EvidenceRecordKind` and
`EVIDENCE_RECORD_GUIDANCE`. Automatic recall keeps its previous classification
and guidance. Explicit search and located read pages use the same projection;
reads preserve known tool names and error status. Missing status stays unknown.
Labels embedded in passage prose cannot change the recorded producer. A label
does not authenticate text or establish that a claim is true, and a successful
tool can return quoted claims.

Source addresses, archive scope and text integrity checks are unchanged.
Tool names larger than 256 JSON-encoded UTF-8 bytes are omitted consistently;
this does not truncate the original text. New metadata is included when
accounting for search-match output bytes. Empty lookup-progress pages have no
source classification until their requested record is found.

## Live negative control

Run from the repository root after building:

```sh
node research/conversation-evidence/source-support-review-cli.mjs --live --natural --roles --correct --baseline --case=claim-as-fact --seed=natural-claim-20260913
```

All four candidate requests used `gpt-5.6-luna` with `low` effort. The original
archive held a synthetic assistant assertion about a receipt, without the
original file observation. The first explicit search result carried
`recordKind: assistant_message` and the new shared guidance in the next
candidate request. No tool was removed by the research script to force an
answer. The optional answer reviewer was disabled for this baseline.

The model searched `ORCHID`, continued the returned cursor, then searched
`receipt` with retrieval-result inclusion enabled. After 24,245 reported
tokens, the existing 90% warning on the 26,000 allowance requested tool-free
closing prose. That fourth request asserted the archived code as the original
file value, without attributing it to the earlier assistant. The final stop
reason was correctly `token_budget`, not normal completion.

Total reported usage was **33,177 tokens**, zero cached, with zero judge calls.
Admission allowances do not cap the final provider receipt. The unchanged
build hashes and actual result payloads are retained. This is one unpaired
sample, not a before/after accuracy or efficiency comparison. The metadata
change did not prevent the unsupported closing assertion.

## Actual interactive execution

`source-kind-tui-fixture.mjs` drives a built CLI through scripted provider
transport. It performs actual archive tools and asserts the results in the
next provider request; it does not measure model reasoning. Seed its isolated
archive with:

```sh
node research/conversation-evidence/source-support-review-cli.mjs --roles --originals --case=conflicting-claim
```

The seed report supplies `root`, `sessionId` and `sourceRun`. Launch the built
CLI with the fixture imported, `NAMZU_HOME` set to that root's `home`,
`NAMZU_SOURCE_KIND_RUN` set to `sourceRun`, and `NAMZU_SOURCE_KIND_TRACE`
pointing to a temporary JSONL file. Resume `sessionId` from the fixture's
`workspace`; the JSON result records the exact executed paths and environment.

In a real 100-column, 28-row PTY, the resumed compacted session searched once
and read the observation and conflicting assistant claim. The next request
contained `tool_result`/`read`/`isError: false` for the observation and
`assistant_message` with unknown tool/error metadata for the claim. Both
reads were complete and retained the shared interpretation guidance.
The composer returned idle and `/exit` exited zero. Four original source
files kept identical SHA-256 hashes; no action was replayed. Installed
`@xterm/headless` replayed the captured ANSI to inspect the final frame.
These terminal assertions used **zero live inference tokens**.

## Local verification

Workspace typecheck, lint, tests and build passed. The SDK suite passed 6,682
tests; the CLI passed 2,957 with five skipped. Focused checks cover legacy
transcripts, indexed archives and the current live invocation, including
quoted producer metadata, errors, omitted oversized tool names, restart,
bounded lookup progress and unchanged exact text. The first focused run found
one strict expected-object fixture lacking the new `recordKind` field; that
expected result was updated and the suite passed. No failing behavior was
removed from the assertions.

Documentation conformance passed, and 48 TypeScript fences plus package README
fences compiled. Signature exports (673 signatures), test presence, publish
metadata, project references and workflow gate parity also passed. Lint retains
existing warnings. These are local checks, **not** all release gates, a push or
a published version.

## Primary-source comparison and next question

[Pydantic AI Harness's conversation-search capability](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/conversation_search/_capability.py)
reads persisted history through a separate source, defaults to conversation
scope, and instructs retrieval when current context lacks a needed detail.
That separation supports treating retrieval as access to records, without
granting their contents a truth verdict. The changes here follow Namzu's own
observed metadata mismatch, rather than importing a new search backend.

The remaining question is semantic and operational: can bounded retrieval
finish with an appropriately attributed answer when no original observation
exists? Source identity is now consistent, but the negative live trace still
shows an unsupported claim at the closing boundary. Keep additional judging
opt-in until measured natural candidates demonstrate a benefit. Do not call
this change a solved reasoning problem or an accuracy gain.
