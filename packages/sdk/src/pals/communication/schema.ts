import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MessageId, SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import { isEntityId } from '../../utils/id.js'
import type { PalAddress, PalMessageIntent, PalMessageSenderContext, PalRouteKey } from './types.js'

const id = z.string().uuid()
const sessionId = z.custom<SessionId>((s) => isEntityId(s, 'session'))
const turnId = z.custom<TurnId>((s) => isEntityId(s, 'turn'))
const recordMessageId = z.custom<MessageId>((s) => isEntityId(s, 'message'))
const positive = z.number().int().positive().safe()
const natural = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const label = z
	.string()
	.min(1)
	.max(512)
	.refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
export const addressSchema = z
	.object({
		tenantId: z.custom<TenantId>((s) => isEntityId(s, 'tenant')),
		palId: id,
	})
	.strict()
export const routeKeySchema = z
	.object({
		v: z.literal(1),
		kind: z.literal('pal'),
		sender: addressSchema,
		senderConversationId: z.custom<SessionId>((s) => isEntityId(s, 'session')),
		recipient: addressSchema,
		dialogKey: label,
	})
	.strict()
	.refine((r) => r.sender.tenantId === r.recipient.tenantId, 'Cross-tenant Pal routes are refused.')
export const sourceSchema = z
	.object({
		address: addressSchema,
		conversationId: z.custom<SessionId>((s) => isEntityId(s, 'session')),
		profileRevision: positive,
	})
	.strict()
export const sendRequestSchema = z
	.object({
		operationId: label,
		recipient: addressSchema,
		body: z
			.string()
			.min(1)
			.max(32_000)
			.refine((s) => !s.includes('\u0000')),
		dialogKey: label.optional(),
		replyTo: digest.optional(),
	})
	.strict()
export const intentSchema = z
	.object({
		id: digest,
		digest,
		operationId: label,
		source: sourceSchema,
		recipient: addressSchema,
		routeKey: routeKeySchema,
		body: z
			.string()
			.min(1)
			.max(32_000)
			.refine((s) => !s.includes('\u0000')),
		replyTo: digest.nullable(),
		grant: z.object({ id: label, revision: label }).strict(),
		createdAt: natural,
	})
	.strict()
export const operationReservationSchema = z.object({
	revision: z.literal(1),
	intent: intentSchema,
	recipientRevision: positive,
	conversationId: sessionId.nullable(),
})
export const bindingSchema = z.object({
	id: digest,
	key: routeKeySchema,
	sessionId,
	profileRevision: positive,
	revision: positive,
	phase: z.enum(['reserved', 'active']),
})
const headSchema = z
	.object({
		pointer: z
			.object({ seq: positive, offset: natural, length: positive, sha256: digest })
			.strict(),
		gen: natural,
		bytes: positive,
	})
	.strict()
export const receiptSchema = z
	.object({
		claimId: id,
		ref: z.object({ namespace: z.literal('namzu-pal-message/1'), id: digest, digest }).strict(),
		sessionId,
		turnId,
		messageId: recordMessageId,
		through: headSchema,
	})
	.strict()
export const inboxSchema = intentSchema.extend({
	ordinal: positive,
	routeId: digest,
	phase: z.enum(['pending', 'claimed', 'recorded']),
	claim: z
		.object({ id, sessionId, turnId, generation: natural, content: z.string().min(1).max(48_000) })
		.strict()
		.nullable(),
	receipt: receiptSchema.nullable(),
})
export const snapshotSchema = z.object({
	recipient: addressSchema,
	revision: positive,
	routes: z.array(bindingSchema),
	messages: z.array(inboxSchema),
})

/** Capture parsed values recursively before any host callback can observe them. */
export function freezeCommunicationValue<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeCommunicationValue(child)
		Object.freeze(value)
	}
	return value
}

export function hash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function addressTuple(value: PalAddress): readonly string[] {
	return [value.tenantId, value.palId]
}
export function routeTuple(value: PalRouteKey): readonly unknown[] {
	return [
		1,
		'pal',
		addressTuple(value.sender),
		value.senderConversationId,
		addressTuple(value.recipient),
		value.dialogKey,
	]
}
export function routeId(value: PalRouteKey): string {
	return hash(routeTuple(routeKeySchema.parse(value)))
}
export function messageId(source: PalMessageSenderContext, operationId: string): string {
	return hash([
		1,
		'pal-message',
		addressTuple(source.address),
		source.conversationId,
		label.parse(operationId),
	])
}
export function intentDigest(intent: Omit<PalMessageIntent, 'digest'>): string {
	return hash([
		1,
		addressTuple(intent.source.address),
		intent.source.conversationId,
		intent.source.profileRevision,
		intent.operationId,
		addressTuple(intent.recipient),
		routeTuple(intent.routeKey),
		intent.body,
		intent.replyTo,
	])
}
