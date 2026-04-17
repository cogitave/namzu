// Top-level barrel for the session hierarchy module.
// Phase 1 populates `hierarchy/`; Phase 2 adds `events/`; Phase 3 adds
// `workspace/` + `errors.ts`; Phase 4 adds `handoff/`; Phase 5 adds
// `summary/` + `intervention/`; Phase 7 adds `migration/`; Phase 8 adds
// `retention/`.

export * from './hierarchy/index.js'
export * from './events/index.js'
export * from './workspace/index.js'
export * from './handoff/index.js'
export * from './summary/index.js'
export * from './intervention/index.js'
export * from './migration/index.js'
export * from './retention/index.js'
export { TenantIsolationError, WorkspaceBackendError, AncestryCycleError } from './errors.js'
