---
'@namzu/sdk': patch
---

Type layering rationalised (ses_010-sdk-type-layering).

**Note on bump level.** Originally classified as minor when ses_010 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset introduced no consumer-visible new names and renamed `AgentRun → Run` with a `@deprecated` alias, which the policy treats as a patch-level churn for 0.x. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

All pure shapes — entities, store contracts, wire types, events — now live under `packages/sdk/src/types/`. Feature folders (`session/`, `manager/`, `store/`, `agent/`, `provider/`) contain runtime code only.

**Public surface changes:**

- `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` are kept as `@deprecated` type aliases for the 0.4.x compatibility window — existing code importing either continues to compile. New code should use `Run`.
- Wire-side `Run` interface renamed to `WireRun`, mirroring the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` and wire `WireRun` with no collision.
- Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the old path no longer exists.

No runtime behaviour change. Every entity previously exported (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk`.
