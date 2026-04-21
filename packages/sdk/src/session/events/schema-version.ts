// Compatibility shim — the canonical home moved to `types/run/schema-version.ts`.
// Scheduled for deletion in ses_010 commit 8 once all direct-file consumers
// are rewritten. See `docs.local/sessions/ses_010-sdk-type-layering/`.

export { RUN_EVENT_SCHEMA_VERSION } from '../../types/run/schema-version.js'
export type { RunEventSchemaVersion } from '../../types/run/schema-version.js'
