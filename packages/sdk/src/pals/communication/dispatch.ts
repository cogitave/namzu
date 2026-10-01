import { createPalInboxSource, reconcilePalDelivery } from './inbound.js'
import {
	type PalAddress,
	type PalDispatchOutcome,
	type PalMessageBrokerOptions,
	authorizationRequest,
	currentRecipient,
} from './types.js'
import { verifyConversation } from './verify.js'

/** Finite opt-in operation; host retains normal query/computer ownership. */
export async function dispatchPalMessagesOnce(
	options: PalMessageBrokerOptions,
	recipient: PalAddress,
	signal: AbortSignal,
): Promise<PalDispatchOutcome> {
	signal.throwIfAborted()
	const host = options.host
	if (!host) return { status: 'blocked', reason: 'No Pal conversation host is configured.' }
	let state = await options.store.read(recipient)
	const unresolved = state?.messages.find((m) => m.phase === 'claimed')
	if (unresolved) {
		const binding = state?.routes.find((r) => r.id === unresolved.routeId)
		if (
			!binding ||
			!(await reconcilePalDelivery({ ...options, binding, host }, unresolved, signal))
		)
			return { status: 'idle', reason: 'unresolved' }
		state = await options.store.read(recipient)
	}
	const message = state?.messages.find((m) => m.phase === 'pending')
	if (!message) return { status: 'idle', reason: 'empty' }
	let binding = state?.routes.find((r) => r.id === message.routeId)
	if (!binding) throw new Error('Pal incoming message has no route binding.')
	const authorization = await options.authorize(authorizationRequest(message, 'wake'))
	if (!authorization.allow) return { status: 'blocked', reason: authorization.reason }
	currentRecipient(options.pals, binding)
	signal.throwIfAborted()
	await host.ensureConversation(binding, signal)
	const definition = currentRecipient(options.pals, binding)
	const access = await host.openConversation(binding, signal)
	await verifyConversation({ binding, access, definition })
	if (binding.phase === 'reserved')
		binding = await options.store.activate(binding, { binding, access, definition })
	const currentAuthorization = await options.authorize(authorizationRequest(message, 'wake'))
	if (!currentAuthorization.allow) return { status: 'blocked', reason: currentAuthorization.reason }
	currentRecipient(options.pals, binding)
	signal.throwIfAborted()
	await host.runConversation(binding, createPalInboxSource({ ...options, binding, host }), signal)
	return { status: 'ran', binding }
}
