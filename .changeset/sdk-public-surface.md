---
'@namzu/sdk': minor
---

Public-surface barrel split (ses_011-sdk-public-surface).

`packages/sdk/src/index.ts` splits from 357 lines of mixed re-exports into three focused bucket files, consumed through a thin 10-line root barrel:

- **`public-types.ts`** — every type a consumer type-checks against (branded IDs, wire shapes, domain entities, store contracts, event unions, config types).
- **`public-runtime.ts`** — every runtime value (classes, functions, constants, zod schemas, error classes, ID generators).
- **`public-tools.ts`** — agent-tool surface (`defineTool` primitive, built-in tools, domain builders, connector tool bridge, `createRAGTool`).

No consumer-visible change. All 380 previously-exported names continue to be exported; none removed, none added. Verified by a baseline snapshot (`.github/scripts/public-surface-baseline.json` — captured at the tip of ses_010) plus a CI smoke test (`.github/scripts/verify-public-surface.mjs`) that loads `@namzu/sdk` at runtime and compares `Object.keys()` against the baseline.

Additional cleanup:

- The `ProjectId` / `RunId` / `MessageId` / `SessionId` double-channel (reachable through both `contracts/` and `types/ids/`) is closed. IDs come from `types/ids/` uniformly; `contracts/ids.ts` is deleted; `contracts/api.ts` imports IDs from `../types/ids/` directly.
- The `RunStatus` carve-out is folded. Since ses_010 renamed the wire-side alias to `WireRunStatus`, the domain `RunStatus` can flow through `types/run/index.ts` with a plain `export *` — no explicit carve-out needed.
