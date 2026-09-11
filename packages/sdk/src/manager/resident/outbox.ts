import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ResidentAgendaState } from './agenda.js'
import { ResidentConflictError } from './store.js'

const time = z.number().int().nonnegative().safe().max(8_640_000_000_000_000)
const label = z.string().trim().min(1).max(256)

export const residentMessageInputSchema = z.object({
	id: z.string().uuid(),
	pursuitId: z.string().uuid(),
	destination: label,
	body: z
		.string()
		.min(1)
		.max(8_000)
		.refine((value) => value.trim().length > 0),
	notBefore: time,
})

/** @experimental Host-approved content and an opaque destination route, never credentials. */
export type ResidentMessageInput = Readonly<z.infer<typeof residentMessageInputSchema>>

export const residentOutboxMessageSchema = residentMessageInputSchema
	.extend({
		tenantId: z.string().uuid(),
		agentKey: z.string().min(1).max(200),
		sourceClaimId: z.string().uuid().nullable(),
		revision: z.number().int().positive().safe(),
		attempts: z.number().int().nonnegative().safe(),
		phase: z.enum(['pending', 'sending', 'acknowledged', 'cancelled']),
		claimId: z.string().uuid().nullable(),
		nextAttemptAt: time.nullable(),
		receiptId: label.nullable(),
		acknowledgedAt: time.nullable(),
		lastReason: z.string().trim().min(1).max(1_000).nullable(),
	})
	.superRefine((message, context) => {
		if (
			(message.phase === 'sending') !== (message.claimId !== null) ||
			(message.phase === 'pending') !== (message.nextAttemptAt !== null) ||
			(message.phase === 'acknowledged') !== (message.receiptId !== null) ||
			(message.phase === 'acknowledged') !== (message.acknowledgedAt !== null) ||
			(message.nextAttemptAt !== null && message.nextAttemptAt < message.notBefore) ||
			(message.phase !== 'pending' && message.attempts === 0)
		)
			context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid outbox lifecycle.' })
	})

/** @experimental Acknowledgment proves transport acceptance, not human reading. */
export type ResidentOutboxMessage = Readonly<z.infer<typeof residentOutboxMessageSchema>>

export const residentDeliveryOutcomeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('acknowledged'), receiptId: label }),
	z.object({
		kind: z.literal('not-accepted'),
		retryAt: time.nullable(),
		reason: z.string().trim().min(1).max(1_000),
	}),
])

/** @experimental Retry only with evidence of non-acceptance; null retryAt ends delivery. */
export type ResidentDeliveryOutcome = Readonly<z.infer<typeof residentDeliveryOutcomeSchema>>

/** @experimental Atomic admission and exact-claim settlement, without automatic claim expiry. */
export interface ResidentOutboxStore {
	read(): Promise<ResidentAgendaState | null>
	claimMessage(
		expected: ResidentAgendaState,
		id: string,
		now: number,
	): Promise<ResidentOutboxMessage>
	settleMessage(
		expected: ResidentOutboxMessage,
		outcome: ResidentDeliveryOutcome,
		now: number,
	): Promise<ResidentOutboxMessage>
}

/** @experimental A synchronous host policy, evaluated before claiming and again before sending. */
export type ResidentDeliveryGate = (
	message: ResidentOutboxMessage,
	now: number,
) =>
	| { readonly allow: true }
	| {
			readonly allow: false
			readonly nextCheckAt: number | null
			readonly reason: string
	  }

/** @experimental Bind an authorized route; forward message.id as the stable idempotency key. */
export type ResidentMessageTransport = (
	message: ResidentOutboxMessage,
	signal: AbortSignal,
) => Promise<ResidentDeliveryOutcome>

/** @experimental One dispatch admission, with no model invocation, polling or implicit retries. */
export interface ResidentDeliveryOptions {
	readonly signal: AbortSignal
	readonly gate: ResidentDeliveryGate
	readonly now?: () => number
}

/** @experimental An idle result never asserts a message reached its destination. */
export type ResidentDeliveryResult =
	| { readonly status: 'settled'; readonly message: ResidentOutboxMessage }
	| {
			readonly status: 'idle'
			readonly reason: 'paused' | 'unresolved' | 'empty' | 'not-due' | 'window' | 'contended'
			readonly nextCheckAt: number | null
	  }

/** Internal pure enqueue used in the same revision transaction as pursuit settlement. */
export function appendResidentMessage(
	state: ResidentAgendaState,
	input: ResidentMessageInput,
	sourceClaimId: string | null = null,
): readonly ResidentOutboxMessage[] {
	const checked = residentMessageInputSchema.parse(input)
	if (!state.pursuits.some((p) => p.id === checked.pursuitId))
		throw new Error('Outbox message references an unknown pursuit.')
	const messages = state.outbox ?? []
	const existing = messages.find((message) => message.id === checked.id)
	if (existing) {
		if (
			existing.pursuitId !== checked.pursuitId ||
			existing.destination !== checked.destination ||
			existing.body !== checked.body ||
			existing.notBefore !== checked.notBefore ||
			existing.sourceClaimId !== sourceClaimId
		)
			throw new Error('Outbox message ID already names a different immutable intent.')
		return messages
	}
	if (messages.length >= 128) throw new Error('Resident outbox capacity reached (128 intents).')
	return [
		...messages,
		Object.freeze(
			residentOutboxMessageSchema.parse({
				...checked,
				tenantId: state.tenantId,
				agentKey: state.agentKey,
				sourceClaimId,
				revision: 1,
				attempts: 0,
				phase: 'pending',
				claimId: null,
				nextAttemptAt: checked.notBefore,
				receiptId: null,
				acknowledgedAt: null,
				lastReason: null,
			}),
		),
	]
}

