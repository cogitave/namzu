---
'@namzu/cli': minor
---

Open bare `/export` as a destination chooser for a verified Markdown transcript.
Clipboard export sends the complete durable projection through a bounded OSC 52
request, while file export opens a session-prefilled filename editor and keeps
the existing no-overwrite guarantee. `/export <path>` remains available.
