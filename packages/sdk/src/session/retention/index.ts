// Sub-barrel for the retention/archival module (Convention #4).
// Concrete shape types live under `types/retention/`; runtime machinery
// (backend contract, manager, disk backend) lives in sibling files under
// `session/retention/`.

export type { ArchiveBackendRef } from '../../types/retention/archive-backend-ref.js'
export type { RetentionPolicy } from '../../types/retention/policy.js'
export { RETENTION_POLICY_DISABLED } from '../../types/retention/policy.js'
export type { ArchiveBackend, ArchiveInput, ArchiveOutput, SubSessionTombstone } from './backend.js'
export {
	ArchivalManager,
	ArchiveNotConfiguredError,
	SubSessionNotArchivableError,
	SubSessionNotArchivedError,
} from './archive.js'
export type { ArchivalManagerDeps, WorkspaceResolver } from './archive.js'
export { ArchiveNotFoundError, DiskArchiveBackend } from './disk-backend.js'
export type { DiskArchiveBackendConfig } from './disk-backend.js'
