---
'@namzu/sdk': patch
---

The `Agent` tool now bounds a delegated run by the hour, like its twin

`buildAgentTool` declared no `timeoutMs`, and declaring nothing is not "no deadline" — it is the executor's `DEFAULT_TOOL_TIMEOUT_MS`, 120 seconds. That is a reasonable bound for a tool call and an absurd one for a call that runs an entire agent to completion and blocks on it.

Its twin `create_task`, built by `buildCoordinatorTools` in the sibling module, has declared `DELEGATION_TIMEOUT_MS` (one hour) all along, and the measurement behind that number is recorded in its docblock: three delegated children took 4m21s, 5m58s and 8m04s, and all three parents gave up at 120 seconds. That fix reached one of the two delegation surfaces and never carried to the other.

**What changes for you.** A delegated run through the `Agent` tool that takes longer than two minutes now completes instead of being abandoned. If you were relying on the 120-second bound to catch a wedged child, note that the run budget and the iteration ceiling both still apply above this, and a wedged child is still caught — an hour later rather than two minutes later.

The two tools are now asserted to agree, so a future change to one deadline fails until it moves the other. That is the assertion, rather than each tool's number separately: drifting apart is the defect, and two independent assertions pass while it happens.
