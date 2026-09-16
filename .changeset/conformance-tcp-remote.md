---
"@namzu/sandbox": patch
---

`defineSandboxConformance`'s `openTcpConnection` positive case now starts its echo listener INSIDE the guest, through `openTerminal`, instead of on the orchestrator/test process's own loopback. The old fixture only ever proved anything for a backend whose "guest" happened to share that loopback with the test process (a Firecracker unit test over a local socket, a fake-agent-in-process kubernetes test) — it could never pass against a real remote sandbox, which cannot dial the orchestrator's loopback at all. Confirmed in-cluster: this case now passes against a live kubernetes backend acquisition on a real kind cluster, where it previously failed with `connect ECONNREFUSED`.

Two new optional fields on `SandboxConformanceOptions` — `guestCanRunNode` and `guestListenerCommand` — let a backend whose guest cannot run a listener this way skip the case with a stated reason (its own title) rather than fail spuriously; both default to the existing behavior (node is assumed available, since every shipped backend's guest agent already runs on node), so no existing caller of `defineSandboxConformance` needs to change anything.

Patch, not minor: this module has no `testing` subpath in `@namzu/sandbox`'s own `exports` map (see the file's own doc comment) — a caller reaches it only by relative path within the monorepo, as `backends/kubernetes/__tests__/conformance.test.ts` and `backends/firecracker/__tests__/conformance.test.ts` already do — so this is not yet public surface, and the added options are additive and optional regardless.

Also corrects a self-contradictory doc comment on `Sandbox.openTerminal` (`@namzu/sdk`): it told an implementer to both "throw" and "omit" for a guest that cannot provide one. It now says only "omit", matching `Sandbox.openTcpConnection`'s own wording and this suite's documented skip-if-unavailable convention. Comment-only; no type or behavior changed.
