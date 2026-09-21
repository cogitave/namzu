import { z } from 'zod'

import { entityIdPattern } from '../../utils/id-format.js'
import { TURN_STREAM_EVENT_TYPES } from './api.js'
import { WIRE_TURN_STATUSES } from './turn-status.js'

// Request validation for the session and turn wire surface. The schemas are
// not annotated with the interfaces they validate, on purpose: an annotation
// would make the inferred type the interface itself and hide any drift. The
// tests assert instead that each schema infers exactly its interface, so a
// field added to one and not the other fails the typecheck.

/** A session id on the wire: an opaque UUID, the same spelling its constructor accepts. */
export const SessionIdSchema = z.string().regex(entityIdPattern(), 'Invalid session ID format')

/** A turn id on the wire: an opaque UUID, the same spelling its constructor accepts. */
export const TurnIdSchema = z.string().regex(entityIdPattern(), 'Invalid turn ID format')

export const WireTurnStatusSchema = z.enum(WIRE_TURN_STATUSES)

export const TurnStreamEventTypeSchema = z.enum(TURN_STREAM_EVENT_TYPES)

export const TurnConfigSchema = z
	.object({
		model: z.string().min(1).optional(),
		temperature: z.number().min(0).max(2).optional(),
		tokenBudget: z.number().int().nonnegative().optional(),
		maxResponseTokens: z.number().int().positive().optional(),
		timeoutMs: z.number().int().nonnegative().max(3_600_000).optional(),
		streamIdleTimeoutMs: z.number().int().nonnegative().max(3_600_000).optional(),
		maxRequestRichContentBytes: z
			.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER)
			.optional(),
		permissionMode: z.enum(['plan', 'auto']).optional(),
		systemPrompt: z.string().min(1).max(100_000).optional(),
	})
	.strict()

/** `POST /sessions/{id}/turns`. The session id comes from the path, not the body. */
export const CreateTurnSchema = z
	.object({
		message: z.string().min(1, 'message is required'),
		config: TurnConfigSchema,
		env: z.record(z.string()).optional(),
		stream: z.boolean().optional(),
	})
	.strict()

/** A session and its first turn, created together. */
export const CreateEphemeralSessionSchema = z
	.object({
		agent_id: z.string().min(1, 'agent_id is required'),
		message: z.string().min(1, 'message is required'),
		config: TurnConfigSchema,
		env: z.record(z.string()).optional(),
	})
	.strict()
