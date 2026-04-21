// Sub-barrel for the workspace shape surface (Convention #4).
// Concrete types live in sibling files; re-export them here.
//
// Runtime workspace machinery (drivers, registry, path-builder, git-worktree)
// stays under `session/workspace/` — this barrel is shape-only.

export type {
	GitWorktreeBackendMeta,
	WorkspaceBackendKind,
	WorkspaceBackendMeta,
	WorkspaceRef,
} from './ref.js'
