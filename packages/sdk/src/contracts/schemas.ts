import { z } from 'zod'

export const ProjectIdSchema = z.string().regex(/^prj_[a-z0-9]+$/, 'Invalid project ID format')
export const RunIdSchema = z.string().regex(/^run_[a-z0-9]+$/, 'Invalid run ID format')
export const MessageIdSchema = z.string().regex(/^msg_[a-z0-9]+$/, 'Invalid message ID format')

export const RunConfigSchema = z
	.object({
		model: z.string().min(1).optional(),
		temperature: z.number().min(0).max(2).optional(),
		tokenBudget: z.number().int().positive().optional(),
		maxResponseTokens: z.number().int().positive().optional(),
		timeoutMs: z.number().int().positive().max(3_600_000).optional(),
		permissionMode: z.enum(['plan', 'auto']).optional(),
		systemPrompt: z.string().min(1).max(100_000).optional(),
	})
	.strict()

export const CreateMessageSchema = z
	.object({
		role: z.literal('user'),
		content: z.string().min(1, 'Message content cannot be empty'),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const CreateRunSchema = z
	.object({
		agent_id: z.string().min(1, 'agent_id is required'),
		config: RunConfigSchema,
		env: z.record(z.string()).optional(),
		stream: z.boolean().optional(),
	})
	.strict()

export const CreateStatelessRunSchema = z
	.object({
		agent_id: z.string().min(1, 'agent_id is required'),
		message: z.string().min(1, 'message is required'),
		config: RunConfigSchema,
		env: z.record(z.string()).optional(),
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
