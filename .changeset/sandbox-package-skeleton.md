---
'@namzu/sandbox': minor
---

feat(sandbox): new package — pluggable SandboxProvider for @namzu/sdk

Introduces a new workspace package `@namzu/sandbox` that wraps the
`SandboxProvider` shape `@namzu/sdk` already declares with concrete
backends. Sandbox is intentionally split off the core SDK because:

- Native dependencies (`bubblewrap` binary, seccomp filter generation,
  Docker SDK, parent-proxy machinery) shouldn't pollute every namzu
  consumer.
- Anthropic itself ships their sandbox runtime as a separate package
  (`@anthropic-ai/sandbox-runtime`) for the same reason.
- Hosts that don't need isolation (tests, trusted environments) can
  skip installing it.

This commit is the **public-surface skeleton** — the package is
declared, the contract is fixed, but no backend is implemented yet.
Calling `createSandboxProvider({ backend })` throws
`SandboxBackendNotImplementedError` for every backend tag. Backends
arrive in subsequent commits per the
`ses_004-native-agentic-runtime-and-sandbox` design session:

- **P3.1** — `process` backend (Anthropic sandbox-runtime adapter).
- **P3.2** — `EgressPolicy` plumbing with the proxy daemon.
- **P3.3** — `container` backend (compass-platform pattern).

The exported surface freezes:
- `SandboxBackendKind = 'process' | 'container' | 'passthrough'`
- `EgressPolicy` (deny-all / allow-all / static / resolver)
- `SandboxBackend` and `SandboxBackendOptions`
- `SandboxProviderConfig` and `createSandboxProvider`
- `SandboxBackendNotImplementedError`
