---
'@namzu/cli': patch
---

Use the SDK's existing task context selector for interactive task snapshots. Failed tasks closed before the current turn no longer stay open or crowd out pending work; a failed dependency is terminal without being reported as successful. Preserve current-turn outcomes and the original start time during resume.
