// Top-level barrel for the session module.
// Shape types (Project / Thread / Session / SubSession / Actor / Lineage /
// Tenant) live under `types/` as of ses_010 (2026-04-21); this barrel
// re-exports only the runtime machinery that lives under `session/*/`
// (events, workspace, handoff, summary, intervention, migration, retention,
// status). Consumers of `@namzu/sdk` reach entity shapes through the root
// barrel directly.

export * from './events/index.js'
export * from './workspace/index.js'
export * from './handoff/index.js'
export * from './summary/index.js'
export * from './intervention/index.js'
export * from './migration/index.js'
export * from './retention/index.js'
export { TenantIsolationError, WorkspaceBackendError, AncestryCycleError } from './errors.js'
