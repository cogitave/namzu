import type { SessionLogHead } from '../../store/session-log/core.js'
import type { MessageId, SessionId, TurnId } from '../ids/index.js'
import type { RuntimeContextMessageSource, UserMessage } from './index.js'

/** Host provenance only; this reference grants no operator authority. */
export interface InboundDeliveryRef {
	readonly namespace: string
	readonly id: string
	readonly digest: string
}

/** Bounded validation for persisted or JavaScript-authored delivery references. */
export function isInboundDeliveryRef(value: unknown): value is InboundDeliveryRef {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const candidate = value as Record<string, unknown>
	return ['namespace', 'id', 'digest'].every((key) => {
		const field = candidate[key]
		return (
			typeof field === 'string' &&
			field.length > 0 &&
			field.length <= 512 &&
			[...field].every(
				(character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
			)
		)
	})
}

/** Durable delivery carries host context and cannot acquire operator authority. */
export type DurableInboundMessage = UserMessage & {
	readonly source: RuntimeContextMessageSource & {
		readonly kind: Exclude<RuntimeContextMessageSource['kind'], 'steering'>
		readonly deliveryRef: InboundDeliveryRef
	}
}

export interface InboundDeliveryClaim {
	readonly claimId: string
	readonly ref: InboundDeliveryRef
	readonly message: DurableInboundMessage
}

/** Exact ordinary session-log append, flushed before the host acknowledges it. */
export interface InboundDeliveryReceipt {
	readonly claimId: string
	readonly ref: InboundDeliveryRef
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly messageId: MessageId
	readonly through: SessionLogHead
}

/** Host-owned durable input. Claim, write and acknowledgement failures stop execution. */
export interface DurableInboundSource {
	claim(context: {
		readonly sessionId: SessionId
		readonly turnId: TurnId
		readonly signal: AbortSignal
	}): Promise<readonly InboundDeliveryClaim[]>
	recorded(receipts: readonly InboundDeliveryReceipt[]): Promise<void>
	/** Wake only. An aborted wait must remove its listener. */
	wait?(signal: AbortSignal): Promise<void>
}
