import type { SessionLog } from '../../store/session-log/core.js'
import type { ProjectId, SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import type {
	DurableInboundSource,
	InboundDeliveryReceipt,
	InboundDeliveryRef,
} from '../../types/message/inbound-delivery.js'
import type { PalDefinition, PalStore } from '../types.js'

export interface PalAddress {
	readonly tenantId: TenantId
	readonly palId: string
}

/** One sender conversation opens a distinct, authorized recipient conversation. */
export interface PalRouteKey {
	readonly v: 1
	readonly kind: 'pal'
	readonly sender: PalAddress
	readonly senderConversationId: SessionId
	readonly recipient: PalAddress
	readonly dialogKey: string
}

export interface PalRouteBinding {
	readonly id: string
	readonly key: PalRouteKey
	readonly sessionId: SessionId
	readonly profileRevision: number
	readonly revision: number
	readonly phase: 'reserved' | 'active'
}

export interface PalMessageSenderContext {
	readonly address: PalAddress
	readonly conversationId: SessionId
	readonly profileRevision: number
}

/** An audit reference, never a bearer credential or continuing grant. */
export interface PalMessageGrant {
	readonly id: string
	readonly revision: string
}

export interface PalMessageIntent {
	readonly id: string
	readonly digest: string
	readonly operationId: string
	readonly source: PalMessageSenderContext
	readonly recipient: PalAddress
	readonly routeKey: PalRouteKey
	readonly body: string
	readonly replyTo: string | null
	readonly grant: PalMessageGrant
	readonly createdAt: number
}

export interface PalDeliveryClaim {
	readonly id: string
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly generation: number
	/** Exact rendered context retained for recovery, including its delimiter nonce. */
	readonly content: string
}

export interface PalInboxMessage extends PalMessageIntent {
	readonly ordinal: number
	readonly routeId: string
	readonly phase: 'pending' | 'claimed' | 'recorded'
	readonly claim: PalDeliveryClaim | null
	readonly receipt: InboundDeliveryReceipt | null
}

export interface PalMessageReceipt {
	readonly id: string
	readonly digest: string
	readonly recipient: PalAddress
	readonly routeId: string
	readonly sessionId: SessionId
	readonly ordinal: number
	readonly status: 'accepted'
}

export interface PalCommunicationSnapshot {
	readonly recipient: PalAddress
	readonly revision: number
	readonly routes: readonly PalRouteBinding[]
	readonly messages: readonly PalInboxMessage[]
}

/** These methods are a trusted host/store port, never model-visible evidence tools. */
export interface PalCommunicationStore {
	read(recipient: PalAddress): Promise<PalCommunicationSnapshot | null>
	accept(
		intent: PalMessageIntent,
		recipientRevision: number,
		conversationId?: SessionId,
	): Promise<PalMessageReceipt>
	route(key: PalRouteKey): Promise<PalRouteBinding | null>
	activate(binding: PalRouteBinding, context: PalVerificationContext): Promise<PalRouteBinding>
	claim(
		binding: PalRouteBinding,
		request: {
			readonly turnId: TurnId
			readonly generation: number
			readonly content: (message: PalInboxMessage) => string
		},
	): Promise<PalInboxMessage | null>
	recorded(
		message: PalInboxMessage,
		receipt: InboundDeliveryReceipt,
		context: PalVerificationContext,
	): Promise<PalInboxMessage>
	/** Only a trusted verifier that has fenced the prior writer may invoke this. */
	releaseUnrecorded(
		message: PalInboxMessage,
		context: PalVerificationContext,
	): Promise<PalInboxMessage>
}

/** A host ensures the exact pinned Pal root claim; opening does not repair a foreign log. */
export interface PalConversationAccess {
	readonly log: SessionLog
	readonly projectId: ProjectId
}

export interface PalVerificationContext {
	readonly binding: PalRouteBinding
	readonly access: PalConversationAccess
	readonly definition: PalDefinition
}

export interface PalMessageHostPort {
	ensureConversation(binding: PalRouteBinding, signal: AbortSignal): Promise<void>
	openConversation(binding: PalRouteBinding, signal: AbortSignal): Promise<PalConversationAccess>
	/** Hint only; failure cannot revoke a committed acceptance receipt. */
	notify?(recipient: PalAddress): void | Promise<void>
	wait?(binding: PalRouteBinding, signal: AbortSignal): Promise<void>
	/** Host owns normal query execution and real Pal/computer admission. */
	runConversation(
		binding: PalRouteBinding,
		source: DurableInboundSource,
		signal: AbortSignal,
	): Promise<void>
}

export type PalMessageAuthorization =
	| { readonly allow: true; readonly grant: PalMessageGrant }
	| { readonly allow: false; readonly reason: string }

export interface PalAuthorizationRequest {
	readonly phase: 'send' | 'deliver' | 'wake'
	readonly source: PalMessageSenderContext
	readonly recipient: PalAddress
	readonly routeKey: PalRouteKey
	readonly body: string
	readonly replyTo: string | null
}

export interface PalMessageBrokerOptions {
	readonly store: PalCommunicationStore
	readonly pals: PalStore
	/** Required current sender disclosure AND recipient receive policy. No permissive default. */
	readonly authorize: (request: PalAuthorizationRequest) => Promise<PalMessageAuthorization>
	readonly host?: PalMessageHostPort
	readonly now?: () => number
	readonly onNotificationError?: (
		error: unknown,
		receipt: PalMessageReceipt,
	) => void | Promise<void>
}

export interface PalMessageSender {
	/** Stable captured tool-call/outbox identity; retries must retain it. */
	send(input: {
		readonly operationId: string
		readonly recipient: PalAddress
		readonly body: string
		readonly dialogKey?: string
		readonly replyTo?: string
	}): Promise<PalMessageReceipt>
}

export type PalDispatchOutcome =
	| { readonly status: 'idle'; readonly reason: 'empty' | 'unresolved' }
	| { readonly status: 'blocked'; readonly reason: string }
	| { readonly status: 'ran'; readonly binding: PalRouteBinding }

export interface PalInboxSourceOptions {
	readonly store: PalCommunicationStore
	readonly pals: PalStore
	readonly binding: PalRouteBinding
	readonly host: PalMessageHostPort
	readonly authorize: PalMessageBrokerOptions['authorize']
}

export const PAL_MESSAGE_NAMESPACE = 'namzu-pal-message/1'

export function palMessageRef(message: Pick<PalInboxMessage, 'id' | 'digest'>): InboundDeliveryRef {
	return { namespace: PAL_MESSAGE_NAMESPACE, id: message.id, digest: message.digest }
}

export function authorizationRequest(
	message: PalMessageIntent,
	phase: PalAuthorizationRequest['phase'],
): PalAuthorizationRequest {
	return {
		phase,
		source: message.source,
		recipient: message.recipient,
		routeKey: message.routeKey,
		body: message.body,
		replyTo: message.replyTo,
	}
}

export function sameAddress(one: PalAddress, two: PalAddress): boolean {
	return one.tenantId === two.tenantId && one.palId === two.palId
}

export function currentRecipient(pals: PalStore, binding: PalRouteBinding): PalDefinition {
	const pal = pals.get(binding.key.recipient.palId)
	if (!pal || pal.paused) throw new Error('Recipient Pal is paused or unavailable.')
	return pals.getRevision(pal.id, binding.profileRevision)
}
