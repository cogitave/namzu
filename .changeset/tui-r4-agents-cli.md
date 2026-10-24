---
'@namzu/cli': patch
---

Stopping background agents now leaves one row. Ctrl+C on an idle composer and `ctrl+x ctrl+k` write `All background agents stopped` and nothing else: the stopped agents no longer add a `was stopped by user` row each, and no `Worked for` line lands between them. Anything that matched those per-agent rows after a stop must expect one row.

Other visible changes:
- The `Waiting for N background agents to finish` line has a blank row above it.
- Every row of the agents rail shows the type column. Before, it was left out when all rows had the same type, so a lone failed agent looked different from its running neighbours.
- A turn's closing line now reads `Worked for 46s · done 3:45 PM`, with the clock time in your locale right after the duration. Text that matched `Worked for 46s` exactly must allow the suffix.
- A background agent that asks for approval after its turn has ended (to write a file, for example) now reaches you. Before, the request was refused with `Turn is no longer active.` and the agent carried on without the file.
- A foreground agent whose wait you released by typing keeps running after the turn, like a background agent; this is now covered by a test.
