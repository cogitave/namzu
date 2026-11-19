---
"@namzu/desktop": patch
---

Send now on a waiting message no longer stops the reply that is running: the message, and any held ahead of it, goes into the reply at its next step. Send now on a message already in the reply does nothing. Where a reply cannot take a message in (a Pal, or a message with files) it still stops the reply and runs the message. Nothing to change on your side.
