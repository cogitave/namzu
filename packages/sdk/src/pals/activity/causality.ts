import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SessionLogChain, type SessionLogEntry } from '../../store/session-log/chain.js'
import { stableDigest } from '../../utils/hash.js'
import {
	activityFactSchema,
	activityScopeSchema,
	ingressBindingSchema,
	ingressInboxSchema,
	ingressIntentDigest,
	ingressIntentId,
	ingressIntentSchema,
	ingressReceiptSchema,
} from '../communication/ingress-schema.js'
import { PAL_OBSERVATION_NAMESPACE, type PalIngressStore } from '../communication/ingress-types.js'
import type { PalStore } from '../types.js'
import { projectPalActivity } from './projection.js'
import type { PalActivityFact, PalActivityScope, PalActivitySourceOptions } from './types.js'

const requestMarkerSchema = z
	.object({
		type: z.literal('request_envelope'),
		iteration: z.literal(1),
		model: z.string().min(1).max(4096),
		systemPrompt: z.string(),
		toolNames: z.array(z.string().min(1).max(512)).max(16_384),
		toolSchemaDigest: z.string().regex(/^[a-f0-9]{16}$/),
	})
	.refine(
		(value) =>
			new Set(value.toolNames).size === value.toolNames.length &&
			(value.toolNames.length > 0 || value.toolSchemaDigest === stableDigest([])),
	)

export class PalActivityCausalityUnavailableError extends Error {
	override readonly name = 'PalActivityCausalityUnavailableError'
	constructor() {
		super('Complete owned original turn delivery evidence is required before activity publication.')
	}
}

export interface PalActivityCausalityOptions {
	readonly pals: PalStore
	readonly ingress: PalIngressStore
	readonly authorize: PalActivitySourceOptions['authorize']
	readonly openJournal: PalActivitySourceOptions['openJournal']
	/** Explicit original prefix budgets; exhaustion rejects rather than assuming independence. */
	readonly maxReadBytes: number
	readonly maxRecords: number
}

/**
 * Build a trusted causality port from original hash-verified records and exact recorded inbox
 * receipts. It resolves no client cursor and grants no wake/action authority. Early turn facts
 * wait for the first recorded provider request, after initial durable input acknowledgement.
 */
