import type { SessionId } from '../../types/ids/index.js'
import type {
	InboundDeliveryReceipt,
	InboundDeliveryRef,
} from '../../types/message/inbound-delivery.js'
import type {
	PalChannelIdentity,
	PalChannelIntent,
	PalChannelSource,
	PalIngressAcceptanceReceipt,
	PalIngressHostPort,
	PalIngressStore,
} from '../communication/ingress-types.js'
import type { PalAddress, PalMessageAuthorization } from '../communication/types.js'
import type { PalStore } from '../types.js'

/** Host-selected connection identity. Credentials belong only to the verifier closure. */
export interface PalChannelConnection {
	readonly tenantId: PalAddress['tenantId']
	readonly provider: string
	readonly connectionId: string
	readonly externalTenantId: string
}

export interface PalChannelVerifiedIdentity {
	readonly externalTenantId: string
	readonly nativeConversationId: string
	readonly nativeChannelId: string | null
	readonly nativeThreadId: string | null
	readonly actorId: string
	readonly eventId: string
}

/** Only new, authenticated messages enter the inbox. Edits and service events require another port. */
export interface PalChannelVerifiedMessage extends PalChannelVerifiedIdentity {
	readonly kind: 'message'
	readonly body: string
}

/** Authentication must cover the action reference, identity and exact action payload. */
export interface PalChannelVerifiedAction extends PalChannelVerifiedIdentity {
	readonly kind: 'action'
	readonly deliveryRef: InboundDeliveryRef
	readonly actionId: string
	readonly payloadDigest: string
	/** Exact authenticated JSON payload; the host action port must parse its native action schema. */
	readonly payload: string
}

export type PalChannelVerifiedEvent = PalChannelVerifiedMessage | PalChannelVerifiedAction

/** Required trusted host callback; raw events cannot select a connection or its credentials. */
export type PalChannelVerifier = (
	raw: unknown,
	connection: PalChannelConnection,
	signal: AbortSignal,
) => Promise<PalChannelVerifiedEvent>

export interface PalChannelRouteDecision {
	readonly v: 1
	readonly revision: 1
	readonly identity: PalChannelIdentity
	readonly recipient: PalAddress
	readonly profileRevision: number
}

/** One immutable decision per tenant and full native tuple. The inbox owns the actual session. */
export interface PalChannelRoutes {
	get(
		connection: PalChannelConnection,
		identity: PalChannelIdentity,
	): Promise<PalChannelRouteDecision | null>
	reserve(decision: PalChannelRouteDecision): Promise<PalChannelRouteDecision>
}

export interface PalChannelAuthorizationRequest {
	readonly phase: 'accept' | 'deliver' | 'wake'
	readonly kind: 'channel'
	readonly source: PalChannelSource
	readonly recipient: PalAddress
	readonly routeKey: PalChannelIntent['routeKey']
	readonly body: string
	readonly replyTo: null
}

export interface PalChannelIngressOptions {
	readonly connection: PalChannelConnection
	readonly verify: PalChannelVerifier
	readonly routes: PalChannelRoutes
	readonly store: PalIngressStore
	readonly pals: PalStore
	/** Host selection is used only before the first immutable route decision. */
	readonly selectRecipient: (
		event: PalChannelVerifiedMessage,
		connection: PalChannelConnection,
	) => Promise<PalAddress>
	readonly authorize: (request: PalChannelAuthorizationRequest) => Promise<PalMessageAuthorization>
	readonly host?: PalIngressHostPort
	readonly now?: () => number
	readonly onNotificationError?: (
		error: unknown,
		receipt: PalIngressAcceptanceReceipt,
	) => void | Promise<void>
}

export interface PalChannelExecutionContext {
	readonly recipient: PalAddress
	readonly sessionId: SessionId
	readonly profileRevision: number
}

export interface PalChannelRouteAuthorizationRequest {
	readonly phase: 'reply' | 'action'
	readonly message: PalChannelIntent
	readonly context: PalChannelExecutionContext
	/** Reply uses its triggering event actor; actions authenticate their current actor independently. */
	readonly actorId: string
	readonly action?: PalChannelVerifiedAction
}

export interface PalChannelResolvedRoute {
	readonly connection: PalChannelConnection
	readonly identity: PalChannelIdentity
	readonly deliveryRef: InboundDeliveryRef
	readonly recordedReceipt: InboundDeliveryReceipt
	readonly eventActorId: string
	readonly currentActorId: string
	readonly context: PalChannelExecutionContext
}

export interface PalChannelRouterOptions {
	readonly connection: PalChannelConnection
	readonly verify: PalChannelVerifier
	readonly store: PalIngressStore
	readonly pals: PalStore
	readonly host: PalIngressHostPort
	readonly authorize: (
		request: PalChannelRouteAuthorizationRequest,
	) => Promise<PalMessageAuthorization>
	/** Must durably consume an exact native action once and confirm its result. No transport default. */
	readonly actions?: PalChannelActionPort
}

export interface PalChannelActionContext {
	readonly route: PalChannelResolvedRoute
	readonly action: PalChannelVerifiedAction
}

export interface PalChannelActionPort {
	execute(context: PalChannelActionContext, signal: AbortSignal): Promise<PalChannelActionResult>
}

export interface PalChannelActionResult {
	readonly status: 'applied' | 'rejected'
	readonly receiptId: string
}
