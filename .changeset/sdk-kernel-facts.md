---
'@namzu/sdk': minor
---

A host's answer to `initialize` now carries an optional `kernel` object: `engine` (this package's version) and `dataEpoch` (a new exported integer constant, `DATA_EPOCH`, starting at 1) always, plus `commandLine` and `desktopContract` when the application that embeds the bridge gives them through the new `AcpServerOptions.kernelFacts`. A client that does not know the object ignores it, so nothing breaks for an existing reader. A program that keeps several copies of the engine side by side can compare `dataEpoch` to decide whether two copies can share one person's files: raise it only when an older copy can no longer safely read or write what a newer one writes. New exported types `AcpKernelFacts` and `AcpHostKernelFacts`. A test now lists every stamped on-disk format with its version, so changing one is a deliberate step.
