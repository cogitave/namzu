---
'@namzu/cli': patch
---

Refuse to resume, continue, fork, or mutate conversations that are already archived, closed, or outside the current workspace. Exact `--resume <id>` now resolves the durable id independently of the recent-conversation limit, while archived history remains readable for inspection and export.
