// Top-level barrel for the session hierarchy module.
// Phase 1 populates `hierarchy/`; Phase 2 adds `events/`. Later phases add
// handoff/, workspace/, summary/, intervention/, retention/, and migration/
// sub-barrels.

export * from './hierarchy/index.js'
export * from './events/index.js'
