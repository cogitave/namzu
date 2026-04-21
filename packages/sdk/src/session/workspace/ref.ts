// Compatibility shim — the canonical home moved to `types/workspace/`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type {
	GitWorktreeBackendMeta,
	WorkspaceBackendKind,
	WorkspaceBackendMeta,
	WorkspaceRef,
} from '../../types/workspace/ref.js'
