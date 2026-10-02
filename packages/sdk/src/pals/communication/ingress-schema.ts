import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { MessageId, SessionId, TurnId } from '../../types/ids/index.js'
import { SESSION_RECORD_MAX_BYTES } from '../../types/session/records.js'
import { isEntityId } from '../../utils/id.js'
import type { PalActivityCursor, PalActivityFact, PalActivityScope } from '../activity/types.js'
import type {
	PalChannelIdentity,
	PalIngressDigestInput,
	PalIngressIntent,
	PalIngressIntentDraft,
	PalIngressRouteKey,
} from './ingress-types.js'
import {
	addressSchema,
	addressTuple,
	freezeCommunicationValue,
	hash,
	inboxSchema,
	intentDigest,
	intentSchema,
	label,
	messageId,
	routeId,
	routeKeySchema,
	routeTuple,
} from './schema.js'
import { sameAddress } from './types.js'

const positive = z.number().int().positive().safe()
const natural = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = z.string().uuid()
const sessionId = z.custom<SessionId>((value) => isEntityId(value, 'session'))
const turnId = z.custom<TurnId>((value) => isEntityId(value, 'turn'))
const recordMessageId = z.custom<MessageId>((value) => isEntityId(value, 'message'))
const recordPointer = z
	.object({
		seq: positive,
		offset: natural,
		length: positive.max(SESSION_RECORD_MAX_BYTES),
		sha256: digest,
	})
	.strict()

export const activityScopeSchema = z
	.object({
		tenantId: z.custom<PalActivityScope['tenantId']>((value) => isEntityId(value, 'tenant')),
		projectId: z.custom<PalActivityScope['projectId']>((value) => isEntityId(value, 'project')),
		sessionId,
		palId: uuid,
		profileRevision: positive,
	})
	.strict()

/** Trusted host-stored source cursors only; this schema does not authenticate an anchor. */
export const activityCursorSchema: z.ZodType<PalActivityCursor> = z
	.object({
		v: z.literal(1),
		scopeHash: digest,
		root: recordPointer,
		after: recordPointer,
		generation: natural,
	})
	.strict()

const factBase = z.object({
	id: digest,
	sessionId,
	turnId,
	seq: positive,
	generation: natural,
	at: z.string().datetime({ offset: false }),
})
const activityId = z.custom<NonNullable<PalActivityFact['activityId']>>((value) =>
	isEntityId(value, 'activity'),
)
const checkpointId = z.custom<NonNullable<PalActivityFact['checkpointId']>>((value) =>
	isEntityId(value, 'checkpoint'),
)
const toolUseId = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9_.:-]+$/)
const activityStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'])

/** Exact field sets per fact type: no payload, tool name, error or extra metadata can pass. */
export const activityFactSchema: z.ZodType<PalActivityFact> = z.discriminatedUnion('type', [
	factBase.extend({ type: z.literal('turn_started'), status: z.literal('running') }).strict(),
	factBase
		.extend({
			type: z.literal('turn_resuming'),
			status: z.literal('running'),
		})
		.strict(),
	factBase.extend({ type: z.literal('turn_paused'), checkpointId }).strict(),
	factBase
		.extend({
			type: z.literal('turn_completed'),
			status: z.enum(['completed', 'cancelled']),
		})
		.strict(),
	factBase.extend({ type: z.literal('turn_failed'), status: z.literal('failed') }).strict(),
	factBase
		.extend({
			type: z.literal('activity_created'),
			activityId,
			activityType: z.enum(['tool_call', 'llm_turn', 'sub_agent', 'shell']),
			status: z.literal('pending'),
		})
		.strict(),
	factBase
		.extend({
			type: z.literal('activity_updated'),
			activityId,
			status: activityStatus,
		})
		.strict(),
	factBase
		.extend({
			type: z.literal('tool_executing'),
			toolUseId,
			status: z.literal('running'),
		})
		.strict(),
	factBase
		.extend({
			type: z.literal('tool_completed'),
			toolUseId,
			status: z.enum(['completed', 'failed']),
		})
		.strict(),
	factBase.extend({ type: z.literal('tool_review_requested') }).strict(),
	factBase
		.extend({
			type: z.literal('tool_review_completed'),
			reviewDecision: z.enum(['approved', 'modified', 'rejected']),
		})
		.strict(),
	factBase.extend({ type: z.literal('checkpoint_created'), checkpointId }).strict(),
])

