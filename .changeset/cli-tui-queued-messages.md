---
'@namzu/cli': minor
---

Messages sent while a reply runs now behave as they do in the other terminal agents. Enter queues the message (the reply still reads it at its next model boundary), the waiting rows end with `⎿  Queued · ctrl+x ctrl+s to send now`, and Up on an empty box takes every waiting message back into the box, one per line in the order sent, instead of choosing one row. Esc on an empty box with messages waiting now takes them back and no longer stops the reply; press Esc again to stop it. If you relied on Esc to stop a reply and run a waiting message, use ctrl+x ctrl+s. ctrl+x ctrl+s with text in the box sends that text now. The footer reads `enter queue · tab after reply · esc interrupt`.
