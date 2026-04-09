import { z } from 'zod'

export const A2ATaskStateSchema = z.enum([
	'pending',
	'running',
	'completed',
	'failed',
	'canceled',
	'rejected',
	'input-required',
])

export const A2APartKindSchema = z.enum(['text', 'file', 'data'])
export const A2AMessageRoleSchema = z.enum(['user', 'agent'])
export const A2ATransportSchema = z.enum(['jsonrpc', 'rest', 'grpc'])

export const TextPartSchema = z
	.object({
		kind: z.literal('text'),
		text: z.string().min(1),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const FilePartSchema = z
	.object({
		kind: z.literal('file'),
		file: z
			.object({
				uri: z.string().url(),
				mimeType: z.string().min(1),
				name: z.string().optional(),
				bytes: z.string().optional(),
			})
			.strict(),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const DataPartSchema = z
	.object({
		kind: z.literal('data'),
		data: z.record(z.unknown()),
		mimeType: z.string().optional(),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const A2APartSchema = z.discriminatedUnion('kind', [
	TextPartSchema,
	FilePartSchema,
	DataPartSchema,
])

export const A2AMessageSchema = z
	.object({
		role: A2AMessageRoleSchema,
		parts: z.array(A2APartSchema).min(1, 'Message must have at least one part'),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const A2ATaskStatusSchema = z
	.object({
		state: A2ATaskStateSchema,
		message: A2AMessageSchema.optional(),
		timestamp: z.string().optional(),
	})
	.strict()

export const A2AArtifactSchema = z
	.object({
		artifactId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		parts: z.array(A2APartSchema).min(1),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const A2AMessageSendSchema = z
	.object({
		message: A2AMessageSchema,
		id: z.string().optional(),
		contextId: z.string().optional(),
		metadata: z.record(z.unknown()).optional(),
	})
	.strict()

export const A2ATaskGetSchema = z
	.object({
		id: z.string().min(1, 'Task ID is required'),
		includeHistory: z.boolean().optional(),
	})
	.strict()

export const A2ATaskListSchema = z
	.object({
		contextId: z.string().optional(),
		state: A2ATaskStateSchema.optional(),
		limit: z.number().int().min(1).max(100).default(20),
		cursor: z.string().optional(),
	})
	.strict()

export const A2ATaskCancelSchema = z
	.object({
		id: z.string().min(1, 'Task ID is required'),
	})
	.strict()

export const A2ATaskSchema = z.object({
	id: z.string(),
	contextId: z.string().optional(),
	status: A2ATaskStatusSchema,
	history: z.array(A2AMessageSchema).optional(),
	artifacts: z.array(A2AArtifactSchema).optional(),
	metadata: z.record(z.unknown()).optional(),
})

export const A2AErrorCodeSchema = z.enum([
	'TaskNotFound',
	'TaskNotCancelable',
	'ContentTypeNotSupported',
	'UnsupportedOperation',
	'PushNotificationNotSupported',
	'InvalidRequest',
	'InternalError',
	'Unauthorized',
])

export type A2AMessageSendInput = z.infer<typeof A2AMessageSendSchema>
export type A2ATaskGetInput = z.infer<typeof A2ATaskGetSchema>
export type A2ATaskListInput = z.infer<typeof A2ATaskListSchema>
export type A2ATaskCancelInput = z.infer<typeof A2ATaskCancelSchema>
