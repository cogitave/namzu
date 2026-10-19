---
"@namzu/cli": patch
---

The terminal now says "A picture in this conversation couldn’t be processed, so Namzu left it out of what it sends" when a provider rejected a file and the reply went through without it, and that the file stays in the conversation. It says "the picture you just attached" when the file was attached to the latest message, and a separate line when only the oldest files were left out to fit a count. Nothing to change.