export function createPalActivityCausalityResolver(options: PalActivityCausalityOptions) {
	const { pals, ingress, authorize, openJournal } = options
	const maxReadBytes = z.number().int().positive().safe().parse(options.maxReadBytes)
	const maxRecords = z.number().int().positive().safe().parse(options.maxRecords)
	if (typeof authorize !== 'function' || typeof openJournal !== 'function')
		throw new TypeError(
			'Pal activity causality requires trusted observation and original journal ports.',
		)
	return async (
		inputScope: PalActivityScope,
		inputFact: PalActivityFact,
		signal: AbortSignal,
	): Promise<readonly string[]> => {
		const scope = Object.freeze(activityScopeSchema.parse(inputScope))
		const fact = Object.freeze(activityFactSchema.parse(inputFact))
		const unavailable = (): never => {
			throw new PalActivityCausalityUnavailableError()
		}
		const permission = async () => {
			signal.throwIfAborted()
			if ((await authorize(scope, signal)) !== true) unavailable()
			signal.throwIfAborted()
		}
		await permission()
		const definition = pals.getRevision(scope.palId, scope.profileRevision)
		const workspace = definition.workspace
		const journal = await openJournal(scope, signal)
		signal.throwIfAborted()
		if (journal.log.sessionId !== scope.sessionId) unavailable()
		const size = await journal.bytes.size()
		signal.throwIfAborted()
		await permission()
		if (!Number.isSafeInteger(size) || size < 1 || size > maxReadBytes) unavailable()
		const raw = Uint8Array.from(await journal.bytes.read(0, size))
		signal.throwIfAborted()
		if (raw.byteLength !== size || raw.at(-1) !== 10) unavailable()
		const entries: SessionLogEntry[] = []
		const chain = new SessionLogChain({ head: null, sessionId: scope.sessionId })
		let offset = 0
		let generation = 0
		while (offset < raw.length) {
			signal.throwIfAborted()
			if (entries.length >= maxRecords) unavailable()
			const end = raw.indexOf(10, offset)
			if (end < 0) unavailable()
			let entry: SessionLogEntry
			try {
				entry = chain.accept(raw.subarray(offset, end + 1), offset)
			} catch {
				return unavailable()
			}
			if (entry.record.gen < generation) unavailable()
			generation = entry.record.gen
			entries.push(entry)
			offset = end + 1
		}
		const root = entries[0]?.record
		if (
			root?.type !== 'session_started' ||
			root.parent ||
			root.forkedFrom ||
			root.tenantId !== scope.tenantId ||
			root.projectId !== scope.projectId ||
			root.cwd !== workspace ||
			root.origin?.protocol !== 'desktop' ||
			root.origin.externalSessionId !==
				JSON.stringify(['namzu-pal', scope.palId, scope.profileRevision, scope.sessionId])
		)
			unavailable()
		const scopeHash = createHash('sha256')
			.update(
				JSON.stringify([
					'pal-activity/1',
					scope.tenantId,
					scope.projectId,
					scope.palId,
					scope.profileRevision,
					scope.sessionId,
					workspace,
				]),
			)
			.digest('hex')
		const original = entries.find((e) => e.record.seq === fact.seq)
		if (
			!original ||
			!isDeepStrictEqual(projectPalActivity(original, scopeHash), fact) ||
			!fact.turnId
		)
			unavailable()
		const turnId = fact.turnId
		const firstRequest = entries.find(
			(e) => e.record.type === 'request_envelope' && e.record.turnId === turnId,
		)
		if (!firstRequest) return unavailable()
		if (!requestMarkerSchema.safeParse(firstRequest.record).success) return unavailable()
		// Initial inbox delivery follows turn_started; include that intake before classifying early facts.
		const through = Math.max(fact.seq, firstRequest.record.seq)
		const state = await ingress.readIngress({ tenantId: scope.tenantId, palId: scope.palId })
		signal.throwIfAborted()
		const trail = new Set<string>()
		for (const entry of entries) {
			const record = entry.record
			if (
				record.seq > through ||
				record.type !== 'message' ||
				record.turnId !== turnId ||
				record.role !== 'user'
			)
				continue
			// Resolving an external spill requires an independently bounded original spill port.
			if (record.spill) unavailable()
			const content = record.content as {
				role?: unknown
				content?: unknown
				source?: {
					type?: unknown
					kind?: unknown
					deliveryRef?: { namespace?: unknown; id?: unknown; digest?: unknown }
				}
			}
			const ref = content?.source?.deliveryRef
			if (
				content?.source?.kind === 'host-observation' &&
				ref?.namespace !== PAL_OBSERVATION_NAMESPACE
			)
				return unavailable()
			if (ref?.namespace !== PAL_OBSERVATION_NAMESPACE) continue
			const storedMessage = state?.messages.find((m) => m.id === ref.id)
			const parsedMessage = ingressInboxSchema.safeParse(storedMessage)
			if (!parsedMessage.success) return unavailable()
			const message = parsedMessage.data
			const {
				ordinal: _ordinal,
				routeId: _routeId,
				phase: _phase,
				claim: _claim,
				receipt: _receipt,
				...envelope
			} = message
			const canonical = ingressIntentSchema.safeParse(envelope)
			if (
				!canonical.success ||
				message.id !== ingressIntentId(canonical.data) ||
				message.digest !== ingressIntentDigest(canonical.data)
			)
				return unavailable()
			if (
				!message ||
				!('kind' in message) ||
				message.kind !== 'observation' ||
				message.phase !== 'recorded' ||
				!message.claim ||
				!message.receipt ||
				message.digest !== ref.digest ||
				message.receipt.ref.namespace !== PAL_OBSERVATION_NAMESPACE ||
				message.receipt.ref.id !== message.id ||
				message.receipt.ref.digest !== message.digest ||
				message.receipt.messageId !== record.messageId ||
				message.receipt.turnId !== turnId ||
				message.receipt.sessionId !== scope.sessionId ||
				message.receipt.claimId !== message.claim.id ||
				message.claim.turnId !== turnId ||
				message.claim.sessionId !== scope.sessionId ||
				message.claim.generation !== record.gen ||
				message.claim.content !== content.content ||
				content.role !== 'user' ||
				content.source?.type !== 'runtime-context' ||
				content.source.kind !== 'host-observation' ||
				message.receipt.through.pointer.seq < record.seq
			)
				return unavailable()
			const receipt = ingressReceiptSchema.parse(message.receipt)
			const covered = entries.find(
				(candidate) => candidate.record.seq === receipt.through.pointer.seq,
			)
			if (
				!covered ||
				!isDeepStrictEqual(covered.pointer, receipt.through.pointer) ||
				covered.record.gen !== receipt.through.gen ||
				receipt.through.bytes !== covered.pointer.offset + covered.pointer.length
			)
				return unavailable()
			const parsedRoute = ingressBindingSchema.safeParse(
				state?.routes.find((r) => r.id === message.routeId),
			)
			if (!parsedRoute.success) return unavailable()
			const route = parsedRoute.data
			if (
				!route ||
				route.phase !== 'active' ||
				!isDeepStrictEqual(route.key, message.routeKey) ||
				route.sessionId !== scope.sessionId ||
				route.profileRevision !== scope.profileRevision ||
				route.key.recipient.palId !== scope.palId ||
				route.key.recipient.tenantId !== scope.tenantId
			)
				unavailable()
			if (message && 'kind' in message && message.kind === 'observation')
				for (const id of message.subscriptionTrail) trail.add(id)
		}
		await permission()
		return Object.freeze([...trail])
	}
}
