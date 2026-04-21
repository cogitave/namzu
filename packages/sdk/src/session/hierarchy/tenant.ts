// Compatibility shim — the canonical home moved to `types/tenant/entity.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { Tenant } from '../../types/tenant/entity.js'
