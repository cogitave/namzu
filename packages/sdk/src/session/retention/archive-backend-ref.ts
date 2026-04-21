// Compatibility shim — the canonical home moved to `types/retention/`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { ArchiveBackendRef } from '../../types/retention/archive-backend-ref.js'
