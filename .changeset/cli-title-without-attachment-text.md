---
"@namzu/cli": patch
---

A conversation's title no longer includes the text of an attached file. Desktop sends an
attachment to the model as `Attached text file: "name"` after the typed words; the saved
title now comes from the typed words only, and is the first file's name when only files
were sent. A title that was already saved with attachment text keeps it until the conversation is
renamed.
