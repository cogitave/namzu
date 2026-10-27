---
'@namzu/cli': patch
---

A change to a file that moved after it was read is refused before any approval box opens, instead of asking you to approve it and then refusing. The refused row says "File changed since it was read, nothing written". The plan file's row head says "the plan" even for a long path, and only a plan inside a real session folder is called the plan: a `plans/plan.md` in your own `projects` folder shows as a path again. Text and ordering only; nothing to change.
