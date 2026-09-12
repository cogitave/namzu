# Automatic recall within a running CLI invocation

Measured 2026-09-12 on Linux/WSL. The real CLI Session test now recovers original
retained text **after actual compaction within the same invocation**, without
an explicit archive tool call. A separate live CLI trial using Luna/low also
recovered both original identifiers from automatic context. That short live
trial did **not** trigger compaction; these are distinct pieces of evidence.

## The gap and implementation

The [previous automatic recall step](automatic-results.md) excluded the
requesting invocation. Explicit evidence tools already had a safe live writer,
but host preparation could not use it. An old observation could therefore be
available in the durable current-run archive without reaching automatic context.

`PrepareStepContext.captureRunEvidence(maxReadBytes?, signal?)` now shares the
tool capability's invocation-bound, append-serialized capture. It rejects
cancelled/settled invocations and accepts an earlier local deadline. The recall
helper forwards that capability with its deadline and revokes new captures when
the pass ends. It makes no model call and does not replay an action.

The CLI visits up to two live pages, then earlier invocations within the same
four-page and 8 MiB accounted-read ceiling. Live pages verify both the source
owner and returned scope. The current invocation is excluded from disk discovery
so an unavailable live source cannot silently switch to the legacy path. The
bounded candidate pool still supplies at most four passages and 6,000 characters
of request-only context. Explicit tools remain for later pages and full text.

## Deterministic execution evidence

The real Session regression runs the production CLI adapter, kernel, retained
output writer and compaction. It reads a synthetic file once, replaces that file
externally, performs several intervening calls, and triggers structured
compaction with controlled provider usage. Assertions verify that compaction
actually shed the original tool message; the original identifiers are absent
from ordinary messages and present in runtime step context afterward.

Both automatic and explicit-tool paths are exercised. Automatic mode makes
zero `search_conversation` or `read_conversation` calls and one original `read`.
The changed workspace file remains unchanged. This is a scripted-provider
execution test, not a claim that a live model followed a long plan unaided.

SDK tests separately cover capture through both tool and preparation entry
points, cancellation while capture is pending, rejection after the run ends,
local cancellation without cancelling the run, and rejection of new captures
after recall has finished. Earlier tests retain archive tamper, foreign scope,
ownership changes, bounded output, restart and exact text coverage.

## Live CLI experiment

The [CLI harness](active-cli.mjs) now has `--automatic` mode. It asks naturally:

> manifest.txt dosyasının tamamını incele. Ardından DELTA kaydının takip kodunu ve hedef deposunu aynen bildir.

The prompt names no tool, archive or recovery strategy. The harness observes
provider requests and replaces the synthetic file after the original read.
It forwards live model requests and responses without scripting decisions.
The two UUID-bearing values lie outside the 4,000-character visible preview.
Web and project-memory recall are off; conversation recall is on. The run uses
`codex/gpt-5.6-luna`, effort `low`, six iterations, a 35,000-token admission
limit and a 180-second process timeout. Admission is not a hard billing ceiling.

```sh
node research/conversation-evidence/active-cli.mjs --live --automatic
```

This incurs model usage through locally available Codex credentials. Omitting
`--live` uses the separate scripted control.

The [raw records](current-automatic-results.json) preserve every trial:

| Trial | Calls | Exact originals | Harness verdict | Reported tokens |
| --- | --- | --- | --- | ---: |
| Scripted control | read | Both | Passed, scripted | 0 |
| Initial natural trial | glob → read → grep | Both | Failed: obsolete guided-mode allowlist rejected permitted read-only exploration | 30,666 |
| Trial overlapping build | glob → read | Both | Passed, excluded from final-source validation | 21,960 |
| Final trial with stable built modules | glob → read | Both | Passed | 21,977 |

The first trial's failure is retained. Automatic mode now permits the read-only
exploration allowed by its prompt; guided mode retains its stricter tool list.
The second trial overlapped typecheck during startup, so it cannot establish
which version of the newly added guard code loaded. The harness now hashes
relevant built modules before and after the CLI process and fails on changes.
The final trial passed that stability check and ended with `end_turn`.

In the final trial, the third request contained both originals only in a
1,927-character runtime context block; ordinary messages still contained neither.
System text stayed unchanged across the three requests. The model returned
both original identifiers, used no explicit archive tools and did not re-read
the file. The external replacement remained in place. No tool failed. This is
one eligible final-source trial, not a general success rate or cost benchmark.
The initial trial's extra grep shows that automatic attachment does not always
eliminate unnecessary workspace search.

## Validation

Workspace typecheck, build, lint and tests passed, including 6,321 SDK tests
and 2,837 CLI tests (five existing CLI skips). After adding three additional
live source/page/budget refusal cases, the affected 23-test CLI suite and
workspace typecheck also passed. All 256 SDK process tests passed. Docs gates
checked 69 pages and compiled 47 TypeScript fences plus 20 package READMEs.
Exported-signature and SDK test-presence gates passed. Existing lint warnings
remain: 35 SDK and 14 CLI. Release coverage and consumer-install gates were
not rerun; no push or publication is claimed.

## Remaining limits

The option remains off by default. Two live pages do not exhaust a long run:
each source operation has bounded record/part/chunk traversal. An older relevant
passage can still lie beyond the frontier. Earlier closed-run discovery also
remains bounded and is not globally ranked or chronological. The lexical method
does not guarantee paraphrase recall or correct source selection in every task.
No new TUI visual behavior or general autonomous-kernel completion is claimed.
