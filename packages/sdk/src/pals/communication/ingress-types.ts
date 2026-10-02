import type { SessionId, TurnId } from '../../types/ids/index.js'
import type {
	DurableInboundSource,
	InboundDeliveryReceipt,
	InboundDeliveryRef,
} from '../../types/message/inbound-delivery.js'
import type { PalActivityFact, PalActivityScope } from '../activity/types.js'
import type { PalDefinition, PalStore } from '../types.js'
import {
	type PalAddress,
	type PalAuthorizationRequest,
	type PalConversationAccess,
	type PalDeliveryClaim,
	type PalInboxMessage,
	type PalMessageAuthorization,
	type PalMessageGrant,
	type PalMessageIntent,
	type PalMessageReceipt,
	type PalRouteKey,
	authorizationRequest,
} from './types.js'

export interface PalObservationRouteKey {
	readonly v: 1
	readonly kind: 'observation'
	readonly recipient: PalAddress
	readonly subscriptionId: string
	readonly scope: PalActivityScope
}

/** Native identity from a trusted connection verifier; no credential is stored. */
export interface PalChannelIdentity {
	readonly provider: string
	readonly connectionId: string
	readonly externalTenantId: string
	readonly nativeConversationId: string
	readonly nativeChannelId: string | null
	readonly nativeThreadId: string | null
}

export interface PalChannelRouteKey extends PalChannelIdentity {
	readonly v: 1
	readonly kind: 'channel'
	readonly recipient: PalAddress
}

export interface PalObservationSource {
	readonly kind: 'host-observation'
	readonly subscriptionId: string
	readonly scope: PalActivityScope
}

/** Actor is captured per event, independently from conversation routing. */
export interface PalChannelSource extends PalChannelIdentity {
	readonly kind: 'channel'
	readonly tenantId: PalAddress['tenantId']
	readonly actorId: string
	readonly eventId: string
}

export interface PalIngressIntentBase {
	readonly id: string
	readonly digest: string
	readonly operationId: string
	readonly recipient: PalAddress
	readonly grant: PalMessageGrant
	readonly createdAt: number
	readonly replyTo: null
}

export interface PalObservationIntent extends PalIngressIntentBase {
	readonly kind: 'observation'
	readonly source: PalObservationSource
	readonly routeKey: PalObservationRouteKey
	readonly fact: PalActivityFact
	/** Host-resolved original delivery causality, containing this publishing subscription once. */
	readonly subscriptionTrail: readonly string[]
}

export interface PalChannelIntent extends PalIngressIntentBase {
	readonly kind: 'channel'
	readonly source: PalChannelSource
	readonly routeKey: PalChannelRouteKey
	readonly body: string
}

/** Legacy Pal intents retain their original shape and namespace. */
export type PalIngressIntent = PalMessageIntent | PalObservationIntent | PalChannelIntent
export type PalIngressIntentDraft =
	| Omit<PalMessageIntent, 'id' | 'digest'>
	| Omit<PalObservationIntent, 'id' | 'digest'>
	| Omit<PalChannelIntent, 'id' | 'digest'>
export type PalIngressDigestInput =
	| Omit<PalMessageIntent, 'digest'>
	| Omit<PalObservationIntent, 'digest'>
	| Omit<PalChannelIntent, 'digest'>
export type PalIngressRouteKey = PalRouteKey | PalObservationRouteKey | PalChannelRouteKey

export interface PalIngressRouteBinding {
	readonly id: string
	readonly key: PalIngressRouteKey
	readonly sessionId: SessionId
	readonly profileRevision: number
	readonly revision: number
	readonly phase: 'reserved' | 'active'
}

export interface PalIngressDeliveryState {
	readonly ordinal: number
	readonly routeId: string
	readonly phase: 'pending' | 'claimed' | 'recorded'
	readonly claim: PalDeliveryClaim | null
	readonly receipt: InboundDeliveryReceipt | null
}

export type PalIngressInboxMessage =
	| PalInboxMessage
	| ((PalObservationIntent | PalChannelIntent) & PalIngressDeliveryState)
export type PalIngressAcceptanceReceipt = PalMessageReceipt

export interface PalIngressSnapshot {
	readonly recipient: PalAddress
	readonly revision: number
	readonly routes: readonly PalIngressRouteBinding[]
	readonly messages: readonly PalIngressInboxMessage[]
}

export interface PalIngressVerificationContext {
	readonly binding: PalIngressRouteBinding
	readonly access: PalConversationAccess
	readonly definition: PalDefinition
}

