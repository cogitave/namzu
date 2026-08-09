---
'@namzu/cli': patch
---

Parse a streaming reply one block at a time instead of re-parsing the whole
message on every token.

The pending transcript row re-renders per token, and each render re-parsed the
entire message: a forty-block answer was parsed forty blocks deep on every
token, so the cost of streaming a reply grew with the square of its length. Long
replies now stream at a cost that tracks their length rather than its square.

Nothing changes for a caller. `@namzu/cli` exports no markdown API; the new
`scanBlocks` and `parseBlock` are internal to the terminal UI, and
`parseMarkdown` is now the composition of the two with identical output.
