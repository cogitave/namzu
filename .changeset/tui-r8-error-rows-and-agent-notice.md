---
'@namzu/cli': minor
---

A failed tool call now shows what the tool said. Under the call you see `Error: <text>` in the error colour (first 10 lines, then `… +N lines (ctrl+o to expand)`) instead of a muted `failed: <text>`; a schema error reads `Invalid tool parameters` until expanded. A failure Namzu can name stays one short sentence, now in red, with the tool's own message behind Ctrl+O, and an edit or write on a file that was never read says `Read <file> first, then try again.` in the dim colour. A background agent that fails leaves `Agent "<name>" failed: <plain reason>` with no duration; the provider's JSON and request ids are cleaned off, Ctrl+O shows the original text, and only the dot carries the red. Nothing to configure; scripts that read these rows from a terminal capture will see the new wording.
