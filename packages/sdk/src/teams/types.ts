import { z } from 'zod'

/**
 * What a team keeps on disk, under `<NAMZU_HOME>/teams/<team>/`.
 *
 * @experimental
 */

export const TEAM_CONFIG_VERSION = 1

/** Where a teammate runs. Only `in-process` exists today; the others are named so a later backend plugs in. */
export const TeamBackendKindSchema = z.enum(['in-process', 'process', 'pane'])
export type TeamBackendKind = z.infer<typeof TeamBackendKindSchema>

export const TeamMemberSchema = z
	.object({
		/** Stable identity of this member in this team; a rollback removes exactly this one. */
		id: z.string().min(1),
		name: z.string().min(1),
		color: z.string().min(1),
		/** Milliseconds since the epoch. */
		joinedAt: z.number().int().nonnegative(),
		backend: TeamBackendKindSchema,
		/** False from the moment a name is reserved until the teammate has started, and again once it has ended. */
		active: z.boolean(),
		agentType: z.string().min(1).optional(),
	})
	.strict()
export type TeamMember = z.infer<typeof TeamMemberSchema>

export const TeamConfigSchema = z
	.object({
		version: z.literal(TEAM_CONFIG_VERSION),
		name: z.string().min(1),
		leadSessionId: z.string().min(1),
		/** The lead's process, so a later start can tell a team whose lead is gone. */
		leadPid: z.number().int().positive().optional(),
		project: z.string().optional(),
		cwd: z.string().optional(),
		createdAt: z.number().int().nonnegative(),
		members: z.array(TeamMemberSchema),
	})
	.strict()
export type TeamConfig = z.infer<typeof TeamConfigSchema>

export const MAIL_KINDS = [
	'message',
	'idle',
	'shutdown_request',
	'shutdown_response',
	'plan_request',
	'plan_response',
	'permission_request',
	'permission_response',
] as const
export const MailKindSchema = z.enum(MAIL_KINDS)
export type MailKind = z.infer<typeof MailKindSchema>

/** One piece of mail in a member's inbox file. */
export const MailEntrySchema = z
	.object({
		id: z.string().min(1),
		/** A member's name, or `lead`. */
		from: z.string().min(1),
		text: z.string(),
		summary: z.string().optional(),
		/** ISO-8601 time the entry was written. */
		at: z.string().min(1),
		read: z.boolean().optional(),
		kind: MailKindSchema.optional(),
	})
	.strict()
export type MailEntry = z.infer<typeof MailEntrySchema>

/** What a caller gives for a new piece of mail; the store adds the id and the time. */
export interface MailDraft {
	readonly from: string
	readonly text: string
	readonly summary?: string
	readonly kind?: MailKind
}

export type TeamStoreErrorCode =
	| 'bad_name'
	| 'team_exists'
	| 'team_not_found'
	| 'name_taken'
	| 'team_full'
	| 'member_not_found'
	| 'unknown_recipient'
	| 'too_large'
	| 'busy'

export class TeamStoreError extends Error {
	override readonly name = 'TeamStoreError'
	constructor(
		readonly code: TeamStoreErrorCode,
		message: string,
	) {
		super(message)
	}
}
