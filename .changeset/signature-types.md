---
'@namzu/sdk': minor
---

Export the 28 types that exported signatures already named.

Each is the parameter or the result of a function that was already public, and none of them was reachable. A consumer could call `createLogger` and had no name for its options or its return; could call `compactRegion`, `runBidi`, the handoff helpers, the replay helpers, and had to inline every shape or reach for `any`. The package's vocabulary stopped at the function name.

Additive: `LoggerOptions`, `CreatedLogger`, `MutableLogSinkCounters`, `CompactRegionInput`, `ResolvedContextWindow`, `UsageSink`, `BidiRun`, `BidiRunParams`, `MockBidiScript`, `MockBidiSession`, `SingleHandoffDeps`, `BroadcastHandoffDeps`, `HandoffAssignment`, `HandoffOutcome`, `PrepareReplayInput`, `PreparedReplayState`, `ListCheckpointsInput`, `ProbeContextInput`, `KernelCommandOptions`, `ToolCatalogFromRegistryOptions`, `PluginDiscoveryOptions`, `SecretRedactionOptions`, `FilesystemMigrationSink`, `MigrationWarningSink`, `MigrationMarker`, `InterventionChainLoader`, `Project`, `ActionInput`.

Nothing changes for existing code.

A new CI step keeps it that way. `check-signature-types-exported.mjs` resolves every exported signature and fails when a type it names is declared in the package and not exported — the same defect had been hit three times in two days, each time by whoever happened to write the first consumer, which is the profile of something that needs a check rather than more care.
