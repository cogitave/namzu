---
'@namzu/sdk': minor
'@namzu/computer-use': minor
---

Export the 45 types that exported signatures already named.

Each is the parameter or the result of a function that was already public, and none of them was reachable. A consumer could call `createLogger` and had no name for its options or its return; could call `compactRegion`, `runBidi`, the handoff helpers, the replay helpers, and had to inline every shape or reach for `any`. The package's vocabulary stopped at the function name.

Additive: the original 28 function-signature types plus constructor contracts including `AgentManagerDeps`, `TopicManagerDeps`, `ProjectManagerDeps`, `DiskTopicStateStoreConfig`, `DiskMessageFeedbackStoreConfig`, `MessageExistenceCheck`, `EnvCredentialProviderOptions`, `FileLockManagerConfig`, `GitWorktreeDriverConfig`, `CapacityDimension`, `HandoffLockRejectedReason`, `SessionSummaryMaterializerDeps`, `ArchivalManagerDeps`, `ArchiveBackendRef`, `DiskArchiveBackendConfig`, `SlidingWindowManagerConfig`, and `SubprocessComputerUseHostOptions`.

Nothing changes for existing code.

A CI step keeps it that way. `check-signature-types-exported.mjs` resolves exported function signatures and public class constructors, then fails when a type they name is declared in the package and not exported. The constructor branch has its own self-check so removing it cannot turn the gate silently green.
