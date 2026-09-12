---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Preserve full permitted shell output before condensing similar lines. Previously,
condensation happened before retention, so omitted row values could be lost even
though conversation search reported the stored result as complete. Historical
search and reads can now recover those originals without repeating the command.

Compact output carries its recovery path. Authenticated retention may also write
an artifact for a condensed result below the normal size cap. If retention fails,
the ordinary bounded original is shown instead; hook-redacted text stays redacted.
