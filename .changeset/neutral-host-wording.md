---
'@namzu/sandbox': patch
'@namzu/sdk': patch
'@namzu/files': patch
'@namzu/anthropic': patch
---

Shipped text no longer names one particular application built on namzu. Nothing to do to upgrade: no type, default or behaviour changes.

- `@namzu/sandbox`: when a self-hosted Firecracker orchestrator returns a network-mode (`mtls`) agent handle and the backend was given no client certificate, the error now tells you to pass `mtls: { ca, cert, key }` in the backend config. It used to name environment variables that only one host defines, which no other installer has. The message still starts with `firecracker: orchestrator returned an mtls agent handle but no client cert material was injected`, so code matching on that prefix keeps working.
- Doc comments in the published `.d.ts` files and sources (`ContainerBackendConfig.labels`, the ACI and Azure Blob name options, the sandbox mount-source types) say "the host" or "the consumer", and label examples use the placeholder `acme.` namespace. The `microvm` tier's (`MicroVMBackendConfig`, `AgentSnapshotRef`, `OrchestratorNetworkPolicy`) describe the orchestrator as a self-hosted one the host runs, not as namzu's own: namzu ships only the client.
- Earlier entries in the `@namzu/sandbox`, `@namzu/sdk` and `@namzu/anthropic` CHANGELOGs are reworded the same way; the `@namzu/files` CHANGELOG named no one and is unchanged. Versions already on npm keep their old text.
