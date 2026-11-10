---
'@namzu/cli': patch
---

`namzu acp --desktop` now tells the Desktop how full each conversation is and when it is being compacted, through a new `namzu/session/usage` notification (context size, window, cost when priced, compaction start and finish). Other clients and the shared protocol mapping are unchanged, and a client that does not know the notification ignores it. Nothing to change on your side.
