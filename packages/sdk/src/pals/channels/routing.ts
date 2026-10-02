import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SessionId } from '../../types/ids/index.js'
import type { InboundDeliveryRef } from '../../types/message/inbound-delivery.js'
import { isEntityId } from '../../utils/id.js'
import { ingressInboxSchema } from '../communication/ingress-schema.js'
import type { PalChannelIntent } from '../communication/ingress-types.js'
import { PAL_CHANNEL_NAMESPACE, ingressMessageRef } from '../communication/ingress-types.js'
import { addressSchema, freezeCommunicationValue, label } from '../communication/schema.js'
import { verifyIngressRecorded } from '../communication/verify.js'
import { captureConnection, nativeTuple, verifiedActionSchema } from './schema.js'
import type {
	PalChannelExecutionContext,
	PalChannelResolvedRoute,
	PalChannelRouterOptions,
	PalChannelVerifiedAction,
} from './types.js'

const contextSchema = z
	.object({
		recipient: addressSchema,
		sessionId: z.custom<SessionId>((value) => isEntityId(value, 'session')),
		profileRevision: z.number().int().positive().safe(),
	})
	.strict()
const refSchema = z
	.object({
		namespace: z.literal(PAL_CHANNEL_NAMESPACE),
		id: z.string().regex(/^[a-f0-9]{64}$/),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()

/** Resolves original authenticated destinations. It does not imply remote delivery. */
export class PalChannelRouter {
	private readonly options: PalChannelRouterOptions
	private readonly connection
	constructor(options: PalChannelRouterOptions) {
		if (typeof options.verify !== 'function' || typeof options.authorize !== 'function')
			throw new Error('Channel routing requires trusted verification and current authorization.')
		this.options = Object.freeze({ ...options })
		this.connection = captureConnection(options.connection)
	}
	private assertRecipient(context: PalChannelExecutionContext) {
		if (context.recipient.tenantId !== this.connection.tenantId)
			throw new Error('Foreign channel response tenant.')
		const pal = this.options.pals.get(context.recipient.palId)
		if (!pal || pal.paused) throw new Error('Channel response Pal is paused or unavailable.')
		return this.options.pals.getRevision(pal.id, context.profileRevision)
	}
	private async recorded(
		input: InboundDeliveryRef,
		context: PalChannelExecutionContext,
		signal: AbortSignal,
	) {
		const ref = freezeCommunicationValue(refSchema.parse(input))
		const definition = this.assertRecipient(context)
		const snapshot = await this.options.store.readIngress(context.recipient)
		const found = snapshot?.messages.find((message) => message.id === ref.id)
		if (!found) throw new Error('Channel response does not name an accepted delivery.')
		const message = freezeCommunicationValue(ingressInboxSchema.parse(found))
		if (
			!('kind' in message) ||
			message.kind !== 'channel' ||
			message.phase !== 'recorded' ||
			!message.receipt ||
			!isDeepStrictEqual(ingressMessageRef(message), ref)
		)
			throw new Error('Channel response requires the exact recorded channel delivery.')
		if (
			message.source.tenantId !== this.connection.tenantId ||
			message.source.provider !== this.connection.provider ||
			message.source.connectionId !== this.connection.connectionId ||
			message.source.externalTenantId !== this.connection.externalTenantId
		)
			throw new Error('Channel response belongs to another connection.')
		if (!isDeepStrictEqual(nativeTuple(message.source), nativeTuple(message.routeKey)))
			throw new Error('Channel message source does not match its original native route.')
		const binding = await this.options.store.routeIngress(message.routeKey)
		if (
			!binding ||
			binding.id !== message.routeId ||
			binding.phase !== 'active' ||
			binding.sessionId !== context.sessionId ||
			binding.profileRevision !== context.profileRevision ||
			binding.key.recipient.palId !== context.recipient.palId ||
			binding.key.recipient.tenantId !== context.recipient.tenantId
		)
			throw new Error('Channel response belongs to another Pal conversation or profile.')
		signal.throwIfAborted()
		await verifyIngressRecorded(message, message.receipt, {
			binding,
			definition,
			access: await this.options.host.openConversation(binding, signal),
		})
		signal.throwIfAborted()
		this.assertRecipient(context)
		return { ...message, receipt: message.receipt }
	}
	private async resolve(
		input: InboundDeliveryRef,
		context: PalChannelExecutionContext,
		signal: AbortSignal,
		action?: PalChannelVerifiedAction,
	): Promise<PalChannelResolvedRoute> {
		const message = await this.recorded(input, context, signal)
		if (
			action &&
			(action.externalTenantId !== message.source.externalTenantId ||
				!isDeepStrictEqual(
					nativeTuple({
						...action,
						provider: this.connection.provider,
						connectionId: this.connection.connectionId,
					}),
					nativeTuple(message.source),
				))
		)
			throw new Error('Channel action belongs to another native conversation, channel or thread.')
		const allowed = await this.options.authorize(
			freezeCommunicationValue({
				phase: action ? 'action' : 'reply',
				message: message as PalChannelIntent,
				context,
				actorId: action?.actorId ?? message.source.actorId,
				...(action ? { action } : {}),
			}),
		)
		signal.throwIfAborted()
		if (allowed.allow !== true) throw new Error(`Channel routing refused: ${allowed.reason}`)
		this.assertRecipient(context)
		return freezeCommunicationValue({
			connection: this.connection,
			identity: {
				provider: message.source.provider,
				connectionId: message.source.connectionId,
				externalTenantId: message.source.externalTenantId,
				nativeConversationId: message.source.nativeConversationId,
				nativeChannelId: message.source.nativeChannelId,
				nativeThreadId: message.source.nativeThreadId,
			},
			deliveryRef: {
				namespace: PAL_CHANNEL_NAMESPACE,
				id: message.id,
				digest: message.digest,
			},
			recordedReceipt: message.receipt,
			eventActorId: message.source.actorId,
			currentActorId: action?.actorId ?? message.source.actorId,
			context,
		})
	}
	async replyRoute(
		input: InboundDeliveryRef,
		execution: PalChannelExecutionContext,
		signal: AbortSignal = new AbortController().signal,
	) {
		const context = freezeCommunicationValue(contextSchema.parse(execution))
		const ref = refSchema.parse(input)
		signal.throwIfAborted()
		return this.resolve(ref, context, signal)
	}
	async actionRoute(
		raw: unknown,
		execution: PalChannelExecutionContext,
		signal: AbortSignal = new AbortController().signal,
	) {
		const context = freezeCommunicationValue(contextSchema.parse(execution))
		signal.throwIfAborted()
		const action = freezeCommunicationValue(
			verifiedActionSchema.parse(
				await this.options.verify(structuredClone(raw), this.connection, signal),
			),
		)
		signal.throwIfAborted()
		const route = await this.resolve(action.deliveryRef, context, signal, action)
		return freezeCommunicationValue({ route, action })
	}
	async executeAction(
		raw: unknown,
		execution: PalChannelExecutionContext,
		signal: AbortSignal = new AbortController().signal,
	) {
		if (!this.options.actions)
			throw new Error('Channel action execution is unsupported by this host.')
		const context = await this.actionRoute(raw, execution, signal)
		signal.throwIfAborted()
		this.assertRecipient(context.route.context)
		const result = await this.options.actions.execute(context, signal)
		return freezeCommunicationValue(
			z
				.object({ status: z.enum(['applied', 'rejected']), receiptId: label })
				.strict()
				.parse(result),
		)
	}
}
