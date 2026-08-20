---
'@namzu/sdk': major
'@namzu/cli': major
'@namzu/sandbox': minor
---

Bound sandbox lifecycle ownership across run cancellation and teardown.

Sandbox creation now receives run cancellation and the run's remaining wall-clock timeout, cannot publish a handle after either boundary wins, and releases any handle that arrives late. A setup that ignores its signal therefore settles the run with `stopReason: 'timeout'` instead of pinning it forever. Teardown receives a fresh signal and waits for 30 seconds by default without allowing an implementation that ignores cancellation to pin the run. Set `sandboxTeardownTimeoutMs: 0` on SDK runs or agents to retain the former unbounded teardown wait. Custom providers should honor `SandboxCreateConfig.signal` and `SandboxDestroyOptions.signal`; remote allocation protocols still need a client-owned reconciliation key or fleet reaper for a resource committed behind a lost response.

The CLI exposes the same compatibility control as `sandbox.teardownTimeoutMs` and carries it to live turns, delegated child agents, and durable resumes. Children and resumed runs now use the session's sandbox provider instead of silently executing through the host boundary; set `sandbox.enabled: false` only when host execution is intentional.
