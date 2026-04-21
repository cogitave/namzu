// Compatibility shim — the canonical home moved to `types/session/messages.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { SessionMessage } from '../../types/session/messages.js'
