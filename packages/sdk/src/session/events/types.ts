// Compatibility shim — the canonical home moved to `types/run/subsession-events.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type {
	SubsessionIdledEvent,
	SubsessionLifecycleEvent,
	SubsessionMessagedEvent,
	SubsessionSpawnedEvent,
} from '../../types/run/subsession-events.js'
