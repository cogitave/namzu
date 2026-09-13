# Rich tool text after compaction and restart

Date: 2026-09-13. Baseline: `28d38749`. Machine-local experiment, not a general
model benchmark. Measurements and module fingerprints are in
[rich-compaction-results.json](rich-compaction-results.json); the repeatable
driver is [rich-compaction-cli.mjs](rich-compaction-cli.mjs).

## Source finding

The SDK previously extracted only string-valued `message.content` from a
`compaction_shed` event, both in `eventTexts` and `retainCompactionRecord`.
`ToolMessage.content` also accepts interleaved text/image/document blocks.
Their original bytes were preserved, but their text blocks were not present
in the searchable part list. This is specifically a compaction-evidence gap;
an independently recorded `tool_completed.result` could still contain text.

The primary comparison was the local Pydantic AI Harness checkout at
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`:
[`_user_prompt_text` and `_format_request_part`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py#L160).
Its user-part extraction deliberately excludes binary representations from
search and joins textual segments. Its tool-return branch instead stringifies
the content. These are different paths; this comparison does not claim that
all of its rich tool results have Namzu's shape or retention behavior.

Namzu now uses one internal extractor for inline indexing and new archive
creation. It indexes each tool text block as an exact part, preserving block
boundaries instead of inserting separators. Binary bytes remain outside text
search. Existing plain-string part ordinals remain a prefix; new block parts
follow it in message/block order. This prevents durable plain-part addresses
from silently changing meaning.

## Experiment

Each run creates an isolated Namzu home and workspace and a fresh conversation.
It calls the same `retainManualCompaction` function that `/compact` uses,
archiving a synthetic tool message with two text blocks around a 4 MiB image
payload. The full message array is 4,194,933 serialized UTF-8 bytes and takes
the large-archive path. A fresh random receipt code exists only in the second
tool text block. The session's projected history is replaced with a short
statement that earlier observations are archived.

A separate process runs the actual built CLI with `run --resume`, automatic
evidence recall enabled, `codex/gpt-5.6-luna`, `low`, at most four iterations,
25,000 tokens and a 90-second process timeout. It asks:

> What was the original ORCHID receipt code?

The preload observes the actual initial runtime evidence context. Scripted
runs replace only inference; the live run forwards the provider stream
unchanged. The code is absent from ordinary history, and no binary payload is
sent to inference. The observer asserts zero executed tools, unchanged source
transcript, unchanged relevant built modules and the exact random code in the
answer when retrieval is expected to work.

| Run | Receipt in first evidence context | Answer | Model requests | Tools executed | Model tokens |
| --- | --- | --- | --- | --- | --- |
| Baseline, scripted | No | No observation selected | 1 | 0 | 0 |
| Fixed, scripted | Yes | Original text | 1 | 0 | 0 |
| Fixed, live Luna low | Yes | Correct random receipt code | 1 | 0 | 7,285 |

Local artifacts: baseline `/tmp/namzu-rich-compaction-cli-7EV3a0`, fixed
scripted `/tmp/namzu-rich-compaction-cli-IAOjZk`, fixed live
`/tmp/namzu-rich-compaction-cli-wIHfYw`. The live budget ended at 17,715 tokens
with no reservations, in-flight requests or unsettled children. Subscription
usage is unpriced in this report; a zero recorded dollar cost does not mean
free inference.

This proves the built CLI's archive/reopen/recall path on this fixture, not a
manual interactive `/compact` keystroke test, image interpretation, general
memory quality, or retrieval from every older archive. Synthetic image bytes
exercise storage and are never decoded. Automatic recall is still opt-in.
Older archive part lists are not rewritten; old live skip links may omit
rich-only inline records until a fresh scoped disk scan is used.

## Regression coverage

SDK tests cover inline and external archives in live, closed and snapshot
retrieval; existing plain-part addresses; exact Unicode/CRLF and empty blocks;
binary/name exclusion; shared tool provenance and source exclusion; whole
message restoration; tampered text refusal; cancellation; malformed blocks;
and rich-only records with more than one index page. CLI tests cover manual
retention, replaced projected history, cleared retrieval caches and reopened
sessions, exact reads and foreign-session refusal. The legacy scanner now
reports skipped block arrays as incomplete.

The first broader SDK run exposed an unintended refusal of non-tool array
content; the extractor was narrowed to tool blocks, preserving the existing
nontext handling. One early full CLI run hit the goal-view wait deadline while
other build/test work overlapped. Final validation is recorded below rather
than counting that failed run as a pass.

Final validation: `pnpm typecheck`, `pnpm -r build`, `pnpm lint`,
`pnpm -r test` (SDK **6,536**, CLI **2,915 passed / 5 skipped**, plus the other
workspace packages), and SDK process tests (**264**) passed. The earlier
goal-view test passed in that final full workspace run without a code change
to it; the earlier failure remains recorded above. The OKF check and docs
fences passed (47 documentation fences and 20 package READMEs).
