/**
 * Teams: named helpers that work beside the main conversation, with a membership file, a mailbox each
 * and (elsewhere) a shared task list. This module is the storage and naming layer plus the seam a
 * teammate runner plugs into; running a teammate is host territory.
 *
 * @experimental
 */

export {
	normalizeTeamName,
	TEAM_LEAD_NAME,
	teammateNameProblem,
	teamNameProblem,
} from './names.js'
export {
	MAX_MAIL_ENTRIES,
	MAX_MAIL_TEXT_BYTES,
	TEAM_COLORS,
	TEAM_CREATE_GRACE_MS,
	TeamStore,
} from './store.js'
export type {
	CreateTeamInput,
	MailReadOptions,
	ReserveMemberInput,
	TeamStoreOptions,
} from './store.js'
export {
	MAIL_KINDS,
	MailEntrySchema,
	MailKindSchema,
	TEAM_CONFIG_VERSION,
	TeamBackendKindSchema,
	TeamConfigSchema,
	TeamMemberSchema,
	TeamStoreError,
} from './types.js'
export type {
	MailDraft,
	MailEntry,
	MailKind,
	TeamBackendKind,
	TeamConfig,
	TeamMember,
	TeamStoreErrorCode,
} from './types.js'
export type { TeammateBackend, TeammateStartSpec } from './backend.js'
