---
'@namzu/sdk': patch
---

The session index (`index.sqlite`) is now readable by its owner only. It holds
the opening of every prompt and the full text of tool results and replies, and
it used to take the umask's mode (0644 on most systems), so other users of the
machine could read it while the session logs themselves were 0600. A new index
is created 0600 in a folder created 0700; opening an existing index narrows it,
and any journal file beside it, to 0600 when you own it. Session folders and
`lease.<fence>.json` files are created owner-only too. Nothing to do: the next
open fixes an existing index, and no data changes.
