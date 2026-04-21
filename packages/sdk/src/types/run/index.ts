export * from './stop-reason.js'
export * from './config.js'
export * from './state.js'
// Note: `./status.js` is intentionally NOT re-exported via `export *` from
// this barrel — the domain `RunStatus` type (session-hierarchy.md §4.6)
// shares its name with the deprecated wire alias `RunStatus` in
// `contracts/api.ts` (the canonical wire name is now `WireRunStatus`, see
// Task 10 Phase 9). The root barrel re-exports the domain `RunStatus`
// explicitly via `export type { RunStatus } from './types/run/status.js'`
// so external consumers of `@namzu/sdk` land on the domain enum while
// `@namzu/contracts` continues to own the wire shape.
export * from './events.js'
export * from './metadata.js'
export * from './emergency.js'
export type { Lineage } from './lineage.js'
