---
"@namzu/cli": minor
---

The terminal draws research turns the way the reference terminal does.

- **Web searches and fetches** are one row naming the query or address, `✓ Web search("…")` / `✓ Web fetch(https://…)`, with a `⎿` line that reads `Searching: …` while the call runs and settles to `Found 3 results in 4.1s`, `Did 1 search in 9.0s` or `Received 7.5KB in 1.2s`. Consecutive calls sit together without blank lines, and a long query is cut at the terminal's width with an ellipsis. A fetched page or result list stays behind Ctrl+O. They used to read `✓ Web search · 9.0s` with no query and a blank line between every row.
- **Markdown tables** are drawn as a box (`┌┬┐ ├┼┤ └┴┘`) sized to the terminal, with long cells wrapped inside their column and `**bold**`, `` `code` `` and links drawn rather than shown as source. Where the columns cannot fit, the table becomes `Header: value` records separated by a `─` rule. A table streaming in no longer flashes raw `| a | b |` rows. Tables used to be a header, one rule and cells cut mid-word at 32 characters.
- **The Working row** counts the turn's output, `Working (46s · ↓ 1.1k tokens · esc to interrupt)`.
- **A finished turn** that took three seconds or more closes with `✻ Worked for 46s`, as a turn that delegated work already did.
- **Wrapped text** in replies, your own messages and notices no longer starts a row with the space it wrapped at, so every row of a paragraph starts in the same column.

Nothing to change on your side.