/** One recipient ledger and unresolved-claim barrier across every input family. Trusted host only. */
export interface PalIngressStore {
	readIngress(recipient: PalAddress): Promise<PalIngressSnapshot | null>
	acceptIngress(
		intent: PalIngressIntent,
		recipientRevision: number,
		conversationId?: SessionId,
	): Promise<PalIngressAcceptanceReceipt>
	routeIngress(key: PalIngressRouteKey): Promise<PalIngressRouteBinding | null>
	activateIngress(
		binding: PalIngressRouteBinding,
		context: PalIngressVerificationContext,
	): Promise<PalIngressRouteBinding>
	claimIngress(
		binding: PalIngressRouteBinding,
		request: {
			readonly turnId: TurnId
			readonly generation: number
			readonly content: (message: PalIngressInboxMessage) => string
		},
	): Promise<PalIngressInboxMessage | null>
	recordedIngress(
		message: PalIngressInboxMessage,
		receipt: InboundDeliveryReceipt,
		context: PalIngressVerificationContext,
	): Promise<PalIngressInboxMessage>
	/** Requires complete original evidence plus a fenced, stopped prior writer. */
	releaseUnrecordedIngress(
		message: PalIngressInboxMessage,
		context: PalIngressVerificationContext,
	): Promise<PalIngressInboxMessage>
}

export type PalIngressAuthorizationRequest =
	| PalAuthorizationRequest
	| (Omit<PalObservationIntent, 'id' | 'digest' | 'operationId' | 'grant' | 'createdAt'> & {
			readonly phase: 'accept' | 'deliver' | 'wake'
	  })
	| (Omit<PalChannelIntent, 'id' | 'digest' | 'operationId' | 'grant' | 'createdAt'> & {
			readonly phase: 'accept' | 'deliver' | 'wake'
	  })

export interface PalIngressHostPort {
	ensureConversation(binding: PalIngressRouteBinding, signal: AbortSignal): Promise<void>
	openConversation(
		binding: PalIngressRouteBinding,
		signal: AbortSignal,
	): Promise<PalConversationAccess>
	notify?(recipient: PalAddress): void | Promise<void>
	wait?(binding: PalIngressRouteBinding, signal: AbortSignal): Promise<void>
	runConversation(
		binding: PalIngressRouteBinding,
		source: DurableInboundSource,
		signal: AbortSignal,
	): Promise<void>
}

export interface PalIngressOptions {
	readonly store: PalIngressStore
	readonly pals: PalStore
	/** Required current disclosure/receive or wake authority; acceptance audit is not continuing consent. */
	readonly authorize: (request: PalIngressAuthorizationRequest) => Promise<PalMessageAuthorization>
	readonly host?: PalIngressHostPort
}

export interface PalIngressSourceOptions extends PalIngressOptions {
	readonly binding: PalIngressRouteBinding
	readonly host: PalIngressHostPort
}

export type PalIngressDispatchOutcome =
	| { readonly status: 'idle'; readonly reason: 'empty' | 'unresolved' }
	| { readonly status: 'blocked'; readonly reason: string }
	| { readonly status: 'ran'; readonly binding: PalIngressRouteBinding }

export const PAL_OBSERVATION_NAMESPACE = 'namzu-pal-observation/1'
export const PAL_CHANNEL_NAMESPACE = 'namzu-pal-channel/1'

export function ingressMessageRef(
	message: Pick<PalIngressInboxMessage, 'id' | 'digest'> & {
		readonly kind?: 'observation' | 'channel'
	},
): InboundDeliveryRef {
	return {
		namespace:
			message.kind === 'observation'
				? PAL_OBSERVATION_NAMESPACE
				: message.kind === 'channel'
					? PAL_CHANNEL_NAMESPACE
					: 'namzu-pal-message/1',
		id: message.id,
		digest: message.digest,
	}
}

export function ingressRuntimeContextKind(
	message: PalIngressIntent,
): 'peer-message' | 'host-observation' | 'channel-message' {
	return 'kind' in message
		? message.kind === 'observation'
			? 'host-observation'
			: 'channel-message'
		: 'peer-message'
}

export function ingressAuthorizationRequest(
	message: PalIngressIntent,
	phase: 'accept' | 'deliver' | 'wake',
): PalIngressAuthorizationRequest {
	if (!('kind' in message))
		return authorizationRequest(message, phase === 'accept' ? 'send' : phase)
	const common = {
		phase,
		kind: message.kind,
		source: message.source,
		recipient: message.recipient,
		routeKey: message.routeKey,
		replyTo: null,
	}
	return message.kind === 'observation'
		? {
				...common,
				kind: 'observation',
				source: message.source,
				routeKey: message.routeKey,
				fact: message.fact,
				subscriptionTrail: message.subscriptionTrail,
			}
		: {
				...common,
				kind: 'channel',
				source: message.source,
				routeKey: message.routeKey,
				body: message.body,
			}
}

export function currentIngressRecipient(
	pals: PalStore,
	binding: PalIngressRouteBinding,
): PalDefinition {
	const pal = pals.get(binding.key.recipient.palId)
	if (!pal || pal.paused) throw new Error('Recipient Pal is paused or unavailable.')
	return pals.getRevision(pal.id, binding.profileRevision)
}
