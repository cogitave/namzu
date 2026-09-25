---
'@namzu/sdk': major
---

Continuing a session with a different project, tenant or topic now fails with `invalid_config` before its history, budget or queued topic messages are used. A supplied session log must also name the requested session. Pass the complete identity returned by the first `runAgent` call on later turns, or use the same recorded scope with `query` and `QueryAgent`. `resumeSession`, `loadTurnState`, `loadSelectedTurnState` and `prepareForkState` verify the source log before reading checkpoints. `PrepareForkInput.scope.topicId` is now required: change `scope: checkpointScope` to `scope: { ...checkpointScope, topicId: sourceTopicId }`, using the source session's recorded topic.

Older session logs whose `session_started` record lacks `tenantId` or `topicId` remain readable but can no longer be continued, resumed or forked because their owner cannot be established. To migrate, verify the owner outside the log, start a new session under that scope and seed it with trusted conversation messages. Keep the old hash-chained log unchanged.

Custom `SessionLog.claim` implementations must honor the new `repairTornTail: false` option used during owner admission. Defer torn-tail truncation and repair records until a later authorized append when that option is false.
The session-log conformance contract is now version 2; update a custom backend's declared `contractVersion` after it passes the new deferred-repair case.
