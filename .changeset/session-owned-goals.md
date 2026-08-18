---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Add session-owned durable completion goals, direct `/goal` operator control,
and race-fenced automatic continuation.

SDK consumers can persist, inspect, and transition a `SessionGoal` through
tenant-authorized in-memory or disk stores with exact revision checks. CLI
operators can create, inspect, edit, pause, resume, and clear the goal belonging
to the active durable conversation without sending those commands to the model.

The SDK also exposes atomic admitted-round accounting, finite caps,
process-local activation, host provenance for goal-sourced user messages, and
run-scoped goal tools. The CLI drives those primitives only at a durable idle
boundary, keeps human prompts ahead across admission races, withholds goal tools
from ordinary and child runs, disarms on abnormal or non-durable settlement,
and preserves automatic-turn attribution through resume and verified export.
