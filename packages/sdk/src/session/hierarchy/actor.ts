// Compatibility shim — the canonical home moved to `types/session/actor.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export type { ActorRef, SystemRoleId } from '../../types/session/actor.js'
