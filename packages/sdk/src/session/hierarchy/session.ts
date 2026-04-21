// Compatibility shim — the shape types moved to `types/session/entity.ts`;
// the runtime pure helper `deriveStatus` lives at `session/status/derive.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { Session, SessionStatus } from '../../types/session/entity.js'
export { deriveStatus } from '../status/derive.js'
