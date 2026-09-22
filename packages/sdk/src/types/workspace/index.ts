// Sub-barrel for the workspace shape surface (Convention #4).
// Concrete types live in sibling files; re-export them here.
//
// Runtime workspace machinery (drivers, registry, git-worktree)
// stays under `session/workspace/` — this barrel is shape-only.

export type {
	GitWorktreeBackendMeta,
	WorkspaceBackendKind,
	WorkspaceBackendMeta,
	WorkspaceRef,
} from './ref.js'

export type {
	SharedSessionWorkspaceAgentRecord,
	SharedSessionWorkspaceManifest,
	SharedSessionWorkspacePaths,
	SharedSessionWorkspacePlan,
	SharedSessionWorkspaceRefs,
	SharedSessionWorkspaceSource,
} from './shared-session.js'
