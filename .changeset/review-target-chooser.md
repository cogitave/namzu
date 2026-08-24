---
'@namzu/cli': minor
---

Open bare `/review` as a keyboard chooser for a base branch, uncommitted work,
a recent commit, or custom instructions. Branch comparisons are resolved to an
immutable merge-base commit before reaching the agent, and finite choice labels
use available terminal width instead of truncating every name to 18 columns.
