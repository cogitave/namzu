---
'@namzu/sdk': patch
---

Public-surface barrel split (ses_011-sdk-public-surface).

**Note on bump level.** Originally classified as minor when ses_011 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset explicitly preserved all 380 pre-existing public names (verified by `.github/scripts/verify-public-surface.mjs`), so patch is semver-accurate at the name-set level. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

`packages/sdk/src/index.ts` splits from 357 lines of mixed re-exports into three focused bucket files, consumed through a thin 10-line root barrel:

- **`public-types.ts`** — every type a consumer type-checks against (branded IDs, wire shapes, domain entities, store contracts, event unions, config types).
- **`public-runtime.ts`** — every runtime value (classes, functions, constants, zod schemas, error classes, ID generators).
- **`public-tools.ts`** — agent-tool surface (`defineTool` primitive, built-in tools, domain builders, connector tool bridge, `createRAGTool`).

No consumer-visible change. All 380 previously-exported names continue to be exported; none removed, none added. Verified by a baseline snapshot (`.github/scripts/public-surface-baseline.json` — captured at the tip of ses_010) plus a CI smoke test (`.github/scripts/verify-public-surface.mjs`) that loads `@namzu/sdk` at runtime and compares `Object.keys()` against the baseline.

Additional cleanup:

- The `ProjectId` / `RunId` / `MessageId` / `SessionId` double-channel (reachable through both `contracts/` and `types/ids/`) is closed. IDs come from `types/ids/` uniformly; `contracts/ids.ts` is deleted; `contracts/api.ts` imports IDs from `../types/ids/` directly.
- The `RunStatus` carve-out is folded. Since ses_010 renamed the wire-side alias to `WireRunStatus`, the domain `RunStatus` can flow through `types/run/index.ts` with a plain `export *` — no explicit carve-out needed.
