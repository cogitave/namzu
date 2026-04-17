// Sub-barrel for the workspace module (Convention #4).
// Concrete types + driver implementation live in sibling files; re-export
// them here so other modules import via `../session/workspace/index.js`.

export type {
	WorkspaceRef,
	WorkspaceBackendMeta,
	WorkspaceBackendKind,
	GitWorktreeBackendMeta,
} from './ref.js'

export type {
	WorkspaceBackendDriver,
	CreateWorkspaceParams,
	BranchWorkspaceParams,
	WorkspaceInspection,
} from './driver.js'

export { DefaultPathBuilder } from './path-builder.js'
export type { PathBuilder } from './path-builder.js'

export { WorkspaceBackendRegistry } from './registry.js'

export { GitWorktreeDriver, parseWorktreeList } from './git-worktree.js'
export type { ExecFile, ExecFileResult, GitWorktreeDriverConfig } from './git-worktree.js'
