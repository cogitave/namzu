// Sub-barrel for the workspace module (Convention #4).
// Shape types live under `types/workspace/`; runtime machinery (drivers,
// registry, git-worktree, shared session workspace) lives in sibling files under
// `session/workspace/`.

export type {
	GitWorktreeBackendMeta,
	WorkspaceBackendKind,
	WorkspaceBackendMeta,
	WorkspaceRef,
} from '../../types/workspace/ref.js'

export type {
	WorkspaceBackendDriver,
	CreateWorkspaceParams,
	BranchWorkspaceParams,
	WorkspaceInspection,
} from './driver.js'

export { WorkspaceBackendRegistry } from './registry.js'

export { GitWorktreeDriver, parseWorktreeList } from './git-worktree.js'
export type { ExecFile, ExecFileResult, GitWorktreeDriverConfig } from './git-worktree.js'

export { SharedSessionWorkspace } from './shared-session.js'
export type {
	RegisterSharedSessionPlanInput,
	SharedSessionWorkspaceConfig,
} from './shared-session.js'