const nativeShape = {
	provider: label,
	connectionId: label,
	externalTenantId: label,
	nativeConversationId: label,
	nativeChannelId: label.nullable(),
	nativeThreadId: label.nullable(),
}
export const channelIdentitySchema = z.object(nativeShape).strict()
export const channelSourceSchema = z
	.object({
		...nativeShape,
		kind: z.literal('channel'),
		tenantId: z.custom<PalActivityScope['tenantId']>((value) => isEntityId(value, 'tenant')),
		actorId: label,
		eventId: label,
	})
	.strict()
export const channelRouteKeySchema = z
	.object({
		...nativeShape,
		v: z.literal(1),
		kind: z.literal('channel'),
		recipient: addressSchema,
	})
	.strict()
export const observationSourceSchema = z
	.object({
		kind: z.literal('host-observation'),
		subscriptionId: uuid,
		scope: activityScopeSchema,
	})
	.strict()
export const observationRouteKeySchema = z
	.object({
		v: z.literal(1),
		kind: z.literal('observation'),
		recipient: addressSchema,
		subscriptionId: uuid,
		scope: activityScopeSchema,
	})
	.strict()
export const ingressRouteKeySchema = z.union([
	routeKeySchema,
	observationRouteKeySchema,
	channelRouteKeySchema,
])

const base = {
	id: digest,
	digest,
	operationId: label,
	recipient: addressSchema,
	replyTo: z.null(),
	grant: z.object({ id: label, revision: label }).strict(),
	createdAt: natural,
}
export const observationIntentSchema = z
	.object({
		...base,
		kind: z.literal('observation'),
		source: observationSourceSchema,
		routeKey: observationRouteKeySchema,
		fact: activityFactSchema,
		subscriptionTrail: z.array(uuid).min(1).max(32),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			new Set(value.subscriptionTrail).size !== value.subscriptionTrail.length ||
			!value.subscriptionTrail.includes(value.source.subscriptionId)
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					'An observation trail must contain each subscription exactly once, including its publisher.',
			})
		if (
			value.fact.sessionId !== value.source.scope.sessionId ||
			value.operationId !== value.fact.id
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Observation event identity does not match the captured source.',
			})
	})
export const channelIntentSchema = z
	.object({
		...base,
		kind: z.literal('channel'),
		source: channelSourceSchema,
		routeKey: channelRouteKeySchema,
		body: z
			.string()
			.min(1)
			.max(32_000)
			.refine((value) => !value.includes('\u0000')),
	})
	.strict()
	.refine(
		(value) => value.operationId === value.source.eventId,
		'Operation identity must equal the captured channel event.',
	)
export const ingressIntentSchema = z.union([
	intentSchema,
	observationIntentSchema,
	channelIntentSchema,
])

export const ingressBindingSchema = z.object({
	id: digest,
	key: ingressRouteKeySchema,
	sessionId,
	profileRevision: positive,
	revision: positive,
	phase: z.enum(['reserved', 'active']),
})
export const ingressReceiptSchema = z
	.object({
		claimId: uuid,
		ref: z
			.object({
				namespace: z.enum([
					'namzu-pal-message/1',
					'namzu-pal-observation/1',
					'namzu-pal-channel/1',
				]),
				id: digest,
				digest,
			})
			.strict(),
		sessionId,
		turnId,
		messageId: recordMessageId,
		through: z.object({ pointer: recordPointer, gen: natural, bytes: positive }).strict(),
	})
	.strict()
const delivery = {
	ordinal: positive,
	routeId: digest,
	phase: z.enum(['pending', 'claimed', 'recorded']),
	claim: z
		.object({
			id: uuid,
			sessionId,
			turnId,
			generation: natural,
			content: z.string().min(1).max(48_000),
		})
		.strict()
		.nullable(),
	receipt: ingressReceiptSchema.nullable(),
}
export const ingressInboxSchema = z.union([
	inboxSchema,
	// Reuse the exact strict intent parser after removing only the known delivery fields.
	z
		.object({
			...base,
			...delivery,
			kind: z.literal('observation'),
			source: observationSourceSchema,
			routeKey: observationRouteKeySchema,
			fact: activityFactSchema,
			subscriptionTrail: z.array(uuid).min(1).max(32),
		})
		.strict(),
	z
		.object({
			...base,
			...delivery,
			kind: z.literal('channel'),
			source: channelSourceSchema,
			routeKey: channelRouteKeySchema,
			body: z
				.string()
				.min(1)
				.max(32_000)
				.refine((value) => !value.includes('\u0000')),
		})
		.strict(),
])
export const ingressSnapshotSchema = z.object({
	recipient: addressSchema,
	revision: positive,
	routes: z.array(ingressBindingSchema),
	messages: z.array(ingressInboxSchema),
})
export const ingressOperationReservationSchema = z.object({
	revision: z.literal(1),
	intent: ingressIntentSchema,
	recipientRevision: positive,
	conversationId: sessionId.nullable(),
})

