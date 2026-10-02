import { createHash } from 'node:crypto'
import { z } from 'zod'
import { channelRouteKeySchema, channelSourceSchema } from '../communication/ingress-schema.js'
import type { PalChannelIdentity } from '../communication/ingress-types.js'
import { addressSchema, freezeCommunicationValue, hash, label } from '../communication/schema.js'
import type { PalChannelConnection, PalChannelRouteDecision } from './types.js'

export const connectionSchema = z
	.object({
		tenantId: addressSchema.shape.tenantId,
		provider: label,
		connectionId: label,
		externalTenantId: label,
	})
	.strict()
const verifiedIdentity = {
	externalTenantId: label,
	nativeConversationId: label,
	nativeChannelId: label.nullable(),
	nativeThreadId: label.nullable(),
	actorId: label,
	eventId: label,
}
export const verifiedMessageSchema = z
	.object({
		...verifiedIdentity,
		kind: z.literal('message'),
		body: z
			.string()
			.min(1)
			.max(32_000)
			.refine((value) => !value.includes('\0')),
	})
	.strict()
export const verifiedActionSchema = z
	.object({
		...verifiedIdentity,
		kind: z.literal('action'),
		deliveryRef: z
			.object({
				namespace: z.literal('namzu-pal-channel/1'),
				id: z.string().regex(/^[a-f0-9]{64}$/),
				digest: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
		actionId: label,
		payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
		payload: z
			.string()
			.min(1)
			.max(32_000)
			.refine((value) => !value.includes('\0')),
	})
	.strict()
	.refine(
		(value) => createHash('sha256').update(value.payload).digest('hex') === value.payloadDigest,
		'Channel action payload does not match its authenticated digest.',
	)
export const routeDecisionSchema = z
	.object({
		v: z.literal(1),
		revision: z.literal(1),
		identity: channelRouteKeySchema.omit({
			v: true,
			kind: true,
			recipient: true,
		}),
		recipient: addressSchema,
		profileRevision: z.number().int().positive().safe(),
	})
	.strict()

export function captureConnection(input: PalChannelConnection): PalChannelConnection {
	return freezeCommunicationValue(connectionSchema.parse(input))
}

export function checkedIdentity(connection: PalChannelConnection, event: unknown) {
	const source = channelSourceSchema.parse(event)
	if (
		source.tenantId !== connection.tenantId ||
		source.provider !== connection.provider ||
		source.connectionId !== connection.connectionId ||
		source.externalTenantId !== connection.externalTenantId
	)
		throw new Error('Channel identity does not belong to the authenticated connection.')
	return freezeCommunicationValue(source)
}

export function nativeTuple(identity: PalChannelIdentity): readonly unknown[] {
	return [
		identity.provider,
		identity.connectionId,
		identity.externalTenantId,
		identity.nativeConversationId,
		identity.nativeChannelId,
		identity.nativeThreadId,
	]
}

export function decisionId(
	decision: Pick<PalChannelRouteDecision, 'identity' | 'recipient'>,
): string {
	return hash([1, decision.recipient.tenantId, nativeTuple(decision.identity)])
}

export function checkedDecision(input: unknown): PalChannelRouteDecision {
	return freezeCommunicationValue(routeDecisionSchema.parse(input))
}
