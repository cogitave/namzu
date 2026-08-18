---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Add session-owned durable completion goals and direct `/goal` operator control.

SDK consumers can persist, inspect, and transition a `SessionGoal` through
tenant-authorized in-memory or disk stores with exact revision checks. CLI
operators can create, inspect, edit, pause, resume, and clear the goal belonging
to the active durable conversation without sending those commands to the model.
Automatic continuation and its admitted-round accounting remain an explicit
host responsibility and are not implied by an active goal record.