export function nativeChannelTuple(identity: PalChannelIdentity): readonly unknown[] {
	return [
		identity.provider,
		identity.connectionId,
		identity.externalTenantId,
		identity.nativeConversationId,
		identity.nativeChannelId,
		identity.nativeThreadId,
	]
}
export function activityScopeTuple(scope: PalActivityScope): readonly unknown[] {
	return [scope.tenantId, scope.projectId, scope.palId, scope.profileRevision, scope.sessionId]
}
export function ingressRouteTuple(key: PalIngressRouteKey): readonly unknown[] {
	if (key.kind === 'pal') return routeTuple(key)
	if (key.kind === 'observation')
		return [
			1,
			'observation',
			addressTuple(key.recipient),
			key.subscriptionId,
			activityScopeTuple(key.scope),
		]
	return [1, 'channel', addressTuple(key.recipient), ...nativeChannelTuple(key)]
}
export function ingressRouteId(key: PalIngressRouteKey): string {
	const parsed = ingressRouteKeySchema.parse(key)
	return parsed.kind === 'pal' ? routeId(parsed) : hash(ingressRouteTuple(parsed))
}
export function ingressIntentId(intent: PalIngressIntentDraft): string {
	if (!('kind' in intent)) return messageId(intent.source, intent.operationId)
	if (intent.kind === 'observation')
		return hash([
			1,
			'pal-observation',
			intent.source.subscriptionId,
			activityScopeTuple(intent.source.scope),
			intent.fact.id,
		])
	return hash([
		1,
		'pal-channel',
		intent.source.tenantId,
		...nativeChannelTuple(intent.source),
		intent.source.eventId,
	])
}
export function ingressIntentDigest(intent: PalIngressDigestInput): string {
	if (!('kind' in intent)) return intentDigest(intent)
	if (intent.kind === 'observation')
		return hash([
			1,
			'observation',
			intent.source.subscriptionId,
			activityScopeTuple(intent.source.scope),
			intent.operationId,
			addressTuple(intent.recipient),
			ingressRouteTuple(intent.routeKey),
			[
				intent.fact.id,
				intent.fact.type,
				intent.fact.sessionId,
				intent.fact.turnId ?? null,
				intent.fact.seq,
				intent.fact.generation,
				intent.fact.at,
				intent.fact.activityId ?? null,
				intent.fact.activityType ?? null,
				intent.fact.status ?? null,
				intent.fact.toolUseId ?? null,
				intent.fact.checkpointId ?? null,
				intent.fact.reviewDecision ?? null,
			],
			intent.subscriptionTrail,
		])
	return hash([
		1,
		'channel',
		intent.source.tenantId,
		...nativeChannelTuple(intent.source),
		intent.source.actorId,
		intent.source.eventId,
		intent.operationId,
		addressTuple(intent.recipient),
		ingressRouteTuple(intent.routeKey),
		intent.body,
		intent.replyTo,
	])
}

/** Capture and validate source identity and payload independently from delivery state. */
export function checkedIngressIntent(value: unknown): PalIngressIntent {
	const intent = ingressIntentSchema.parse(value) as PalIngressIntent
	if (
		intent.id !== ingressIntentId(intent) ||
		intent.digest !== ingressIntentDigest(intent) ||
		!sameAddress(intent.recipient, intent.routeKey.recipient)
	)
		throw new Error('Invalid immutable Pal source operation.')
	if (!('kind' in intent)) {
		if (
			!sameAddress(intent.source.address, intent.routeKey.sender) ||
			intent.source.conversationId !== intent.routeKey.senderConversationId
		)
			throw new Error('Invalid immutable Pal source operation.')
	} else if (intent.kind === 'observation') {
		if (
			intent.recipient.tenantId !== intent.source.scope.tenantId ||
			intent.source.subscriptionId !== intent.routeKey.subscriptionId ||
			!isDeepStrictEqual(intent.source.scope, intent.routeKey.scope)
		)
			throw new Error('Foreign observation source or route.')
	} else if (
		intent.source.tenantId !== intent.recipient.tenantId ||
		!isDeepStrictEqual(nativeChannelTuple(intent.source), nativeChannelTuple(intent.routeKey))
	)
		throw new Error('Foreign channel source or route.')
	return freezeCommunicationValue(intent)
}
