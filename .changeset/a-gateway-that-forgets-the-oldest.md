---
'@namzu/sdk': patch
---

`LocalTaskGateway` stops remembering every task it ever launched.

`trackedTaskIds` and `settledHandles` had `add` and `set` and no removal
anywhere in the file. The comment above them said "bounded by the number the
gateway itself launched", which is true and is not a bound: a gateway built per
run is bounded by that run, but `SupervisorAgentConfig.gateway` lets a host
supply its own, and a long-lived host reusing one accumulates an id and a
settled handle for every task it ever launched, for the life of the process.

Both are now capped at 1000 and evicted oldest-first. The cap is far above any
realistic single run — a fan-out is eight, a long supervisory run is dozens —
so the listing a supervisor reads at the end of its run is unchanged.

The two are evicted **together**. Dropping a tracked id while keeping its
handle would leave memory nothing can reach, since `listTasks` walks the ids;
dropping a handle while keeping its id would make a task that ran read as one
that never launched, which is the exact defect the settled-handle map exists to
fix. Removing either half of the paired delete fails a test.
