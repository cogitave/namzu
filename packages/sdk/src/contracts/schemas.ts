import { z } from 'zod'

import { entityIdPattern } from '../utils/id-format.js'

/**
 * Shared with constructors and stores: opaque UUIDs. The session and turn
 * schemas (`SessionIdSchema`, `TurnIdSchema`, `TurnConfigSchema`,
 * `CreateTurnSchema`, `CreateEphemeralSessionSchema`) live in
 * `./session/schemas.ts`.
 */
export const ProjectIdSchema = z.string().regex(entityIdPattern(), 'Invalid project ID format')
export const MessageIdSchema = z.string().regex(entityIdPattern(), 'Invalid message ID format')

export const CreateMessageSchema = z
	.object({
		role: z.literal('user'),
		content: z.string().min(1, 'Message content cannot be empty'),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const PaginationSchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	after: z.string().optional(),
	before: z.string().optional(),
	order: z.enum(['asc', 'desc']).default('desc'),
})

export function zodErrorToApiError(error: z.ZodError): {
	code: string
	message: string
	type: 'validation_error'
	param?: string
} {
	const firstIssue = error.issues[0]
	return {
		code: 'invalid_request',
		message: firstIssue
			? `${firstIssue.path.join('.')}: ${firstIssue.message}`
			: 'Validation failed',
		type: 'validation_error',
		param: firstIssue?.path.join('.') || undefined,
	}
}
