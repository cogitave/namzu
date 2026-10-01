import {
	freezeCommunicationValue,
	intentDigest,
	intentSchema,
	label,
	messageId,
	sendRequestSchema,
	sourceSchema,
} from './schema.js'
import { routeId } from './schema.js'
import {
	type PalMessageBrokerOptions,
	type PalMessageSender,
	type PalMessageSenderContext,
	type PalRouteBinding,
	type PalRouteKey,
	sameAddress,
} from './types.js'
import { verifyConversation } from './verify.js'

/** Host-owned identity and current policy; model text never selects its sender. */
export class PalMessageBroker {
	constructor(private readonly options: PalMessageBrokerOptions) {
		if (typeof options.authorize !== 'function')
			throw new Error('Pal communication requires explicit authorization.')
	}
	sender(input: PalMessageSenderContext): PalMessageSender {
		const source = freezeCommunicationValue(sourceSchema.parse(input))
		return {
			send: async (input) => {
				const request = freezeCommunicationValue(sendRequestSchema.parse(input))
				const { pals, store, host } = this.options
				if (!host) throw new Error('Pal sender requires a trusted conversation host.')
				const sender = pals.get(source.address.palId)
				if (!sender || sender.paused) throw new Error('Sender Pal is paused or unavailable.')
				const definition = pals.getRevision(sender.id, source.profileRevision)
				const recipient = request.recipient
				if (recipient.tenantId !== source.address.tenantId)
					throw new Error('Cross-tenant Pal messages are refused.')
				const target = pals.get(recipient.palId)
				if (!target) throw new Error('Recipient Pal is unavailable.')
				const validationKey: PalRouteKey = {
					v: 1,
					kind: 'pal',
					sender: source.address,
					senderConversationId: source.conversationId,
					recipient: source.address,
					dialogKey: 'sender-validation',
				}
				const validation: PalRouteBinding = {
					id: routeId(validationKey),
					key: validationKey,
					sessionId: source.conversationId,
					profileRevision: source.profileRevision,
					revision: 1,
					phase: 'active',
				}
				const signal = new AbortController().signal
				await verifyConversation({
					binding: validation,
					definition,
					access: await host.openConversation(validation, signal),
				})
				let dialogKey = label.parse(request.dialogKey ?? 'default')
				let profileRevision = target.revision
				let conversationId: typeof source.conversationId | undefined
				const replyTo = request.replyTo ?? null
				if (replyTo !== null) {
					const prior = (await store.read(source.address))?.messages.find((m) => m.id === replyTo)
					if (!prior || prior.phase !== 'recorded' || !sameAddress(prior.source.address, recipient))
						throw new Error('Reply does not name an observed, authorized incoming Pal message.')
					const route = await store.route(prior.routeKey)
					if (!route || route.sessionId !== source.conversationId)
						throw new Error('Reply belongs to another conversation.')
					conversationId = prior.source.conversationId
					profileRevision = prior.source.profileRevision
					dialogKey = `reply:${conversationId}`
				}
				const routeKey: PalRouteKey = {
					v: 1,
					kind: 'pal',
					sender: source.address,
					senderConversationId: source.conversationId,
					recipient,
					dialogKey,
				}
				const requestContext = freezeCommunicationValue({
					phase: 'send' as const,
					source,
					recipient,
					routeKey,
					body: request.body,
					replyTo,
				})
				const authorization = await this.options.authorize(requestContext)
				if (!authorization.allow) throw new Error(`Pal send refused: ${authorization.reason}`)
				if (pals.get(sender.id)?.paused) throw new Error('Sender Pal was paused before acceptance.')
				const intent = {
					id: messageId(source, request.operationId),
					operationId: request.operationId,
					source,
					recipient,
					routeKey,
					body: request.body,
					replyTo,
					grant: authorization.grant,
					createdAt: (this.options.now ?? Date.now)(),
				}
				const immutableIntent = freezeCommunicationValue(
					intentSchema.parse({ ...intent, digest: intentDigest(intent) }),
				)
				const accepted = await store.accept(immutableIntent, profileRevision, conversationId)
				const report = (error: unknown) => {
					try {
						void Promise.resolve(this.options.onNotificationError?.(error, accepted)).catch(
							() => undefined,
						)
					} catch {
						/* Acceptance already committed. */
					}
				}
				try {
					void Promise.resolve(host.notify?.(recipient)).catch(report)
				} catch (error) {
					report(error)
				}
				return accepted
			},
		}
	}
}
