// Compatibility shim — the canonical home moved to `types/retention/`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { RetentionPolicy } from '../../types/retention/policy.js'
export { RETENTION_POLICY_DISABLED } from '../../types/retention/policy.js'
