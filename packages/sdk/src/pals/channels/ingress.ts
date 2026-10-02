import { isDeepStrictEqual } from 'node:util'
import {
	ingressIntentDigest,
	ingressIntentId,
	ingressIntentSchema,
} from '../communication/ingress-schema.js'
import type { PalChannelIdentity, PalChannelIntent } from '../communication/ingress-types.js'
import { addressSchema, freezeCommunicationValue } from '../communication/schema.js'
import {
	captureConnection,
	checkedDecision,
	checkedIdentity,
	verifiedMessageSchema,
} from './schema.js'
import type { PalChannelAuthorizationRequest, PalChannelIngressOptions } from './types.js'

/** Authenticated channel ingress. Raw event fields never choose host credentials or Namzu identities. */
export class PalChannelIngress {
	private readonly connection
	private readonly options: PalChannelIngressOptions
	constructor(options: PalChannelIngressOptions) {
		if (
			typeof options.verify !== 'function' ||
			typeof options.authorize !== 'function' ||
			typeof options.selectRecipient !== 'function'
		)
			throw new Error(
				'Channel ingress requires trusted verification, target selection and current authorization.',
			)
		this.connection = captureConnection(options.connection)
		this.options = Object.freeze({ ...options })
	}
	async accept(raw: unknown, signal: AbortSignal = new AbortController().signal) {
		signal.throwIfAborted()
		// Capture before the verifier's first asynchronous boundary, including JavaScript host input.
		const event = freezeCommunicationValue(
			verifiedMessageSchema.parse(
				await this.options.verify(structuredClone(raw), this.connection, signal),
			),
		)
		signal.throwIfAborted()
		const source = checkedIdentity(this.connection, {
			externalTenantId: event.externalTenantId,
			nativeConversationId: event.nativeConversationId,
			nativeChannelId: event.nativeChannelId,
			nativeThreadId: event.nativeThreadId,
			actorId: event.actorId,
			eventId: event.eventId,
			kind: 'channel',
			tenantId: this.connection.tenantId,
			provider: this.connection.provider,
			connectionId: this.connection.connectionId,
		})
		const identity: PalChannelIdentity = {
			provider: source.provider,
			connectionId: source.connectionId,
			externalTenantId: source.externalTenantId,
			nativeConversationId: source.nativeConversationId,
			nativeChannelId: source.nativeChannelId,
			nativeThreadId: source.nativeThreadId,
		}
		const { routes, pals, store } = this.options
		const existing = await routes.get(this.connection, identity)
		let decision = existing ? checkedDecision(existing) : null
		if (!decision) {
			const recipient = freezeCommunicationValue(
				addressSchema.parse(await this.options.selectRecipient(event, this.connection)),
			)
			if (recipient.tenantId !== this.connection.tenantId)
				throw new Error('Cross-tenant channel routing is refused.')
			const pal = pals.get(recipient.palId)
			if (!pal) throw new Error('Channel recipient Pal is unavailable.')
			decision = checkedDecision({
				v: 1,
				revision: 1,
				identity,
				recipient,
				profileRevision: pal.revision,
			})
		}
		const request: PalChannelAuthorizationRequest = freezeCommunicationValue({
			phase: 'accept',
			kind: 'channel',
			source,
			recipient: decision.recipient,
			routeKey: {
				v: 1,
				kind: 'channel',
				...identity,
				recipient: decision.recipient,
			},
			body: event.body,
			replyTo: null,
		})
		let allowed = freezeCommunicationValue(structuredClone(await this.options.authorize(request)))
		signal.throwIfAborted()
		if (allowed.allow !== true) throw new Error(`Channel ingress refused: ${allowed.reason}`)
		// Only authorized traffic can publish a routing decision. Concurrent first events share one target.
		const reserved = checkedDecision(await routes.reserve(decision))
		if (!isDeepStrictEqual(reserved, decision))
			throw new Error('Channel routing decision changed during acceptance.')
		decision = reserved
		pals.getRevision(decision.recipient.palId, decision.profileRevision)
		if (!pals.get(decision.recipient.palId))
			throw new Error('Channel recipient Pal is unavailable.')
		// Routing publication can await another process. Re-read event authority before committing its input.
		allowed = freezeCommunicationValue(structuredClone(await this.options.authorize(request)))
		signal.throwIfAborted()
		if (allowed.allow !== true) throw new Error(`Channel ingress refused: ${allowed.reason}`)
		const intent = {
			kind: 'channel' as const,
			source,
			recipient: decision.recipient,
			routeKey: request.routeKey,
			body: event.body,
			replyTo: null,
			operationId: source.eventId,
			grant: allowed.grant,
			createdAt: (this.options.now ?? Date.now)(),
		}
		const identified = { ...intent, id: ingressIntentId(intent) }
		const immutable = freezeCommunicationValue(
			ingressIntentSchema.parse({
				...identified,
				digest: ingressIntentDigest(identified),
			}),
		) as PalChannelIntent
		signal.throwIfAborted()
		const receipt = await store.acceptIngress(immutable, decision.profileRevision)
		const binding = await store.routeIngress(immutable.routeKey)
		if (
			!binding ||
			binding.sessionId !== receipt.sessionId ||
			binding.profileRevision !== decision.profileRevision
		)
			throw new Error('Channel acceptance does not match its immutable target binding.')
		const report = (error: unknown) => {
			try {
				void Promise.resolve(this.options.onNotificationError?.(error, receipt)).catch(
					() => undefined,
				)
			} catch {
				/* Committed receipt remains accepted. */
			}
		}
		try {
			void Promise.resolve(this.options.host?.notify?.(decision.recipient)).catch(report)
		} catch (error) {
			report(error)
		}
		return receipt
	}
}
