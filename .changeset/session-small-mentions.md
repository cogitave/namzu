---
"@namzu/cli": minor
---

`@` file mentions in the composer now follow the reference terminal. A path with spaces or other characters outside the bare set is written `@"my docs/a b.ts"` (completion offers such files and writes the quotes), names in any script work, and `@file.ts#L10-20` sends only lines 10 to 20 (`#L7` sends one line). A closing `)` or `]` after a mention is no longer read as part of the name. Existing mentions keep working; the file size cap (60,000 characters) now applies to the lines sent.
