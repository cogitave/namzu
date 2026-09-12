# Original user evidence after manual compaction

Date: 2026-09-12. This is a CLI and SDK retention regression experiment, not a
general memory-accuracy benchmark.

## Confirmed defect

Automatic compaction already records removed messages before replacing live
history. The CLI's separate `/compact` entry point called SDK `compactNow` and
saved its returned summary without archiving originals. An exact user detail
beyond the summary extractor's character allowance could disappear from the
searchable corpus. It might still exist in an older run snapshot or the TUI's
turn journal; that did not make it reachable through conversation search.

The baseline real CLI Session regression found **zero matches** after manual
compaction and reopening. Its code was absent from the actual summary. The
baseline failed on the expected one-match assertion, not on credentials or a
manufactured replacement summary. Baseline log:
`/tmp/namzu-manual-evidence-baseline.log`.

The SDK now awaits optional `onShed` on both manual compaction paths. Recorded
CLI sessions use it to archive removed originals before returning the replacement.
A zero-model maintenance record reuses the scoped SDK store and evidence index;
it does not append an answer to the conversation or reopen a completed run.

## Primary-source comparison

Pydantic AI Harness's conversation search renders user prompt text explicitly,
indexes the full textual rendering separately from display excerpts, and loads
history under the selected conversation/run scope. That supports testing user
input independently of assistant and tool output. It does not establish how
every host/backend retains data, or prove superiority for either project.
Inspected fixed revision: [`c897c4e8`, `_toolset.py`, user rendering and source loading](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).

## Command-boundary measurements

Run after `pnpm -r build`:

```sh
node research/conversation-evidence/manual-compaction-cli.mjs
node research/conversation-evidence/manual-compaction-cli.mjs --live
```

Each isolated workspace starts with a synthetic multi-turn history containing
a random receipt code in an original user message. A scripted provider sends
one response through the actual CLI Session, then the same Session method used
by `/compact` produces the real replacement. The normal conversation store saves
that result. The original code is verified absent from the replacement and
present verbatim in a manual archive event. No manual summary is substituted.

The seed process exits. A fresh `namzu run --resume` process must find and read
the original passage. Its prompt contains the receipt label but neither the code
nor an archive/run address. Automatic evidence recall and external web search
are off. Only conversation retrieval tools are allowed by the experiment's
post-run assertions; these are observed behavior checks, not a special sandbox.

| Recovery | Exact code | Search calls | Read calls | Recorded model tokens |
|---|---:|---:|---:|---:|
| Scripted provider, production CLI command | Yes | 1 | 1 | 0 |
| Codex / gpt-5.6-luna / low | Yes | 1 | 1 | 21,781 |

Both compacted ten supplied messages into seven, removing four originals and
adding one summary (net `shed: 3`). The default manual verifier made no model
call. Maintenance records therefore consumed zero model tokens. Live recovery
tokens were unpriced by this account; the reported zero priced cost does **not**
mean the experiment was free.

Evidence: [raw synthetic results](manual-compaction-results.json). Local roots:
`/tmp/namzu-manual-compaction-cli-wvnnKW` (scripted),
`/tmp/namzu-manual-compaction-cli-tK7JIV` (live). Built-file fingerprints were
unchanged during both experiments. A later source cleanup captured the same
session variable outside its callback to remove a new lint warning; it did not
change retention behavior and is covered by the final local checks.
The final scripted command at `/tmp/namzu-manual-compaction-cli-t3UDkq` also
passed with one search and one read against the rebuilt final files.

## Verification and limits

SDK regressions exercise whole-history and selected-region retention, await a
held write, verify exact removed-message selection and pinned-message exclusion,
and refuse publication on failure/cancellation. No-op calls invoke no archive.
CLI Session regressions cover exact original readback, cross-conversation refusal,
failed writes and messages above the archival record allowance. Mounted TUI
tests check that a retention failure displays the error, saves no replacement,
and carries the original user message into the next request.

Workspace tests passed, including **6,434 SDK** and **2,882 CLI** tests (five CLI
tests skipped by their existing conditions). All **258 SDK process tests** passed.
Typecheck, build, lint, docs validation/fences, signature-export and log/name
checks passed. Lint retains the pre-existing 35 SDK and 14 CLI warnings. The name
gate initially identified two existing branded citation labels; their links were
preserved and labels made descriptive. Release-only gates were not run; this
increment was not pushed or published.

The first post-fix assertion passed the search match's nonzero byte offset to a
read and incorrectly expected the entire message. It was corrected to read from
offset zero. The first scripted experiment also treated `runs/index.json` as a
directory; directory filtering fixed that harness failure before any live call.
Neither failure is presented as a successful test or a production defect.

This live experiment exercises the production CLI Session and resumed headless
command. The terminal layout is covered separately by mounted TUI tests; this is
not a visual inspection of a live `/compact` screen. One successful small-model
sample does not guarantee reliable retrieval or exact copying on every task.

Archive copies and conversation replacement are ordered, not atomic across
stores. A later replacement failure can leave extra archived copies. A serialized
message above 3 MiB is refused before replacement, keeping it below the SDK's
4 MiB per-record read limit. Search remains textual and scoped; binary content
is not reconstructed as text. Existing histories already compacted without an
archive are not repaired by this change. The SDK hook is optional for other hosts.
