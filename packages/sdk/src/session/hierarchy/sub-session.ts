// Compatibility shim — the canonical home moved to `types/session/sub-session.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type {
	CompletionMode,
	DeliverableRef,
	FailureMode,
	SubSession,
	SubSessionKind,
	SubSessionStatus,
} from '../../types/session/sub-session.js'
