// Compatibility shim — the canonical home moved to `types/summary/`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type {
	ArtifactBlobDeliverable,
	DeliverableKind,
	DeliverableRef,
	FileDeliverable,
	MessageDeliverable,
	SessionSummaryDeliverable,
} from '../../types/summary/deliverable.js'
