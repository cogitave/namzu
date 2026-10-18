---
"@namzu/cli": patch
---

Typing a new message after a reply paused on a provider failure (a rate limit, an outage, a rejected key) now works, as the "Paused: … or type a new message" notice says. Before, the message was refused with "This conversation already has a paused turn ()" and never reached the model, whether or not you had changed the model, so you had to run `/resume` or `/abandon` and type it again. Now the paused reply is closed, the new message runs on the model selected at that moment, and no error line appears. A pause that waits for you (an approval or a handoff) still holds the conversation; the refusal is now one plain sentence without a turn id. Nothing needs changing in your setup.
