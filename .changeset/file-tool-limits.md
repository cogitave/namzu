---
'@namzu/sdk': major
---

The file tools follow the reference terminal's rules, and four defaults change.

**What breaks, and what to do:**

- `edit` now refuses a file the session has not read (`<path> has not been read yet`). A host or test that edits without reading first gets a failed result and nothing is written. Read the file with `read` first. There is no opt-out. A host that supplies no `fileReadTracker` on the tool context is not affected, because there is nothing to ask. `write` already refused an unread existing file.
- `edit` no longer refuses every file that changed since the read. When the content changed, an edit made only of text replacements is applied if `old_string` still matches the current content uniquely (or, with `replace_all`, still matches); only then is it refused as stale. An insertion by line number is still refused after any change. Code that relied on a still-matching edit being refused after an unrelated change must now check the file itself.
- `grep` defaults to `output_mode: "files_with_matches"`: a list of paths, newest first, not matching lines. Pass `output_mode: "content"` to get the old lines back. `max_results` (was 100 matching lines) is deprecated in favour of `head_limit`, whose default is 250 entries and which counts output lines in `content` mode; `max_results` still sets it when `head_limit` is absent. `grep` also gains `count` mode, `offset`, and replaces a line over 500 characters with a notice.
- `read` refuses a file over 256 KiB when no `readRange` or `limit` is given, and cuts a result over about 25,000 tokens to a first page (or refuses, for a windowed read), where it used to return up to 2000 lines of any size. Read part of the file, or pass `allow_large: true` (four times the caps) for one call. `NAMZU_FILE_READ_MAX_OUTPUT_TOKENS` in the turn environment changes the token cap. `read` is exempt from the default 40,000-character per-result cap, because these caps bound it; a host that sets `maxToolOutputChars` explicitly still bounds it.
- The combined text of one assistant message's tool results is capped at 200,000 characters (`maxToolOutputCharsPerMessage` on `QueryParams` and `QueryAgentConfig`). Past it, the largest results are replaced, largest first, by a 2,000-character preview that names where the full text was kept. Set `maxToolOutputCharsPerMessage: 0` to keep the old behaviour of no combined bound.

New, not breaking: `ToolDefinition.selfLimitingOutput` and the matching `defineTool` option mark a tool that bounds its own output.
