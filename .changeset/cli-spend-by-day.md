---
'@namzu/cli': minor
---

New: `namzu cost [--days <n>] [--json]` and `/cost days [n]` in the terminal show what your conversations cost over the last `n` local days (30 by default), by day, model, project and kind of work (your replies, sub-agents, compaction, other internal calls), with cache reads and writes apart from fresh input. It reads the session logs you already have; nothing new is recorded and nothing leaves the machine. Money is an estimate from list prices, and a model with no known price shows its tokens and "price not known" with the total marked partial, never a zero. `--json` prints a documented shape (`schemaVersion` 1). To make it fast the command keeps a small summary, `spend-ledger.json`, in the Namzu home beside the session index; it is safe to delete and is rebuilt from the logs. Plain `/cost` and `/cost details` are unchanged. Nothing to do on upgrade.
