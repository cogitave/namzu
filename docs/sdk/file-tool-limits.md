---
type: Reference
title: File tools - reads, edits and searches
description: The size and token caps on read, the read-before-edit rule, the grep output modes and paging, and the combined result budget for one assistant message.
resource: packages/sdk/src/tools/builtins/read-file.ts
tags: [sdk, tools, read, edit, grep, budget]
status: stable
generated: { by: process:claude-code, at: 2026-10-23T00:00:00Z }
---

# File tools: reads, edits and searches

These are the limits the built-in `read`, `edit`, `write` and `grep` tools apply, and the budget the
runtime applies to the results of one assistant message. Each section names where this kernel differs.

## read

| Rule | Value |
| --- | --- |
| Lines returned with no window | 2000 |
| Largest file returned when no window is named | 262,144 bytes (256 KiB) |
| Largest result | 25,000 estimated tokens |
| A window's text, in bytes | at most 25,000 x 128 |
| Token estimate | characters / 4; characters / 2 for `.json`, `.jsonl`, `.jsonc` |

A window is `readRange` or `limit`. A caller that names one has chosen its size, so the 256 KiB rule
does not apply; the token rule does.

- A file over 256 KiB with no window is refused before it is loaded. The error says to use `offset` and
  `limit`, or to search, and names `allow_large`.
