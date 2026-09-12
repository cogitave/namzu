# From a search match to exact original text

Date: 2026-09-13. This is a CLI retrieval regression, not a general memory score.

## Defect and verified baseline

The [previous dense-history experiment](record-reuse-results.md) found an original
receipt after compaction, but `read_conversation` located the record again from
the first index page. Its first response contained no text and required a read
continuation. The live model answered from the search excerpt without following
that continuation. The final value was right; the requested exact read was not
completed. The earlier experiment's weak verifier is documented there.

On baseline `fe6e0fb6`, the real CLI Session regression likewise failed its new
four-turn bound: two searches and the first read did not deliver the original.
Log: `/tmp/namzu-read-location-baseline.log`, 24 passed and one failed. This was
not a provider-authentication failure or a timeout.

## Change and boundaries

The CLI now retains the SDK's authenticated address when a scoped indexed or
live search returns a match. A following read with the same conversation,
invocation, sequence and textual part can resolve that address directly. It
still opens the source under the current host scope and runs SDK ownership,
record-digest and text-integrity checks. It does not retain returned text,
file handles or authorization decisions, and does not accept caller-chosen paths.

The cache holds at most 128 locations for ten minutes. Expired and evicted
locations use ordinary bounded index lookup. Process restart starts with no
locations. A fresh read after a live owner is gone can locate the closed run;
an existing live read cursor keeps its original owner requirement. Closing the
host releases locations and both search and read cursors. The latter also fixes
the old cleanup condition, which matched the search scope but not the read scope.

This uses the SDK address rather than weakening its checks or raising read
budgets. Raw tool schemas, output limits and default settings are unchanged.
When a closed source changes after search, reading the saved address refuses it;
a fresh search can explicitly establish a new address. Missing locations can
still produce bounded empty lookup pages, and long text can require several
read pages. This change does not promise every read finishes in one call.

## Real CLI execution

After building the workspace:

```sh
node research/conversation-evidence/manual-compaction-cli.mjs --dense
node research/conversation-evidence/manual-compaction-cli.mjs --dense --live
```

A seed process uses the actual CLI Session's manual compaction method on a
history with 127 ordinary messages before the original receipt message, followed
by later conversation. It stores the actual replacement and verifies the receipt
is absent from that projection and retained in the archive. A fresh production
CLI `run --resume` process receives the receipt label without its value or address.

| Recovery | Search calls | Read calls | Original passage returned | Model tokens |
|---|---:|---:|---|---:|
| Scripted provider through CLI command | 2 | 1 | Yes | 0 |
| Codex / gpt-5.6-luna / low | 2 | 1 | Yes | 33,145 |

The live run was bounded to six iterations and 45,000 tokens. Its read returned
`source: compaction_shed:user`, the seed archive's run ID, `retainedPreview: false`,
the exact receipt passage and `complete: true`. It accounted for **1,040,656 bytes**.
The request began at the returned byte offset, so this proves that original
passage, not that the whole conversation or the earlier part of the message was
returned. No workspace command, file observation or external action was replayed.

The live baseline also used two searches and one read, but its read was empty.
Do not infer token savings from that incomplete baseline. The scripted Session
regression needed five model turns before the change and four after it because
it correctly followed the original empty read continuation. Recorded live tokens
are unpriced by this account; zero priced cost does not imply free usage.

[Raw synthetic results and built-file fingerprints](read-location-results.json)
come from `/tmp/namzu-manual-compaction-cli-LQIB3Y` (scripted) and
`/tmp/namzu-manual-compaction-cli-4xfsb4` (live). Fingerprints were unchanged during
each run. The verifier requires the code in an exact read result, not just a
correct final answer or a read-tool call. A subsequent source audit additionally
confirmed the seed archive and original-user source, and that condition is now
explicit in the verifier to reject reading back a search-result echo.
A final scripted replay at `/tmp/namzu-manual-compaction-cli-4HYQVH` passed that
stricter source check with two searches and one read.

## Verification

Nine focused boundary tests cover late live/closed matches, changed records,
foreign conversations and changed ownership, long-read continuation, release,
expiry, bounded eviction, live-to-closed handover and later writer appends.
Cancellation is checked before retrieval and while awaiting conversation scope.
The existing real CLI Session regression covers the ordinary model/tool loop;
other Session tests exercise altered retained files and cross-session refusal.

Full workspace tests passed, including **6,447 SDK** and **2,893 CLI** tests
(five existing CLI skips). The final cancellation assertions were also rerun in
the focused suite. Typecheck, build, lint, docs validation/fences, signature
exports and log/name checks passed. Lint retains 37 SDK and 14 CLI warnings.
The first typecheck caught missing required fields in a new synthetic event;
the fixture was corrected before the successful build and CLI experiments.

No SDK production code changed in this increment. SDK process tests were last
run in the preceding increment (259 passed), not rerun here. These command runs
exercise the production CLI and process restart; they do not visually inspect
terminal layout. One live recovery is not a reliability estimate. Release-only
gates were not run, and this work was not pushed or published.
