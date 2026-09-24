// Public surface of the toolset layer (plan.md §1): the unit every tool
// comes from, composable wrappers over it, and `combineToolsets`. See
// `docs/sdk/toolsets.md`.
//
// `ToolRegistry` (`registry/tool/execute.ts`) is untouched by this module —
// a later item hands it toolsets; this module only builds values.

export { combineToolsets, ToolsetConflictError } from './combine.js'
export { matchesSourceIdGlob } from './source-glob.js'
export { toolset } from './toolset.js'
export type {
	ToolFilterSelector,
	ToolPredicate,
	Toolset,
	ToolsetAvailability,
	ToolSourceRef,
} from './types.js'
export { toToolSourceRef } from './types.js'
export {
	deferred,
	filtered,
	mapTools,
	prefixed,
	renamed,
	requireApproval,
	withMetadata,
} from './wrappers.js'
