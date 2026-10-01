import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { InboundDeliveryReceipt } from '../../types/message/inbound-delivery.js'
import { generateSessionId } from '../../utils/id.js'
import {
	addressSchema,
	addressTuple,
	hash,
	intentDigest,
	intentSchema,
	messageId,
	operationReservationSchema,
	receiptSchema,
	routeId,
	routeKeySchema,
	snapshotSchema,
} from './schema.js'
import {
	type PalAddress,
	type PalCommunicationSnapshot,
	type PalCommunicationStore,
	type PalInboxMessage,
	type PalMessageIntent,
	type PalMessageReceipt,
	type PalRouteBinding,
	type PalRouteKey,
	type PalVerificationContext,
	palMessageRef,
	sameAddress,
} from './types.js'
import { verifyConversation, verifyRecorded, verifyUnrecorded } from './verify.js'

export class PalCommunicationConflictError extends Error {
	override readonly name = 'PalCommunicationConflictError'
}

function frozen<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) frozen(child)
		Object.freeze(value)
	}
	return value
}
function receipt(message: PalInboxMessage, binding: PalRouteBinding): PalMessageReceipt {
	return frozen({
		id: message.id,
		digest: message.digest,
		recipient: message.recipient,
		routeId: binding.id,
		sessionId: binding.sessionId,
		ordinal: message.ordinal,
		status: 'accepted',
	})
}
function conflict(message = 'Pal communication state changed; reload before retrying.'): never {
	throw new PalCommunicationConflictError(message)
}

interface OperationReservation {
	readonly revision: 1
	readonly intent: PalMessageIntent
	readonly recipientRevision: number
	readonly conversationId: SessionId | null
}

