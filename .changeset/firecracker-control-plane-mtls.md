---
'@namzu/sandbox': minor
---

Add an additive control-plane mTLS dial to the Firecracker backend.

`FirecrackerBackendInternalConfig` gains an optional `controlPlaneMtls`
(`{ ca; cert; key; servername? }`, the SAME shape as the relay's `mtls`). When
present, the orchestrator control-plane calls — `POST /sandboxes`,
`DELETE /sandboxes/{id}:delete` — dial over a `node:https` request that presents
the client cert and verifies the orchestrator's server cert against the injected
CA (`rejectUnauthorized: true`, `minVersion: TLSv1.3`), INSTEAD of the plain
global `fetch`. This secures the control plane when `orchestratorEndpoint` is an
`https://` URL reached over the PUBLIC internet (the non-VNet-integrated
caller→FC-host hop), where the shared-secret bearer alone would be exposed on
the wire.

The change is purely additive and opt-in: with no `controlPlaneMtls` injected,
the EXISTING plain-`fetch` control-plane path runs byte-for-byte unchanged (the
single-host live proofs + local dev). The shared-secret bearer is still sent in
both modes — mTLS is defense in depth on top, not a replacement. `node:https` is
used rather than a `fetch` + undici dispatcher because the package declares no
undici dependency; `node:https` is always importable and adds nothing. The cert
material is injected by the consumer's runtime (mirrors `getToken` and the relay
`mtls`), so the package still reads no keys from disk and stays Azure-SDK free.
