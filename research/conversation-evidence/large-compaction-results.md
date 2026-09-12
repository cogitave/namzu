# Retrieving original text from large compaction archives

Date: 2026-09-12. This is a storage and CLI continuity regression experiment,
not a general intelligence or memory-accuracy benchmark.

## Confirmed defect and change

Removed messages were serialized together in one `compaction_shed` JSONL line.
A large attachment, one long text, or many moderate messages could exceed the
SDK evidence reader's 4 MiB record limit. Original information could exist on
disk while conversation search could not reach it. The baseline tests for a
5 MiB attachment and long text both failed their completeness assertion:
`/tmp/namzu-large-compaction-baseline.log`.

The disk store now moves message arrays above 3 MiB into a generated archive
directory before appending a small, versioned reference. The original JSON
retains attachments and metadata. Independent text files reuse the existing
authenticated chunk manifests, search budgets and exact-read positions. Search
does not load the original binary-containing JSON. Full SDK event readers restore
the public `compaction_shed` event and verify the whole original file.

The live event contract stays the same. The raw disk encoding changes: consumers
that parse JSONL directly must understand `compaction_archive` or use SDK readers,
and must preserve `compaction-output/` when copying a run. The changeset declares
an SDK major for this storage contract. Existing oversized history is not migrated.

The earlier [primary-source comparison](manual-compaction-results.md#primary-source-comparison)
motivated testing original user text independently of tool output. This increment
addresses Namzu's measured record-size defect; it does not claim that another
framework implements this particular archive format.

## Actual automatic compaction and restart

After building the workspace:

```sh
node research/conversation-evidence/manual-compaction-cli.mjs --automatic
node research/conversation-evidence/manual-compaction-cli.mjs --automatic --live
```

The seed process supplies 38 messages to an actual CLI Session. One original user
message contains a synthetic 5 MiB base64 attachment and a random receipt code
beyond the summary's short excerpt. A scripted provider and a 20,000-token context
window trigger the production automatic compaction path. The experiment saves the
actual conversation projection returned by that Session; it does not substitute
a hand-written summary. The projection no longer contains the code or attachment.

A new production CLI `run --resume` process receives a question with the receipt
label, but without its value or archive address. The live recovery uses
Codex / gpt-5.6-luna / low, at most six iterations and 35,000 tokens. The synthetic
attachment never reaches that live model. Post-run assertions check that only
conversation search/read tools ran; these assertions are not a separate sandbox.

| Recovery | Exact receipt | Searches | Reads | Recorded model tokens |
|---|---:|---:|---:|---:|
| Scripted provider through production CLI | Yes | 1 | 1 | 0 |
| gpt-5.6-luna, low | Yes | 1 | 1 | 27,390 |

Both original message arrays occupied 5,319,887 bytes; each published reference
occupied 3,686 bytes and addressed 32 textual parts. The original attachment
was restored byte-for-byte through the SDK reader. The live search accounted
for 287,586 bytes and the exact read for 93,842 bytes. These are retrieval read
accounting figures, not total CLI startup, writer, checkpoint or model I/O.
The live search had a continuation for other history; finding the requested
original passage did not establish that all history had been scanned.

Tokens were unpriced by this account. A reported zero priced cost does not mean
the live experiment was free. This is one live sample, not a reliability rate.

Evidence: [synthetic results, built-file fingerprints and archive audit](large-compaction-results.json).
The scripted root is `/tmp/namzu-manual-compaction-cli-i0MNOY`; the live root is
`/tmp/namzu-manual-compaction-cli-K00Twh`. Files were unchanged within each measured
run. Small source validation cleanups occurred between those runs, so their
fingerprints are recorded separately.

## Validation honesty and limits

The initial new process test incorrectly looked for an `images` field instead
of the canonical `attachments` field. That run had 258 passing tests and one
failing new assertion. The same mistaken property made the experiment's
attachment-absence assertion ineffective. Both assertions were corrected.
A separate post-run audit of both measured runs verified the saved projection
through the CLI conversation store and restored the original attachment through
the SDK reader. The original measurements are preserved; the additional audit is
recorded separately. No paid model call was repeated merely to fix these assertions.

The corrected process suite passed **259 tests**. Full workspace tests passed,
including **6,443 SDK** and **2,882 CLI** tests (five existing CLI skips).
After the final assertion corrections and one added legacy-reader refusal test,
the affected SDK and CLI suites passed again: **27 SDK** and **70 CLI** tests.
Typecheck, build, lint, docs validation/fences, signature-export and log/name
checks passed. Lint retains the existing 37 SDK and 14 CLI warnings. Release-only
gates were not run; this increment was not pushed or published.

Final scripted runs also passed with the corrected attachment assertions:
automatic compaction at `/tmp/namzu-manual-compaction-cli-NXjVhn`, and large
manual compaction (`--large`) at `/tmp/namzu-manual-compaction-cli-dr9asa`.
Each used one search and one read after process restart and zero model tokens.

Regressions cover single long text, large attachments, 80-message compaction,
live and closed search, process restart, preserved sequence/schema/generation,
exact original readback and foreign-session refusal. Changed/missing text,
changed manifests, invalid generated references and directory symlinks refuse
access. Damage to the whole original JSON refuses full event restoration while
an independently authenticated text copy remains readable. A refused archive
write does not publish its reference or authorize conversation replacement.

The SDK's 4 MiB record and 8 MiB retrieval-operation limits remain. Archives
have explicit textual-part and manifest limits. Whole-event restoration and
archive creation can load large message bodies; this is not a bounded-memory
writer or a claim about constant-time startup. Saving files and appending a
reference are ordered, not one cross-file transaction. A failed append may leave
unreferenced files; automatic archive garbage collection is not included.

This exercises the real CLI Session and resumed command. Mounted TUI regressions
cover the manual compaction path; the live experiment does not visually inspect
a terminal screen. There is no workspace-action replay and no claim that binary
content itself becomes text-searchable.
