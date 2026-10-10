---
"@namzu/cli": patch
---

The terminal app words three more things plainly. A `namzu.config.json` that is not valid JSON now reads "namzu.config.json isn't valid JSON (line 3, column 5). Fix it, then start Namzu again." with the line and column of the mistake; the parser's own wording is shown only with `--debug`. A read, search, write or edit step is headlined from the kernel's typed facts ("Read a.ts", "Searched for x · 2 matches in 2 files", "Edited a.ts +2 −1", "Created n.txt +2") instead of the model's receipt with a full path; conversations saved before those facts existed keep their old text. A provider picker shows its setup key once, in its bottom key line, instead of in a line of its own.

If you match the old text of the config error (`<path> is not valid JSON: <parser text>`), match the file name and "isn't valid JSON" instead. `ConfigLoadError.message` for invalid JSON carries the new sentence and the parser's text is on `cause`.
