// Sub-barrel for the intervention DAG module (Convention #4).
//
// See session-hierarchy.md §4.5 — intervention chains via `prevArtifactRef`
// form a strict acyclic DAG capped by
// `Project.config.maxInterventionDepth`. This module owns the pre-commit
// validator + typed errors; sub-session wiring is Phase 6.

export {
	ArtifactRefCycleError,
	InterventionDepthExceeded,
	validatePrevArtifactChain,
} from './prev-artifact.js'
export type {
	InterventionChainLoader,
	PrevArtifactNode,
} from './prev-artifact.js'