/** Internal exact-message transition; agenda storage owns exclusive admission. */
export function claimResidentOutboxMessage(
	message: ResidentOutboxMessage,
	now: number,
): ResidentOutboxMessage {
	time.parse(now)
	if (message.phase !== 'pending' || message.nextAttemptAt === null || message.nextAttemptAt > now)
		throw new ResidentConflictError()
	return Object.freeze(
		residentOutboxMessageSchema.parse({
			...message,
			revision: message.revision + 1,
			attempts: message.attempts + 1,
			phase: 'sending',
			claimId: randomUUID(),
			nextAttemptAt: null,
		}),
	)
}

/** Internal settlement; unknown failures deliberately have no transition. */
export function settleResidentOutboxMessage(
	message: ResidentOutboxMessage,
	outcome: ResidentDeliveryOutcome,
	now: number,
): ResidentOutboxMessage {
	time.parse(now)
	const checked = residentDeliveryOutcomeSchema.parse(outcome)
	if (message.phase !== 'sending' || message.claimId === null) throw new ResidentConflictError()
	if (checked.kind === 'not-accepted' && checked.retryAt !== null && checked.retryAt <= now)
		throw new TypeError('A delivery retry must be scheduled in the future.')
	return Object.freeze(
		residentOutboxMessageSchema.parse({
			...message,
			revision: message.revision + 1,
			claimId: null,
			...(checked.kind === 'acknowledged'
				? { phase: 'acknowledged', receiptId: checked.receiptId, acknowledgedAt: now }
				: {
						phase: checked.retryAt === null ? 'cancelled' : 'pending',
						nextAttemptAt: checked.retryAt,
						lastReason: checked.reason,
					}),
		}),
	)
}

function admission(gate: ResidentDeliveryGate, message: ResidentOutboxMessage, now: number) {
	const result = gate(message, now)
	if (result.allow === true) return result
	if (
		result.allow !== false ||
		typeof result.reason !== 'string' ||
		!result.reason.trim() ||
		result.reason.trim().length > 1_000
	)
		throw new TypeError('Invalid resident delivery gate result.')
	if (result.nextCheckAt !== null) {
		time.parse(result.nextCheckAt)
		if (result.nextCheckAt <= now) throw new TypeError('Delivery gate must defer into the future.')
	}
	return result
}

/**
 * @experimental Persist one send claim before calling a host-owned transport.
 * Throws, malformed outcomes and cancellation keep the claim unresolved. Stop
 * old executors and inspect effects before explicit settleMessage reconciliation.
 */
export async function deliverResidentMessage(
	store: ResidentOutboxStore,
	transport: ResidentMessageTransport,
	options: ResidentDeliveryOptions,
): Promise<ResidentDeliveryResult> {
	const { signal, gate } = options
	const clock = options.now ?? Date.now
	const now = () => time.parse(clock())
	signal.throwIfAborted()
	const state = await store.read()
	signal.throwIfAborted()
	if (!state) throw new Error('Create the resident agenda before delivering messages.')
	const idle = (
		reason: Extract<ResidentDeliveryResult, { status: 'idle' }>['reason'],
		nextCheckAt: number | null = null,
	): ResidentDeliveryResult => ({ status: 'idle', reason, nextCheckAt })
	if (state.paused) return idle('paused')
	const messages = state.outbox ?? []
	if (messages.some((message) => message.phase === 'sending')) return idle('unresolved')
	const pending = messages.filter((message) => message.phase === 'pending')
	if (!pending.length) return idle('empty')
	let nextCheckAt: number | null = null
	let gated = false
	const at = now()
	for (const message of pending.sort(
		(a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || a.id.localeCompare(b.id),
	)) {
		if (message.nextAttemptAt !== null && message.nextAttemptAt > at) {
			nextCheckAt = Math.min(nextCheckAt ?? Number.POSITIVE_INFINITY, message.nextAttemptAt)
			continue
		}
		const permission = admission(gate, message, at)
		signal.throwIfAborted()
		if (!permission.allow) {
			gated = true
			if (permission.nextCheckAt !== null)
				nextCheckAt = Math.min(nextCheckAt ?? Number.POSITIVE_INFINITY, permission.nextCheckAt)
			continue
		}
		let claimed: ResidentOutboxMessage
		try {
			claimed = await store.claimMessage(state, message.id, now())
		} catch (error) {
			if (error instanceof ResidentConflictError) return idle('contended')
			throw error
		}
		signal.throwIfAborted()
		const fresh = await store.read()
		signal.throwIfAborted()
		const current = fresh?.outbox?.find((item) => item.id === claimed.id)
		if (!current || current.revision !== claimed.revision || current.claimId !== claimed.claimId)
			return idle('contended')
		// A pause or closing window during admission must not start the transport.
		const checkedAt = now()
		const permissionNow = fresh?.paused
			? {
					allow: false as const,
					nextCheckAt: checkedAt + 1,
					reason: 'Resident agenda paused before send.',
				}
			: admission(gate, claimed, checkedAt)
		if (!permissionNow.allow) {
			// Transport has not been entered: scheduling another check has no remote effect.
			await store.settleMessage(
				claimed,
				{
					kind: 'not-accepted',
					retryAt: permissionNow.nextCheckAt ?? checkedAt + 1,
					reason: permissionNow.reason,
				},
				checkedAt,
			)
			return idle(fresh?.paused ? 'paused' : 'window', permissionNow.nextCheckAt)
		}
		signal.throwIfAborted()
		const outcome = await transport(claimed, signal)
		signal.throwIfAborted()
		return { status: 'settled', message: await store.settleMessage(claimed, outcome, now()) }
	}
	return idle(gated ? 'window' : 'not-due', nextCheckAt)
}