- A result over 25,000 tokens, on the first page of an unwindowed read, is cut to the leading lines that fit.
  The page ends with `[Truncated: PARTIAL view ...]` naming how many lines were shown and the exact next
  call (`offset=N limit=N`, 0-indexed like this tool's `offset`). A file whose lines are too long to page
  gets a character excerpt and says it cannot be paged by line.
- Any other read over 25,000 tokens (a window, or an `offset` past the start) is refused with the count.
- `allow_large: true` lifts both caps for that one call to four times their size. The kernel does not track the room left in the context, so the factor is
  fixed. A read still over the lifted caps is refused and says so.
- `NAMZU_FILE_READ_MAX_OUTPUT_TOKENS` in the turn environment replaces the 25,000.
- A window that opens after the last line is a successful result that says so: `Warning: the file is
  shorter than the requested start (line 5001). It has 1502 lines.` It is not a partial view, and the
  session's read ledger does not take it for the file. An empty file answers `Warning: the file exists but
  is empty.`
- A file's line count is one number everywhere: a final newline ends a line and does not start another, so the
  header data, the `of N` in the partial-view note and the past-end warning agree, and no empty numbered row
  follows the last line.
- A file whose bytes are not text (a NUL, or a share of control or replacement characters) is not numbered.
  The result is a short note with the size that names `file` or `xxd` as the next step; it reports as a
  failed read, like the Office and image notes.

A repeat read of lines the model already has, in a file that has not changed, is answered with one sentence (`Unchanged since your earlier read of the same lines. That result is still current; use it instead of reading again.`) and `facts.unchanged: true`, the row reading `Read name · unchanged`. It applies only to the same window (`readRange`, or `offset` and `limit`), and only while three things hold: the whole file fingerprints the same as at that read, the host passed `ToolContext.receiptVisible` (`query()` always does, and there is no switch to turn the answer off under it; a host that calls the tool outside `query()` passes none and gets the lines), and that function says the earlier receipt is still, byte for byte, in the conversation. A receipt cleared, summarised away or annotated by a hook is no answer, so the lines are returned again. The read ledger is not touched by the answer, and a host that cannot say what is shown never gets one. A custom `FileReadTracker` takes part through the optional `recordReadWindow` and `readWindow`.

`read` declares `selfLimitingOutput: true` ([ToolDefinition](tool-execution.md)): the turn's default per-result
cap (40,000 characters) and the per-message budget below leave its result alone, because these caps are its
bound. A host that sets `maxToolOutputChars` explicitly still bounds it.

## edit and write

`edit` refuses a file the session has not read: `<path> has not been read yet. Read it first, then redo the
edit. Nothing was written.` `write` already refused an existing file it had not read. Both consult the
turn's `fileReadTracker`; a host that supplies none is not refused, because it has nothing to ask. A windowed
read counts as a read here (the ledger records the whole body); an edit after a partial view is not refused.

A file that changed since the read is compared by content fingerprint, not by modification time, so a touch
that leaves the bytes alone is not drift. When the content did change, `edit` and `write` are both refused:
`<path> changed on disk after you read it, so this edit was based on a stale copy and was not applied. Read the
file again and redo the edit against its current contents. Nothing was written.` An `edit` is not applied even
when its `old_string` still matches uniquely, because the match can land somewhere the model never meant: the
model read `a = 1`, the file now says `a = 100`, and replacing `a = 1` with `a = 2` would write `a = 200`. The
ledger keeps a fingerprint of what was read, not the text, so there is nothing to show where the text belongs.

The same refusal is also given before anyone is asked. `edit` and `write` declare `ToolDefinition.refuseBeforeReview`,
which the executor asks while it prepares a batch, once the arguments are valid and before the call is put to a
reviewer. A call on a file that changed since the read therefore reaches no approval box and runs nothing; the model
gets the same text with the failure kind `changed_on_disk`. A path that is missing, outside the roots or never read
is left to the tool, and `execute` repeats the check, because the file can move again between the question and the run.

`edit` matches `old_string` exactly, but recovers a few differences that are not the model being wrong about
the text, only about one interchangeable detail — the cases below, tried in this
order: a straight quote against the file's curly one (`' ' " "`) or the reverse, and a `\uXXXX` escape where
the file holds the character, or a character where the file holds the escape. The span it finds is a real
substring of the file, so the uniqueness rule still applies to it, and the same change is carried onto
`new_string` so the replacement matches the span it lands in. A whitespace or indentation difference is **not**
recovered, so the error still tells the model to match whitespace and
indentation exactly. This kernel additionally reconciles CRLF against LF when the file's line endings are
consistent. A deletion (`new_string` empty) takes the matched line's trailing
newline with it, so removing a whole line leaves no blank one behind.

## grep

`output_mode` is `files_with_matches` (default), `content` or `count`.

| Mode | Returns |
| --- | --- |
| `files_with_matches` | `Found N files`, then the paths, newest modification time first, ties by path |
| `content` | `path:line:text` (`path-line-text` for context lines, `--` between groups) |
| `count` | `path:N` per file, then the total across files |

`head_limit` (default 250, `0` for none) bounds the entries, which are paths, output lines or count rows
depending on the mode. `offset` skips entries first, to page. A page that cut results off reports
`limit: N` and `offset: N`. In `content` mode the search stops when the page is full and says more may
follow, rather than reading another file to prove it. A matching or context line over 500 characters is
printed as `[Omitted long matching line]` or `[Omitted long context line]`. `max_results` is deprecated and
means `head_limit` when that is absent.

This is the kernel's own walker, not ripgrep: files over 5 MB, binaries and symlinks are skipped, and at most
20,000 entries are examined (the search reports itself incomplete past that). A sandbox reports no
modification times, so its file list is in path order.

## The combined result budget

`maxToolOutputCharsPerMessage` (`QueryParams`, `QueryAgentConfig`; default 200,000 characters, `0` disables)
bounds the text of all results from one assistant message together. Each result is already bounded by
`maxToolOutputChars` (40,000), so this matters for a wide parallel batch: eight 40,000-character results are
320,000.

When a batch is over, the largest results are replaced, largest first and earlier call first among equals,
until it fits. A replacement is the first 2,000 characters and the path where the full text is kept (spilled
now, or the path it already had). Results that are not text alone (rich content, structured output) and tools
with `selfLimitingOutput` are not replaced and not counted.

A replacement and a spilled result carry the saved-file line and one sentence on how to read more, which names only
the tools the turn has: `read` when it is mounted (it opens the file in the session's own retained-output directory
without a prompt, as a regular `.txt` file that is not a link, in the usual line windows), and the conversation tools
when both are mounted. `ToolContext.retainedOutputDirectory` carries that directory; `read` refuses anything else
outside its roots as before.

The replacement is written into the result when the batch settles, before the result becomes a history
message, so it is what every later request carries. Nothing is decided again on a later turn, so a
prompt-cache prefix over it stays valid. The `tool_completed` event keeps the result as the tool returned it.
