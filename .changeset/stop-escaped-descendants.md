---
'@namzu/sdk': minor
---

On Linux, cancelling or timing out a command, and stopping a background job, now also stops descendants that left its process group with `setsid` or a double fork. This includes a server a command deliberately started with `setsid` or `nohup`: before, it survived the cancel, and now it is stopped with the command. A command that must outlive its cancel has to be started outside the host's shell tool. Every command the host starts now has a `NAMZU_SHELL_TAG` variable in its environment, which a command can see; the sweep finds descendants by it. A descendant that clears its environment still escapes, and systems without `/proc` signal the process group only.
