---
"@namzu/cli": minor
---

New built-in skill `pdf`: read, extract tables and images from, merge, split or make PDF files with the tools found on the machine, and rotate, watermark, fill, encrypt or OCR only where the tool for it exists. It checks what is installed first, never installs anything, and reads each result back before saying it worked. The `document` skill now sends PDF requests to it and no longer says a PDF cannot be made; Word, slide and spreadsheet files are still not made.

The model now sees seven built-in skill descriptions instead of six, about 400 characters more in the skill list. On a context window under about 37,800 tokens the last descriptions are named without text; they stay loadable. A skill of your own named `pdf` still takes precedence.
