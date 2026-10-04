import { z } from 'zod'
import { isEntityId } from '../../utils/id.js'
import type { MessageId, TurnId } from '../ids/index.js'
import type { HarnessEvent, HarnessJson } from './session.js'

const opaque = z
	.string()
	.min(1)
	.max(4096)
	.refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32))
const text = z.string().max(1024 * 1024)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const turnId = z.custom<TurnId>((v) => isEntityId(v, 'turn'))
const messageId = z.custom<MessageId>((v) => isEntityId(v, 'message'))

function validJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
	if (depth > 32 || ++budget.nodes > 50000) return false
	if (value === null || typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (typeof value === 'string') return value.length <= 1024 * 1024
	if (Array.isArray(value)) return value.every((v) => validJson(v, depth + 1, budget))
	if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
	return Object.entries(value).every(
		([k, v]) => k.length <= 4096 && validJson(v, depth + 1, budget),
	)
}
const json = z
	.custom<HarnessJson>((v) => validJson(v))
	.refine((v) => JSON.stringify(v).length <= 1024 * 1024)

export const HarnessBindingSchema = z
	.object({
		v: z.literal(1),
		engineId: opaque,
		profileRef: opaque,
		nativeSessionId: opaque,
		cwd: opaque,
		initialModel: opaque,
	})
	.strict()
const nativeTurn = {
	nativeSessionId: opaque,
	nativeTurnId: opaque,
	turnIdSource: z.enum(['engine', 'operation']).optional(),
}
const nativeItem = { ...nativeTurn, nativeItemId: opaque }
export const HarnessNativeTurnSchema = z.object(nativeTurn).strict()
export const HarnessReviewRequestSchema = z
	.object({
		...nativeTurn,
		requestId: opaque,
		nativeItemId: opaque.optional(),
		kind: z.enum(['command', 'file-change', 'tool']),
		title: opaque,
		input: json,
		decisions: z
			.array(z.enum(['approve-once', 'reject', 'cancel']))
			.min(1)
			.max(3),
	})
	.strict()
export const HarnessDecisionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('approve-once'), updatedInput: json.optional() }).strict(),
	z.object({ kind: z.literal('reject'), feedback: text.optional() }).strict(),
	z.object({ kind: z.literal('cancel') }).strict(),
])
const part = z
	.object({ id: opaque, text, phase: z.enum(['commentary', 'final_answer']).optional() })
	.strict()
export const HarnessEventSchema: z.ZodType<HarnessEvent> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('turn-started'), ...nativeTurn, model: opaque.optional() }).strict(),
	z.object({ kind: z.literal('message-started'), ...nativeItem }).strict(),
	z
		.object({
			kind: z.literal('text-delta'),
			...nativeItem,
			text,
			part: part.omit({ text: true }).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('message-completed'),
			...nativeItem,
			content: text,
			parts: z.array(part).max(10000).optional(),
			stopReason: z.enum([
				'end_turn',
				'tool_use',
				'max_tokens',
				'stop_sequence',
				'pause_turn',
				'refusal',
				'forced_finalize',
				'cancelled',
			]),
		})
		.strict(),
	z
		.object({
			kind: z.literal('reasoning'),
			...nativeItem,
			blockId: opaque,
			status: z.enum(['pending', 'completed']),
			text: text.optional(),
		})
		.strict(),
	z.object({ kind: z.literal('tool-started'), ...nativeItem, name: opaque, input: json }).strict(),
	z.object({ kind: z.literal('tool-output'), ...nativeItem, text }).strict(),
	z
		.object({
			kind: z.literal('tool-completed'),
			...nativeItem,
			name: opaque,
			result: text,
			status: z.enum(['completed', 'failed', 'declined', 'cancelled']),
			durationMs: z.number().int().nonnegative().safe().optional(),
		})
		.strict(),
	z.object({ kind: z.literal('review-requested'), request: HarnessReviewRequestSchema }).strict(),
	z.object({ kind: z.literal('review-resolved'), ...nativeTurn, requestId: opaque }).strict(),
	z
		.object({
			kind: z.literal('turn-completed'),
			...nativeTurn,
			status: z.enum(['completed', 'failed', 'cancelled']),
			finalItemId: opaque.optional(),
			result: text.optional(),
			error: z.object({ code: opaque, message: text }).strict().optional(),
		})
		.strict(),
	z
		.object({ kind: z.literal('connection-lost'), code: opaque, mayBeRunning: z.boolean() })
		.strict(),
])

export const HarnessJournalTransitionSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('dispatch-prepared'),
			model: opaque.optional(),
			effort: z
				.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
				.optional(),
			permissionMode: z.enum(['prompt', 'auto', 'accept-edits', 'plan', 'strict']).optional(),
			operationId: opaque,
			turnId,
			promptId: messageId,
			digest,
		})
		.strict(),
	z
		.object({
			kind: z.literal('dispatch-accepted'),
			operationId: opaque,
			turnId,
			nativeTurn: HarnessNativeTurnSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('item-bound'),
			turnId,
			nativeItem: z.object(nativeItem).strict(),
			messageId: messageId.optional(),
			toolUseId: opaque.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('review-requested'),
			turnId,
			request: HarnessReviewRequestSchema,
			digest,
		})
		.strict(),
	z
		.object({
			kind: z.literal('review-decided'),
			turnId,
			requestId: opaque,
			requestDigest: digest,
			decisionDigest: digest,
			decision: HarnessDecisionSchema,
		})
		.strict(),
	z.object({ kind: z.literal('review-resolved'), turnId, requestId: opaque }).strict(),
	z
		.object({ kind: z.literal('connection-lost'), turnId: turnId.optional(), code: opaque })
		.strict(),
])

/** Clone at ingress, before any host callback can suspend, and freeze every nested value. */
export function harnessSnapshot<T>(value: T): T {
	const copy = structuredClone(value)
	const freeze = (v: unknown): void => {
		if (!v || typeof v !== 'object') return
		for (const entry of Object.values(v)) freeze(entry)
		Object.freeze(v)
	}
	freeze(copy)
	return copy
}