/** Immutable local commits support process restart; no power-loss durability is claimed. */
export class DiskPalCommunicationStore implements PalCommunicationStore {
	private readonly root: string
	private readonly secure: (path: string) => void
	private readonly maxPending: number
	private readonly operations = new DiskRevisionRecordStore<OperationReservation>(
		defineSchema({ kind: 'pal-message-operation', current: 1, migrations: {} }),
		'Pal source operation',
		(record) => record.revision,
	)
	private readonly records = new DiskRevisionRecordStore<PalCommunicationSnapshot>(
		defineSchema({ kind: 'pal-communication', current: 1, migrations: {} }),
		'Pal communication',
		(record) => record.revision,
	)
	constructor(options: {
		root: string
		secureDirectory?: (path: string) => void
		maxPending?: number
	}) {
		this.root = resolve(options.root)
		this.secure =
			options.secureDirectory ??
			((path) => {
				if (process.platform !== 'win32') chmodSync(path, 0o700)
			})
		this.maxPending = options.maxPending ?? 256
		if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
			throw new Error('maxPending must be a positive safe integer.')
		this.directory(this.root)
	}
	private directory(path: string): void {
		mkdirSync(path, { recursive: true, mode: 0o700 })
		const stat = lstatSync(path)
		if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
			throw new Error('Pal communication requires a real directory without aliases.')
		this.secure(path)
	}
	private location(recipient: PalAddress) {
		const address = addressSchema.parse(recipient)
		this.directory(this.root)
		const directory = join(this.root, hash(addressTuple(address)))
		return this.commitLocation(directory)
	}
	private commitLocation(directory: string) {
		this.directory(directory)
		const revisionsDir = join(directory, 'revisions')
		this.directory(revisionsDir)
		for (const name of readdirSync(revisionsDir)) {
			if (!/^[1-9][0-9]*\.json$/u.test(name)) continue
			const stat = lstatSync(join(revisionsDir, name))
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error('Pal communication commit must be a real file.')
		}
		return {
			legacyPath: join(directory, 'state.json'),
			revisionsDir,
			publishLegacyProjection: false,
		}
	}
	private checkedIntent(value: unknown): PalMessageIntent {
		const intent = intentSchema.parse(value)
		if (
			intent.id !== messageId(intent.source, intent.operationId) ||
			intent.digest !== intentDigest(intent) ||
			!sameAddress(intent.source.address, intent.routeKey.sender) ||
			intent.source.conversationId !== intent.routeKey.senderConversationId ||
			!sameAddress(intent.recipient, intent.routeKey.recipient)
		)
			throw new Error('Invalid immutable Pal source operation.')
		return frozen(intent)
	}
	/** First bind the source call globally. Exact retry can finish the recipient commit. */
	private async reserveOperation(
		input: PalMessageIntent,
		recipientRevision: number,
		conversationId?: SessionId,
	): Promise<OperationReservation> {
		const intent = this.checkedIntent(input)
		this.directory(this.root)
		const operationsRoot = join(this.root, 'operations')
		this.directory(operationsRoot)
		const location = this.commitLocation(join(operationsRoot, intent.id))
		const proposed = operationReservationSchema.parse({
			revision: 1,
			intent,
			recipientRevision,
			conversationId: conversationId ?? null,
		})
		const checked = (record: unknown): OperationReservation => {
			const reserved = operationReservationSchema.parse(record)
			const retained = this.checkedIntent(reserved.intent)
			if (retained.id !== intent.id || retained.digest !== intent.digest)
				conflict('Source operation already names a different immutable intent or recipient.')
			return frozen(reserved)
		}
		const existing = await this.operations.read(location)
		if (existing) return checked(existing)
		try {
			return await this.operations.transact(location, (current) => {
				if (current !== null) conflict('Source operation was reserved concurrently.')
				return { record: proposed, result: frozen(proposed) }
			})
		} catch (error) {
			if (!(error instanceof PalCommunicationConflictError)) throw error
			const winner = await this.operations.read(location)
			if (winner === null) throw error
			return checked(winner)
		}
	}
	private checked(record: unknown, recipient: PalAddress): PalCommunicationSnapshot {
		const state = snapshotSchema.parse(record) as PalCommunicationSnapshot
		if (!sameAddress(state.recipient, recipient))
			throw new Error('Foreign recipient communication record.')
		const routes = new Map<string, PalRouteBinding>()
		for (const route of state.routes) {
			if (
				!sameAddress(route.key.recipient, recipient) ||
				route.id !== routeId(route.key) ||
				routes.has(route.id)
			)
				throw new Error('Invalid Pal route binding.')
			routes.set(route.id, route)
		}
		const ids = new Set<string>()
		let ordinal = 0
		let claimed = false
		for (const message of state.messages) {
			const binding = routes.get(message.routeId)
			if (
				!binding ||
				!isDeepStrictEqual(binding.key, message.routeKey) ||
				!sameAddress(message.recipient, recipient) ||
				message.id !== messageId(message.source, message.operationId) ||
				message.digest !== intentDigest(message) ||
				!sameAddress(message.source.address, message.routeKey.sender) ||
				message.source.conversationId !== message.routeKey.senderConversationId ||
				ids.has(message.id) ||
				message.ordinal <= ordinal
			)
				throw new Error('Invalid immutable Pal incoming intent.')
			ids.add(message.id)
			ordinal = message.ordinal
			if (
				(message.phase === 'claimed' || message.phase === 'recorded') !==
					(message.claim !== null) ||
				(message.phase === 'recorded') !== (message.receipt !== null)
			)
				throw new Error('Invalid Pal delivery state.')
			if (message.claim && message.claim.sessionId !== binding.sessionId)
				throw new Error('Foreign conversation delivery claim.')
			if (message.phase === 'claimed') {
				if (claimed) throw new Error('Recipient has multiple unresolved delivery claims.')
				claimed = true
			}
			if (message.receipt) this.checkedReceipt(message, message.receipt)
		}
		return frozen(state)
	}
	async read(recipient: PalAddress): Promise<PalCommunicationSnapshot | null> {
		const address = addressSchema.parse(recipient)
		const value = await this.records.read(this.location(address))
		return value === null ? null : this.checked(value, address)
	}
	private async change<R>(
		recipient: PalAddress,
		mutate: (state: PalCommunicationSnapshot | null) => {
			state: PalCommunicationSnapshot | null
			result: R
		},
	): Promise<R> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const current = await this.read(recipient)
			const proposal = mutate(current)
			if (proposal.state === null) return proposal.result
			const next = this.checked(
				{ ...proposal.state, revision: (current?.revision ?? 0) + 1 },
				recipient,
			)
			try {
				return await this.records.transact(this.location(recipient), (record) => {
					if ((record?.revision ?? 0) !== (current?.revision ?? 0)) conflict()
					return { record: next, result: proposal.result }
				})
			} catch (error) {
				if (!(error instanceof PalCommunicationConflictError)) throw error
			}
		}
		return conflict('Pal communication is contended; retry the same immutable operation.')
	}
	async accept(
		input: PalMessageIntent,
		recipientRevision: number,
		conversationId?: SessionId,
	): Promise<PalMessageReceipt> {
		if (!Number.isSafeInteger(recipientRevision) || recipientRevision < 1)
			throw new Error('Invalid profile revision.')
		const reservation = await this.reserveOperation(input, recipientRevision, conversationId)
		const intent = reservation.intent
		const pinnedConversationId = reservation.conversationId
		const id = routeId(intent.routeKey)
		const sessionId = pinnedConversationId ?? generateSessionId()
		return this.change(intent.recipient, (current) => {
			const routes = current?.routes ?? []
			let binding = routes.find((r) => r.id === id)
			if (
				binding &&
				(!isDeepStrictEqual(binding.key, intent.routeKey) ||
					(pinnedConversationId !== null && binding.sessionId !== pinnedConversationId))
			)
				conflict('Route identity names another immutable conversation.')
			const existing = current?.messages.find((m) => m.id === intent.id)
			if (existing) {
				if (existing.digest !== intent.digest || !binding)
					conflict('Message identity names a different immutable intent.')
				return { state: null, result: receipt(existing, binding) }
			}
			if ((current?.messages.filter((m) => m.phase !== 'recorded').length ?? 0) >= this.maxPending)
				throw new Error('Pal incoming queue is full; retry after pending messages are recorded.')
			binding ??= {
				id,
				key: intent.routeKey,
				sessionId,
				profileRevision: reservation.recipientRevision,
				revision: 1,
				phase: 'reserved',
			}
			const message: PalInboxMessage = {
				...intent,
				ordinal: (current?.messages.at(-1)?.ordinal ?? 0) + 1,
				routeId: id,
				phase: 'pending',
				claim: null,
				receipt: null,
			}
			return {
				state: {
					recipient: intent.recipient,
					revision: 1,
					routes: routes.some((r) => r.id === id) ? routes : [...routes, binding],
					messages: [...(current?.messages ?? []), message],
				},
				result: receipt(message, binding),
			}
		})
	}
	async route(key: PalRouteKey): Promise<PalRouteBinding | null> {
		const parsed = routeKeySchema.parse(key)
		return (await this.read(parsed.recipient))?.routes.find((r) => r.id === routeId(parsed)) ?? null
	}
	async activate(
		binding: PalRouteBinding,
		context: PalVerificationContext,
	): Promise<PalRouteBinding> {
		if (!isDeepStrictEqual(context.binding, binding))
			throw new Error('Foreign route activation context.')
		await verifyConversation(context)
		return this.change(binding.key.recipient, (state) => {
			const current = state?.routes.find((r) => r.id === binding.id)
			if (!state || !current || !isDeepStrictEqual(current, binding))
				conflict('Route claim changed.')
			if (current.phase === 'active') return { state: null, result: current }
			const next: PalRouteBinding = { ...current, phase: 'active', revision: current.revision + 1 }
			return {
				state: { ...state, routes: state.routes.map((r) => (r.id === current.id ? next : r)) },
				result: frozen(next),
			}
		})
	}
	async claim(
		binding: PalRouteBinding,
		request: { turnId: TurnId; generation: number; content: (message: PalInboxMessage) => string },
	): Promise<PalInboxMessage | null> {
		const claimId = randomUUID()
		return this.change(binding.key.recipient, (state) => {
			if (!state || state.messages.some((m) => m.phase === 'claimed'))
				return { state: null, result: null }
			const current = state.routes.find((r) => r.id === binding.id)
			if (!current || current.phase !== 'active' || !isDeepStrictEqual(current, binding))
				conflict('Route is not active.')
			const message = state.messages.find((m) => m.routeId === binding.id && m.phase === 'pending')
			if (!message) return { state: null, result: null }
			const next: PalInboxMessage = {
				...message,
				phase: 'claimed',
				claim: {
					id: claimId,
					sessionId: binding.sessionId as SessionId,
					turnId: request.turnId,
					generation: request.generation,
					content: request.content(message),
				},
			}
			return {
				state: { ...state, messages: state.messages.map((m) => (m.id === next.id ? next : m)) },
				result: frozen(next),
			}
		})
	}
	private checkedReceipt(
		message: PalInboxMessage,
		input: InboundDeliveryReceipt,
	): InboundDeliveryReceipt {
		const value = receiptSchema.parse(input) as InboundDeliveryReceipt
		if (
			!message.claim ||
			!isDeepStrictEqual(value.ref, palMessageRef(message)) ||
			value.claimId !== message.claim.id ||
			value.sessionId !== message.claim.sessionId ||
			value.turnId !== message.claim.turnId ||
			value.through.gen < message.claim.generation ||
			value.through.bytes < value.through.pointer.offset + value.through.pointer.length
		)
			throw new Error('Receipt does not match the exact Pal delivery claim.')
		return value
	}
	async recorded(
		message: PalInboxMessage,
		input: InboundDeliveryReceipt,
		context: PalVerificationContext,
	): Promise<PalInboxMessage> {
		const value = this.checkedReceipt(message, input)
		await verifyRecorded(message, value, context)
		return this.changeMessage(message, (current) => {
			if (current.phase === 'recorded') {
				if (!isDeepStrictEqual(current.receipt, value))
					conflict('Recorded delivery has another receipt.')
				return current
			}
			return { ...current, phase: 'recorded', receipt: value }
		})
	}
	async releaseUnrecorded(
		message: PalInboxMessage,
		context: PalVerificationContext,
	): Promise<PalInboxMessage> {
		await verifyUnrecorded(message, context)
		return this.changeMessage(message, (current) => ({
			...current,
			phase: 'pending',
			claim: null,
			receipt: null,
		}))
	}
	private async changeMessage(
		message: PalInboxMessage,
		mutate: (current: PalInboxMessage) => PalInboxMessage,
	): Promise<PalInboxMessage> {
		return this.change(message.recipient, (state) => {
			const current = state?.messages.find((m) => m.id === message.id)
			if (
				!state ||
				!current ||
				!message.claim ||
				!isDeepStrictEqual(current.claim, message.claim) ||
				current.digest !== message.digest ||
				(current.phase !== 'claimed' && current.phase !== 'recorded')
			)
				conflict('Delivery claim changed; a stale claimant cannot settle it.')
			const next = frozen(mutate(current))
			if (next === current) return { state: null, result: current }
			if (current.phase === 'recorded' && next.phase !== 'recorded')
				conflict('Recorded delivery cannot be retried.')
			return {
				state: { ...state, messages: state.messages.map((m) => (m.id === next.id ? next : m)) },
				result: next,
			}
		})
	}
}
